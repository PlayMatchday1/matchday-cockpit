// GET  /api/growth/competitors — every capture, its facilities, its match log, and OUR OWN supply
//                                over the same windows.
// POST /api/growth/competitors — import one capture file. Admin gated.
//
// ══ OUR SIDE IS DERIVED, NEVER STORED ════════════════════════════════════════════════════════
// Our spots come from mdapi_matches over the capture's own window, as sum(max_player_count), and
// our price per player from the same rows' registration_price. Storing either would let the share
// on this page go stale against the schedule it claims to describe.
//
// AND IT IS SPOTS OVER 18, NOT A MATCH COUNT. A standard 18-cap match scores exactly 1; the Soccer
// Central two-pitch matches (capacity 36, both pitches occupied) score 2, which is what they are.
// A raw match count gets those wrong in the one city where it matters.
//
// Reads mdapi_matches read-only. Reaches the MatchDay API nowhere. Touches no cost path.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import {
  MD_STANDARD_SPOTS, PROPOSE_AT, parseCapture, proposeLink, sortFormats,
  type NameCandidate, type ParsedRow,
} from "@/lib/competitorSupply";

export const runtime = "nodejs";
export const maxDuration = 60;

const CAPTURES = "competitor_captures";
const SUPPLY = "competitor_facility_supply";
const MATCHES = "competitor_matches";

/** What the capture calls a city, against what fin_venues calls it. */
const CITY_LABEL_TO_OURS: Record<string, string> = {
  Houston: "Houston",
  "Dallas / Fort Worth": "Dallas",
};

type CaptureRow = {
  id: number; source: string; city_label: string; city_identifier: string | null;
  window_start: string; window_end: string; window_note: string | null;
  captured_at: string; captured_by: string;
};

