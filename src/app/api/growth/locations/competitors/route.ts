// GET   /api/growth/locations/competitors — the competitor venues for the Locations map: where each
//                                           place is (competitor_venues, migration 0220) and what it
//                                           sells (the Competitors page's capture rows).
// PATCH /api/growth/locations/competitors — an admin corrects a venue's address or moves its pin.
//
// Supabase only, never MatchDay, and NO ADDRESS LOOKUP: an address edit changes the text, a pin drag
// changes the coordinates, and neither is derived from the other.
//
// ══ WHAT IS LEFT OFF THE MAP, AND WHY (Ryan, 2026-10-09) ═════════════════════════════════════
//   • a venue with no coordinates (the CSV could not place it) — with the CSV's own note
//   • a SHARED venue (a listing the Competitors page marks ALSO OUR FIELD or LOOKS LIKE OURS) is not a
//     competitor square: it is returned under `shared` and drawn at OUR field with its own mark
//     (sharedVenues, competitorProposals.ts). Only one whose venue has no linked field stays off.
//   • a captured facility with no row in the address file
// Every one is returned under `offMap` with its reason, so the page can say what it did not draw.

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateCapability } from "@/lib/capabilityAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { STATE_LABEL } from "@/lib/changeLogModel";
import { competitorProposals, sharedVenues } from "@/lib/competitorProposals";
import { sortFormats } from "@/lib/competitorSupply";
import type { CompetitorListing, CompetitorOffMap, CompetitorVenue, SharedVenue } from "@/lib/competitorVenues";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/* PARTNER BRAND (Ryan, 2026-10-09): Hattrick is a field partner of ours, and two Hattrick facilities
 * list on Plei — The HatTrick Oakridge and The HatTrick Patio. Both are COMPETITOR venues (ruled
 * "same owner, different facility" on 2026-09-16; the Patio is 568 m from our Hattrick T., at a
 * different address), shown like any other, and tagged so nobody reads them as strangers. Matched on
 * the venue or listing name, so a third Hattrick listing is tagged too. */
const PARTNER_BRANDS: { brand: string; match: RegExp }[] = [{ brand: "Hattrick", match: /hat\s*-?\s*trick/i }];
const partnerBrandOf = (names: string[]) => PARTNER_BRANDS.find((b) => names.some((n) => b.match.test(n)))?.brand ?? null;

type VenueRow = {
  id: number; market: string; name: string; street_address: string | null; city: string | null; state: string | null; zip: string | null;
  lat: number | null; lng: number | null; confidence: string | null; updated_at: string | null; updated_by: string | null;
};
type ListingRow = { id: number; venue_id: number; source: "plei" | "goodrec"; city_label: string; facility: string; source_url: string | null; confidence: string | null; notes: string | null };