async function selectAll<T>(sb: SupabaseClient, table: string, sel: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(table).select(sel).range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

/**
 * OUR OWN SUPPLY for one window, per venue, from the mirror.
 *
 * Alive matches only, soft-deleted phantoms excluded, the same two filters every cost path uses.
 * start_date is a WALL CLOCK wearing a Z; the window is a pair of calendar dates, so both sides are
 * compared as text and no Date is constructed from a mirror timestamp.
 */
async function ourSupplyForWindow(
  sb: SupabaseClient, startIso: string, endIso: string,
  venueFields: Map<number, number>,
  venues: { id: number; venue_name: string; city: string }[],
): Promise<Map<number, { spots: number; matches: number; priceFloorCents: number | null }>> {
  const rows = await (async () => {
    const out: Record<string, unknown>[] = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.from("mdapi_matches")
        .select("api_id, field_id, max_player_count, registration_price")
        .eq("is_cancelled", false).is("deleted_at", null)
        .gte("start_date", `${startIso}T00:00:00Z`).lte("start_date", `${endIso}T23:59:59Z`)
        .range(off, off + 999);
      if (error) throw new Error(`mdapi_matches: ${error.message}`);
      out.push(...(data ?? []));
      if ((data ?? []).length < 1000) break;
    }
    return out;
  })();

  const byVenue = new Map<number, { spots: number; matches: number; priceFloorCents: number | null }>();
  const known = new Set(venues.map((v) => v.id));
  for (const r of rows) {
    const fid = r.field_id == null ? null : Number(r.field_id);
    const vid = fid == null ? null : venueFields.get(fid);
    if (vid == null || !known.has(vid)) continue;
    const cur = byVenue.get(vid) ?? { spots: 0, matches: 0, priceFloorCents: null };
    cur.spots += Number(r.max_player_count) || 0;
    cur.matches += 1;
    const p = r.registration_price == null ? null : Number(r.registration_price);
    /* THE FLOOR, NOT THE AVERAGE. "Do they undercut us" is a question about the cheapest thing a
     * player can buy from us, which is what a competitor's own floor is compared against. A zero
     * is a free match, not a missing price, so it counts. */
    if (p != null && Number.isFinite(p) && (cur.priceFloorCents == null || p < cur.priceFloorCents)) {
      cur.priceFloorCents = p;
    }
    byVenue.set(vid, cur);
  }
  return byVenue;
}

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    const venues = await selectAll<{ id: number; venue_name: string; city: string }>(
      sb, "fin_venues", "id, venue_name, city");
    const links = await selectAll<{ mdapi_field_id: number; fin_venue_id: number }>(
      sb, "fin_venue_fields", "mdapi_field_id, fin_venue_id");
    const venueFields = new Map<number, number>();
    for (const l of links) if (l.mdapi_field_id != null) venueFields.set(Number(l.mdapi_field_id), Number(l.fin_venue_id));

    let captures: CaptureRow[] = [];
    let supply: Record<string, unknown>[] = [];
    let matches: Record<string, unknown>[] = [];
    let tableReady = true;
    try {
      captures = await selectAll<CaptureRow>(sb, CAPTURES, "*");
      supply = await selectAll<Record<string, unknown>>(sb, SUPPLY, "*");
      matches = await selectAll<Record<string, unknown>>(sb, MATCHES, "*");
    } catch {
      /* THE TABLES MAY NOT EXIST YET. Code deploys before a migration applies; degrade to "no
       * captures", which the page renders as "nothing has been captured", and say so. */
      tableReady = false;
    }

    /* OUR SUPPLY, ONCE PER DISTINCT WINDOW. Two sources in one city can be two different weeks and
     * in this capture they are, so our side is fetched per window rather than per city. */
    const windows = [...new Set(captures.map((c) => `${c.window_start}|${c.window_end}`))];
    const ours: Record<string, Record<number, { spots: number; matches: number; priceFloorCents: number | null }>> = {};
    for (const w of windows) {
      const [s, e] = w.split("|");
      const m = await ourSupplyForWindow(sb, s, e, venueFields, venues);
      ours[w] = Object.fromEntries(m);
    }

    /* ── THE PROPOSALS ────────────────────────────────────────────────────────────────────────
     * THEY ARE BOOKING OUR FIELDS, and that is the most actionable thing in the capture. But
     * our_venue_id stays NULL until a person accepts: "Athlete Training & Health | Cypress" and
     * "Athlete Training and Health | Katy" differ by one word and are different places, one of
     * which is ours. So the page flags the PROPOSAL, distinct from a confirmed link, and shows the
     * evidence beside it. Nothing here writes. */
    const titlesByVenue = new Map<number, Set<string>>();
    if (tableReady) {
      const { data: titleRows } = await sb.from("mdapi_matches")
        .select("field_id, field_title")
        .gte("start_date", "2026-01-01T00:00:00Z").lte("start_date", "2026-12-31T23:59:59Z")
        .limit(20000);
      for (const t of titleRows ?? []) {
        const vid = venueFields.get(Number(t.field_id));
        if (!vid) continue;
        if (!titlesByVenue.has(vid)) titlesByVenue.set(vid, new Set());
        titlesByVenue.get(vid)!.add(String(t.field_title ?? ""));
      }
    }
    const capById = new Map(captures.map((c) => [c.id, c]));
    const proposals = supply.map((s) => {
      const cap = capById.get(Number(s.capture_id));
      const ourCity = cap ? CITY_LABEL_TO_OURS[cap.city_label] : null;
      const cands: NameCandidate[] = [];
      for (const v of venues) {
        if (v.city !== ourCity) continue;
        for (const via of [v.venue_name, ...(titlesByVenue.get(v.id) ?? [])])
          cands.push({ venueId: v.id, venueName: v.venue_name, via });
      }
      const p = proposeLink(String(s.facility), cands);
      return { supplyId: Number(s.id), ...p };
    }).filter((p) => p.venueId != null);

    /* THE CITIES WE OPERATE IN. Coverage is stated before any row: a city missing from this page
     * has not been LOOKED AT, which is not the same as a competitor being absent there. */
    const ourCities = [...new Set(venues.map((v) => v.city).filter(Boolean))].sort();
    const capturedOurCities = [...new Set(captures.map((c) => CITY_LABEL_TO_OURS[c.city_label]).filter(Boolean))];

    return Response.json({
      tableReady,
      captures,
      supply: supply.map((s) => ({ ...s, formats: sortFormats((s.formats as string[]) ?? []) })),
      matches,
      venues,
      ours,
      proposals,
      proposeAt: PROPOSE_AT,
      ourCities,
      capturedOurCities,
      cityLabelToOurs: CITY_LABEL_TO_OURS,
      mdStandardSpots: MD_STANDARD_SPOTS,
    }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[api/growth/competitors] GET failed", e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/* ── THE IMPORTER ─────────────────────────────────────────────────────────────────────────────
 * Ryan captures per region, by hand, through an emulator with mocked GPS, and Plei is in about 38
 * regions. This will happen many times, so the file shape is fixed and the parser is strict.
 *
 * REJECT THE WHOLE FILE ON ANY BAD ROW. A partial import of a competitor capture is worse than no
 * import, because the totals will look plausible. */
export async function POST(req: Request) {
  /* ADMIN GATED. Reading the page needs Growth; writing a capture that every share number on it is
   * computed from is a narrower thing. */
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) {
    return Response.json({ error: "Importing a capture is admin only." }, { status: 403 });
  }

  let body: { csv?: string; dryRun?: boolean; acceptLink?: { supplyId?: number; venueId?: number | null } };
  try { body = (await req.json()) as typeof body; }
  catch { return Response.json({ outcome: "FAILED", error: "Body is not JSON. Nothing was written." }, { status: 400 }); }

  /* ── ACCEPTING A PROPOSED LINK. The ONLY thing that ever sets our_venue_id, and it is a person
   * pressing a button on a proposal they have read. venueId null clears a link that was wrong. */
  if (body.acceptLink) {
    const supplyId = Number(body.acceptLink.supplyId);
    const venueId = body.acceptLink.venueId == null ? null : Number(body.acceptLink.venueId);
    if (!Number.isInteger(supplyId) || supplyId <= 0) {
      return Response.json({ outcome: "FAILED", error: "supplyId is required." }, { status: 400 });
    }
    const { data: before } = await auth.supabase.from(SUPPLY).select("*").eq("id", supplyId).maybeSingle();
    if (!before) return Response.json({ outcome: "NOT APPLIED", error: "That facility row no longer exists." }, { status: 409 });
    const { data: after, error } = await auth.supabase.from(SUPPLY)
      .update({ our_venue_id: venueId }).eq("id", supplyId).select("*").maybeSingle();
    if (error) return Response.json({ outcome: "FAILED", error: error.message }, { status: 500 });
    if (!after || (after.our_venue_id ?? null) !== venueId) {
      return Response.json({ outcome: "NOT APPLIED", error: "The link read back different. Nothing was retried." }, { status: 409 });
    }
    const audit = await recordWrite(
      {
        env: "production", source: "Growth — competitor capture", actorName: auth.email, actorEmail: auth.email,
        saveId: randomUUID(), matchId: null, matchName: null,
        method: "POST", path: `/growth/competitors/link/${supplyId}`,
        body: { supplyId, venueId }, keys: [], label: (k) => k, applied: () => true,
        changes: [{
          key: "our_venue_id", field: `Shared field link for "${before.facility}"`,
          before: before.our_venue_id ?? "—", after: venueId ?? "— (cleared)",
        }],
      },
      { readResource: async () => ({}), write: async () => ({ ok: true }), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    return Response.json({ outcome: "LANDED", supplyId, venueId, logRecorded: audit.logged }, { status: 200 });
  }

  const { rows, errors } = parseCapture(String(body.csv ?? ""));
  if (errors.length) {
    return Response.json({
      outcome: "FAILED",
      error: `The file was rejected and nothing was written. ${errors.length} problem${errors.length > 1 ? "s" : ""}:`,
      problems: errors.slice(0, 20),
    }, { status: 400 });
  }

  const sb = auth.supabase;
  // Group into captures. A file may carry several (source, city, window) triples.
  const groups = new Map<string, ParsedRow[]>();
  for (const r of rows) {
    const k = `${r.source}|${r.city_label}|${r.window_start}|${r.window_end}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  try {
    const { data: existing } = await sb.from(CAPTURES).select("*");
    const plan = [...groups.entries()].map(([k, rs]) => {
      const [source, city_label, window_start, window_end] = k.split("|");
      const prior = (existing ?? []).find((e) =>
        e.source === source && e.city_label === city_label &&
        e.window_start === window_start && e.window_end === window_end) ?? null;
      return {
        source, city_label, window_start, window_end,
        facilities: rs.length,
        spots: rs.reduce((a, b) => a + b.bookable_spots_per_week, 0),
        replaces: prior ? prior.id : null,
      };
    });

    /* SHOW WHAT WILL CHANGE BEFORE IT IS WRITTEN. */
    if (body.dryRun) return Response.json({ outcome: "DRY RUN", plan }, { status: 200 });

    const written: { capture: string; facilities: number; spots: number; replaced: boolean }[] = [];
    for (const [k, rs] of groups) {
      const [source, city_label, window_start, window_end] = k.split("|");
      const note = rs.find((r) => r.window_note)?.window_note ?? null;
      const prior = (existing ?? []).find((e) =>
        e.source === source && e.city_label === city_label &&
        e.window_start === window_start && e.window_end === window_end) ?? null;

      /* RE-IMPORTING THE SAME WINDOW REPLACES ITS ROWS rather than adding a second capture. The
       * facility rows cascade off the capture, so deleting the capture clears them and their match
       * log in one step. */
      if (prior) {
        const { error } = await sb.from(CAPTURES).delete().eq("id", prior.id);
        if (error) throw new Error(`clearing the previous capture: ${error.message}`);
      }
      const { data: cap, error: capErr } = await sb.from(CAPTURES).insert({
        source, city_label,
        city_identifier: null,
        window_start, window_end, window_note: note,
        captured_by: auth.email ?? "unknown",
      }).select("*").single();
      if (capErr) throw new Error(`creating the capture: ${capErr.message}`);

      const { error: supErr } = await sb.from(SUPPLY).insert(rs.map((r) => ({
        capture_id: cap.id, facility: r.facility,
        matches_per_week: r.matches_per_week,
        bookable_spots_per_week: r.bookable_spots_per_week,
        price_low_cents: r.price_low_cents, price_high_cents: r.price_high_cents,
        formats: r.formats,
        our_venue_id: null, // NEVER AUTO-LINKED. The page proposes; a person accepts.
      })));
      if (supErr) throw new Error(`writing facilities: ${supErr.message}`);

      written.push({
        capture: `${source} ${city_label} ${window_start}..${window_end}`,
        facilities: rs.length,
        spots: rs.reduce((a, b) => a + b.bookable_spots_per_week, 0),
        replaced: !!prior,
      });
    }

    const audit = await recordWrite(
      {
        env: "production", source: "Growth — competitor capture", actorName: auth.email, actorEmail: auth.email,
        saveId: randomUUID(), matchId: null, matchName: null,
        method: "POST", path: "/growth/competitors/import",
        body: { captures: written.length, rows: rows.length },
        keys: [], label: (k) => k,
        applied: () => true,
        changes: written.map((w, i) => ({
          key: `capture-${i}`, field: w.replaced ? "Capture replaced" : "Capture imported",
          before: w.replaced ? "(previous rows for this window)" : "—",
          after: `${w.capture} · ${w.facilities} facilities · ${w.spots} spots`,
        })),
      },
      { readResource: async () => ({}), write: async () => ({ ok: true }), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );

    return Response.json({ outcome: "LANDED", written, logRecorded: audit.logged }, { status: 200 });
  } catch (e) {
    console.error("[api/growth/competitors] POST failed", e);
    return Response.json({ outcome: "FAILED", error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