async function all<T>(sb: SupabaseClient, table: string, sel: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await sb.from(table).select(sel).order("id").range(off, off + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  /* THE TABLES MAY NOT EXIST YET. Code can deploy before migration 0220 applies; the page then shows
   * the checkbox disabled and says why, rather than an empty map that reads as "no competitors". */
  let venues: VenueRow[], listings: ListingRow[];
  try {
    venues = await all<VenueRow>(sb, "competitor_venues", "*");
    listings = await all<ListingRow>(sb, "competitor_venue_listings", "*");
  } catch (e) {
    return Response.json({ ready: false, reason: e instanceof Error ? e.message : String(e), venues: [], offMap: [], shared: [], canEdit: auth.isAdmin }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const captures = await all<{ id: number; source: string; city_label: string; window_start: string; window_end: string; captured_at: string }>(sb, "competitor_captures", "id,source,city_label,window_start,window_end,captured_at");
    const supply = await all<Record<string, unknown>>(sb, "competitor_facility_supply", "*");
    const finVenues = await all<{ id: number; venue_name: string; city: string }>(sb, "fin_venues", "id, venue_name, city");
    const links = await (async () => {
      const out: { mdapi_field_id: number; fin_venue_id: number }[] = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.from("fin_venue_fields").select("mdapi_field_id, fin_venue_id").range(off, off + 999);
        if (error) throw new Error(`fin_venue_fields: ${error.message}`);
        out.push(...((data ?? []) as typeof out));
        if ((data ?? []).length < 1000) break;
      }
      return out;
    })();
    const venueFields = new Map<number, number>();
    for (const l of links) if (l.mdapi_field_id != null) venueFields.set(Number(l.mdapi_field_id), Number(l.fin_venue_id));
    const proposals = await competitorProposals(sb, captures, supply, finVenues, venueFields, true);
    /* SHARED VENUES are drawn at OUR field (a distinct mark), so they leave "Not on the map" — unless
     * our venue has no linked field, when the location is unknown and the list says so. */
    const shared: SharedVenue[] = await sharedVenues(sb, captures, supply, finVenues, venueFields, proposals);
    const sharedBy = new Map(shared.map((x) => [x.supplyId, x]));
    const sharedReason = (x: SharedVenue) => (x.field ? null
      : `Shared with our ${x.ourVenueName}${x.status === "proposed" ? " (proposed match)" : ""}, which has no MatchDay field linked, so its location is unknown`);

    const capById = new Map(captures.map((c) => [c.id, c]));
    const supplyByKey = new Map<string, Record<string, unknown>>();
    for (const s of supply) {
      const c = capById.get(Number(s.capture_id));
      if (c) supplyByKey.set(`${c.source}|${c.city_label}|${s.facility}`, s);
    }
    const key = (l: { source: string; city_label: string; facility: string }) => `${l.source}|${l.city_label}|${l.facility}`;
    const listingsBy = new Map<number, ListingRow[]>();
    for (const l of listings) listingsBy.set(l.venue_id, [...(listingsBy.get(l.venue_id) ?? []), l]);

    const placed: CompetitorVenue[] = [];
    const offMap: CompetitorOffMap[] = [];
    const seen = new Set<string>();
    for (const v of venues) {
      const ls = listingsBy.get(v.id) ?? [];
      for (const l of ls) seen.add(key(l));
      const sources = [...new Set(ls.map((l) => l.source))].sort((a, b) => (a === "plei" ? -1 : b === "plei" ? 1 : 0));
      const off = (reason: string, placeable = false) => offMap.push({ name: v.name, market: v.market, sources, reason,
        ...(placeable ? { venueId: v.id, street: v.street_address, city: v.city, state: v.state, zip: v.zip } : {}) });
      const sup = ls.map((l) => supplyByKey.get(key(l)) ?? null);
      const sh = sup.map((s) => (s ? sharedBy.get(Number(s.id)) : undefined)).find(Boolean);
      if (sh) { const why = sharedReason(sh); if (why) off(why); continue; }
      if (v.lat == null || v.lng == null) {
        // PLACEABLE: an admin can drop its square on the map and save pin and address together.
        off(ls.map((l) => l.notes).filter(Boolean).join(" ") || "No coordinates in the address file", true);
        continue;
      }
      const ll: CompetitorListing[] = ls.map((l, i) => {
        const s = sup[i];
        const c = s ? capById.get(Number(s.capture_id)) : undefined;
        return {
          source: l.source, facility: l.facility, url: l.source_url, confidence: l.confidence, notes: l.notes,
          supplyId: s ? Number(s.id) : null,
          spots: s ? Number(s.bookable_spots_per_week) : null,
          lowCents: s?.price_low_cents == null ? null : Number(s.price_low_cents),
          highCents: s?.price_high_cents == null ? null : Number(s.price_high_cents),
          formats: s ? sortFormats((s.formats as string[]) ?? []) : [],
          window: c ? `${c.window_start}|${c.window_end}` : null,
        };
      });
      const lows = ll.map((l) => l.lowCents).filter((x): x is number => x != null);
      const highs = ll.map((l) => l.highCents ?? l.lowCents).filter((x): x is number => x != null);
      placed.push({
        id: v.id, market: v.market, name: v.name, street: v.street_address, city: v.city, state: v.state, zip: v.zip,
        lat: v.lat, lng: v.lng, confidence: v.confidence, updatedAt: v.updated_at, updatedBy: v.updated_by,
        sources, listings: ll, partnerBrand: partnerBrandOf([v.name, ...ls.map((l) => l.facility)]),
        spots: ll.reduce((a, l) => a + (l.spots ?? 0), 0),
        lowCents: lows.length ? Math.min(...lows) : null, highCents: highs.length ? Math.max(...highs) : null,
        formats: sortFormats(ll.flatMap((l) => l.formats)),
      });
    }
    // A captured facility the address file has no row for.
    for (const [k, s] of supplyByKey) {
      if (seen.has(k)) continue;
      const [source, market] = k.split("|");
      const sh = sharedBy.get(Number(s.id));
      const reason = sh ? sharedReason(sh) : "No row in the address file";
      if (reason) offMap.push({ name: String(s.facility), market, sources: [source], reason });
    }
    offMap.sort((a, b) => a.market.localeCompare(b.market) || a.name.localeCompare(b.name));
    return Response.json({ ready: true, venues: placed, offMap, shared, canEdit: auth.isAdmin }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

/* ── AN ADMIN CORRECTS A VENUE ────────────────────────────────────────────────────────────────
 * The body carries ONLY what changed (the diff is the request). Text fields are trimmed and an empty
 * one clears it; lat and lng travel together. Read before, write, read back, and say LANDED or NOT
 * APPLIED from the read-back — never from the status alone. No retry. Logged to change_log. */
const TEXT = ["street_address", "city", "state", "zip"] as const;
export async function PATCH(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  if (!auth.isAdmin) return Response.json({ outcome: "FAILED", error: "Correcting a competitor venue is admin only." }, { status: 403 });

  let body: { id?: unknown; set?: Record<string, unknown> };
  try { body = await req.json(); } catch { return Response.json({ outcome: "FAILED", error: "Body is not JSON. Nothing was written." }, { status: 400 }); }
  const id = Number(body.id);
  const set = body.set ?? {};
  if (!Number.isInteger(id) || id <= 0) return Response.json({ outcome: "FAILED", error: "id is required. Nothing was written." }, { status: 400 });

  const patch: Record<string, string | number | null> = {};
  for (const k of TEXT) {
    if (!(k in set)) continue;
    const v = set[k];
    if (v != null && typeof v !== "string") return Response.json({ outcome: "FAILED", error: `${k} must be text. Nothing was written.` }, { status: 400 });
    patch[k] = typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 200) : null;
  }
  if ("lat" in set || "lng" in set) {
    const lat = Number(set.lat), lng = Number(set.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return Response.json({ outcome: "FAILED", error: "lat and lng must both be valid coordinates. Nothing was written." }, { status: 400 });
    }
    patch.lat = Math.round(lat * 1e6) / 1e6;
    patch.lng = Math.round(lng * 1e6) / 1e6;
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return Response.json({ outcome: "NOT APPLIED", error: "Nothing changed." }, { status: 400 });

  const sb = auth.supabase;
  const read = async () => {
    const { data, error } = await sb.from("competitor_venues").select("*").eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    return (data ?? {}) as Record<string, unknown>;
  };
  const before = await read().catch(() => ({} as Record<string, unknown>));
  if (before.id == null) return Response.json({ outcome: "NOT APPLIED", error: "That venue no longer exists." }, { status: 409 });

  const now = new Date().toISOString();
  const res = await recordWrite(
    {
      env: "production", source: "Growth — competitor venue", actorName: auth.email, actorEmail: auth.email,
      saveId: randomUUID(), matchId: null, matchName: null,
      method: "PATCH", path: `/growth/locations/competitors/${id}`,
      body: patch, keys, label: (k) => `${String(before.name)} — ${k.replace("_", " ")}`,
      // LANDED only when the row READS BACK as what was sent, every key of it.
      applied: (_b, after) => keys.every((k) => (typeof patch[k] === "number"
        ? Math.abs(Number(after[k]) - (patch[k] as number)) < 1e-9
        : (after[k] ?? null) === patch[k])),
    },
    {
      readResource: read,
      write: async () => {
        const { error } = await sb.from("competitor_venues").update({ ...patch, updated_at: now, updated_by: auth.email }).eq("id", id);
        // A refused update is a FAILED write, not an unknown one: name it so recordWrite says so.
        if (error) throw Object.assign(new Error(error.message), { name: "WriteFailedError" });
      },
      now: () => now,
    },
    supabaseLogStore(),
  );
  const after = await read().catch(() => ({} as Record<string, unknown>));
  return Response.json({ outcome: STATE_LABEL[res.outcome], error: res.error?.message ?? null, venue: after, logRecorded: res.logged },
    { status: res.outcome === "landed" ? 200 : res.error ? 500 : 409 });
}
