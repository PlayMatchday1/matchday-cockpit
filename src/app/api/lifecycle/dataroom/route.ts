// POST /api/lifecycle/dataroom — Player Data Room (rebuilt 2026-11-09 as a campaign list builder).
// Body.mode:
//   "meta"                       cities, live fields (+ the hidden ones folded into them), pivot months
//   "played"   { filters, sort } the Played list: count, contact gaps, the first rows (phones masked)
//   "never"    { filters, sort } the Never played list, the same shape
//   "playedCsv" / "neverCsv"     every row, as Klaviyo imports it
//   "pivot"    { spec }          one pivot table
// Gated on can_access_lifecycle. Reads only.
//
// THE DATA IS IN POSTGRES (migration 0267). The old route loaded all 173,389 plays into the function
// and grouped them in memory; the first open on a cold instance took 12.9–17.7 s (Vercel logs,
// 2026-11-03 and 2026-11-08) behind a "building…" label. Every list and table is now one SQL call.
//
// THE FIELD LIST is MatchDay's own (GET /cities + GET /admin/fields — two GETs, the Fields page's
// pair, cached ten minutes per instance), because only it knows which fields are hidden.

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { fetchCityDirectory } from "@/lib/cityDirectoryServer";
import { citiesWithFields } from "@/lib/cityDirectory";
import { RATES_FOR_SQL } from "@/lib/revenueTxn";
import {
  assemblePivot, chicagoToday, monthShort, cleanNever, cleanPlayed, contactOf, expandFields, foldHidden, maskPhone, monthAdd,
  monthEnd, neverCsv, periodDays, playedCsv, pivotReady, revenueBlocked, sortRows, sumCells, cityName, isMonth,
  PIVOT_DIMS, SEP, type LiveField, type NeverRow, type PivotCell, type PivotDim, type PivotShow, type PivotSpec,
  type PlayedRow, type SortKey, type VenueLink,
} from "@/lib/dataRoomLists";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const PREVIEW = 20;
const MISSING = "The Data Room's database functions are not installed yet (migration 0267).";
const missingFn = (m: string) => /dataroom_/.test(m) && /does not exist|schema cache|Could not find the function/i.test(m);

type Meta = {
  cities: { code: string; name: string }[];
  fields: LiveField[];
  fold: Record<number, number>;
  venues: { id: number; name: string; fields: number[] }[];
  months: { first: string; last: string };
  fieldsSource: "matchday" | "mirror";
  fieldsNote: string | null;
};
let metaCache: { at: number; meta: Meta } | null = null;
const META_TTL = 10 * 60_000;

async function readMeta(sb: SupabaseClient): Promise<Meta> {
  if (metaCache && Date.now() - metaCache.at < META_TTL) return metaCache.meta;
  const [links, venues, first] = await Promise.all([
    sb.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link, excluded_from_venue"),
    sb.from("fin_venues").select("id, venue_name, city"),
    sb.from("growth_player_profile").select("first_match_month").order("first_match_month", { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (links.error) throw new Error(`fin_venue_fields: ${links.error.message}`);
  if (venues.error) throw new Error(`fin_venues: ${venues.error.message}`);

  let fields: LiveField[] = [], cities: Meta["cities"] = [], fieldsSource: Meta["fieldsSource"] = "matchday", fieldsNote: string | null = null;
  try {
    const dir = citiesWithFields(await fetchCityDirectory("production"));
    cities = dir.filter((c) => c.abbr).map((c) => ({ code: c.abbr!, name: c.display }));
    fields = dir.flatMap((c) => c.fields.map((f) => ({ id: f.id, title: f.title, city: c.abbr })));
  } catch (e) {
    /* MatchDay unreachable: fall back to the fields that had a match in the last 120 days. That list
     * cannot tell a hidden field from a live one, and the panel says so. */
    fieldsSource = "mirror";
    fieldsNote = `MatchDay's field list did not load (${e instanceof Error ? e.message.slice(0, 120) : "error"}), so fields come from recent matches and may include hidden ones.`;
    const since = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const { data } = await sb.from("mdapi_matches").select("field_id, field_title, city_identifier").gte("start_date", since).not("field_id", "is", null).limit(5000);
    const seen = new Map<number, LiveField>();
    for (const r of data ?? []) if (!seen.has(Number(r.field_id))) seen.set(Number(r.field_id), { id: Number(r.field_id), title: String(r.field_title ?? `Field ${r.field_id}`), city: r.city_identifier ?? null });
    fields = [...seen.values()].sort((a, b) => a.title.localeCompare(b.title));
    cities = [...new Set(fields.map((f) => f.city).filter((c): c is string => !!c))].map((code) => ({ code, name: cityName(code) })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const vlinks: VenueLink[] = (links.data ?? []).map((l) => ({ venue: Number(l.fin_venue_id), field: Number(l.mdapi_field_id), title: String(l.field_title_at_link ?? ""), excluded: l.excluded_from_venue === true }));
  const fold = foldHidden(fields, vlinks);
  const byVenue = new Map<number, number[]>();
  for (const l of vlinks) if (!l.excluded) (byVenue.get(l.venue) ?? byVenue.set(l.venue, []).get(l.venue)!).push(l.field);
  const today = chicagoToday();
  const meta: Meta = {
    cities, fields, fold, fieldsSource, fieldsNote,
    venues: (venues.data ?? []).map((v) => ({ id: Number(v.id), name: String(v.venue_name ?? `Venue ${v.id}`), fields: byVenue.get(Number(v.id)) ?? [] })),
    months: { first: String(first.data?.first_match_month ?? "2023-04"), last: today.slice(0, 7) },
  };
  metaCache = { at: Date.now(), meta };
  return meta;
}

async function playedRows(sb: SupabaseClient, raw: unknown, meta: Meta): Promise<PlayedRow[]> {
  const f = cleanPlayed(raw);
  const { from, to } = periodDays(f.period, chicagoToday());
  const { data, error } = await sb.rpc("dataroom_played_list", {
    p_from: from, p_to: to, p_city: f.city,
    p_field_ids: f.fieldIds.length ? expandFields(f.fieldIds, meta.fold) : null,
    p_member: f.type, p_min: f.matches.min, p_max: f.matches.max, p_within: f.within,
  });
  if (error) throw new Error(missingFn(error.message) ? MISSING : error.message);
  return (data ?? []) as PlayedRow[];
}
async function neverRows(sb: SupabaseClient, raw: unknown): Promise<NeverRow[]> {
  const f = cleanNever(raw, chicagoToday());
  /* Chicago month starts as instants. A month boundary is midnight in Chicago, not UTC. */
  const at = (ym: string) => chicagoMidnight(`${ym}-01`);
  const { data, error } = await sb.rpc("dataroom_never_played", { p_from: at(f.from), p_to: at(monthAdd(f.to, 1)), p_city: f.city });
  if (error) throw new Error(missingFn(error.message) ? MISSING : error.message);
  return (data ?? []) as NeverRow[];
}
/** The UTC instant of 00:00 in America/Chicago on a given day (DST-aware). */
function chicagoMidnight(ymd: string): string {
  const guess = Date.parse(`${ymd}T06:00:00Z`);
  const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date(guess));
  const h = Number(local) % 24;
  return new Date(guess - h * 3_600_000).toISOString();
}

function preview<T extends PlayedRow | NeverRow>(rows: T[], sortRaw: unknown) {
  const s = (sortRaw ?? {}) as { key?: string; dir?: string };
  const keys: SortKey[] = ["name", "email", "phone", "city", "matches", "lastPlayed", "signedUp"];
  const key = keys.includes(s.key as SortKey) ? (s.key as SortKey) : null;
  const sorted = key ? sortRows(rows, key, s.dir === "asc" ? "asc" : "desc") : rows;
  let noEmail = 0, noPhone = 0;
  for (const r of rows) { const c = contactOf(r); if (c.noEmail) noEmail++; if (c.noPhone) noPhone++; }
  return {
    count: rows.length, noEmail, noPhone,
    rows: sorted.slice(0, PREVIEW).map((r) => {
      const c = contactOf(r);
      return { ...r, name: c.name, email: c.email, phone: maskPhone(c.phone), noEmail: c.noEmail, noPhone: c.noPhone };
    }),
  };
}

function csvResponse(text: string, name: string) {
  const safe = name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "players";
  return new Response(text, { status: 200, headers: {
    "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${safe}-${chicagoToday()}.csv"`, "Cache-Control": "no-store",
  } });
}

// ── the pivot ───────────────────────────────────────────────────────────────────────────────────
function cleanSpec(x: unknown, meta: Meta): PivotSpec | null {
  const s = (x ?? {}) as Record<string, unknown>;
  const dim = (v: unknown): PivotDim | null => (PIVOT_DIMS.includes(v as PivotDim) ? (v as PivotDim) : null);
  const rows = Array.isArray(s.rows) ? s.rows.map(dim).filter((d): d is PivotDim => !!d).slice(0, 2) : [];
  const col = dim(s.col);
  const show = (["players", "new", "spots", "revenue"] as const).includes(s.show as PivotShow) ? (s.show as PivotShow) : null;
  let from = isMonth(s.from) ? s.from : meta.months.first, to = isMonth(s.to) ? s.to : meta.months.last;
  if (from > to) [from, to] = [to, from];
  const spec: PivotSpec = {
    rows: [...new Set(rows)].filter((d) => d !== col), col, show, from, to,
    city: typeof s.city === "string" && /^[A-Z]{2,5}$/.test(s.city) ? s.city : null,
    fieldId: Number.isInteger(Number(s.fieldId)) && Number(s.fieldId) > 0 ? Number(s.fieldId) : null,
  };
  return pivotReady(spec) ? spec : null;
}

async function pivotTable(sb: SupabaseClient, spec: PivotSpec, meta: Meta) {
  const fieldTitle = new Map(meta.fields.map((f) => [String(f.id), f.title]));
  const venueName = new Map(meta.venues.map((v) => [String(v.id), v.name]));
  let cells: PivotCell[];
  if (spec.show === "revenue") {
    const blocked = revenueBlocked(spec);
    if (blocked) return { blocked };
    /* FINANCE NET, the Finance > Revenue definition (fin_txn_sums: gross − refunds − failed − disputes −
     * per-charge sales tax, test and internal rows out). Month × venue is its grain. */
    const venueOfField = spec.fieldId != null
      ? meta.venues.find((v) => v.fields.includes(spec.fieldId!))?.id ?? -1 : null;
    const { data, error } = await sb.rpc("fin_txn_sums", {
      p_from: `${spec.from}-01`, p_to: monthEnd(spec.to), p_grain: "month", p_by_venue: true, p_venue_id: venueOfField, ...RATES_FOR_SQL,
    });
    if (error) throw new Error(`fin_txn_sums: ${error.message}`);
    const MONEY = new Set(["charge", "refund", "failed", "dispute", "manual"]);
    const cityLabel = spec.city ? cityName(spec.city) : null;
    const items: { r1: string; r2: string; c: string; v: number }[] = [];
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      if (r.excluded === true || !MONEY.has(String(r.kind))) continue;
      const city = r.city == null || String(r.city).trim() === "" ? "Deleted Account Revenue" : String(r.city);
      if (cityLabel && city !== cityLabel) continue;
      const month = String(r.period).slice(0, 7);
      const venue = r.fin_venue_id == null ? "none" : String(r.fin_venue_id);
      const dv = (d: PivotDim | null | undefined) => (d === "City" ? city : d === "Field" ? venue : d === "Month" ? month : d === "Year" ? month.slice(0, 4) : "");
      items.push({ r1: dv(spec.rows[0]), r2: dv(spec.rows[1]), c: dv(spec.col), v: (Number(r.gross_cents) - Number(r.tax_cents ?? 0)) / 100 });
    }
    cells = sumCells(items);
  } else {
    const { data, error } = await sb.rpc("dataroom_pivot", {
      p_from: `${spec.from}-01`, p_to: monthEnd(spec.to), p_city: spec.city,
      p_field_ids: spec.fieldId != null ? expandFields([spec.fieldId], meta.fold) : null,
      p_field_map: meta.fold, p_r1: spec.rows[0] ?? null, p_r2: spec.rows[1] ?? null, p_c: spec.col,
    });
    if (error) throw new Error(missingFn(error.message) ? MISSING : error.message);
    const k = spec.show === "spots" ? "spots" : spec.show === "new" ? "new" : "players";
    cells = ((data ?? []) as Record<string, unknown>[]).map((r) => ({ r1: String(r.r1 ?? ""), r2: String(r.r2 ?? ""), c: String(r.c ?? ""), g: Number(r.g), v: Number(r[k] ?? 0) }));
  }
  /* LABELS. Field keys are ids (a live field, or a hidden one with no live sibling); revenue's Field
   * keys are fin_venues ids. Unknown field ids take their latest title from the mirror. */
  const unknown = spec.show !== "revenue" && [...spec.rows, spec.col].includes("Field")
    ? [...new Set(cells.flatMap((c) => [c.r1, c.r2, c.c]).filter((v) => /^\d+$/.test(v) && !fieldTitle.has(v)))] : [];
  if (unknown.length) {
    const { data } = await sb.from("mdapi_matches").select("field_id, field_title").in("field_id", unknown.slice(0, 300).map(Number)).order("start_date", { ascending: false }).limit(3000);
    for (const r of data ?? []) if (!fieldTitle.has(String(r.field_id))) fieldTitle.set(String(r.field_id), `${r.field_title ?? `Field ${r.field_id}`} (hidden)`);
  }
  const label = (d: PivotDim | null | undefined, v: string): string => {
    if (!d) return v;
    if (d === "City") return spec.show === "revenue" ? v : cityName(v) || v;
    if (d === "Field") return spec.show === "revenue" ? (v === "none" ? "No venue (membership, other)" : venueName.get(v) ?? `Venue ${v}`) : fieldTitle.get(v) ?? (v === "?" ? "No field" : `Field ${v}`);
    if ((d === "Month" || d === "Cohort month") && isMonth(v)) return monthShort(v);   // "May 2026", not "2026-05"
    return v;
  };
  const table = assemblePivot(cells, spec, spec.show === "spots" || spec.show === "revenue", label);
  const labels: Record<string, string> = {};
  for (const rk of table.rowKeys) { const [a, b] = rk.split(SEP); labels[rk] = [label(spec.rows[0], a), spec.rows[1] ? label(spec.rows[1], b) : ""].filter(Boolean).join(" · "); }
  const colLabels: Record<string, string> = {};
  for (const c of table.colKeys) colLabels[c] = label(spec.col, c);
  return { table, labels, colLabels };
}

export async function POST(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const body = (await req.json().catch(() => ({}))) as { mode?: string; filters?: unknown; sort?: unknown; spec?: unknown; name?: string };
  const sb = auth.supabase;
  const t0 = Date.now();
  try {
    const meta = await readMeta(sb);
    switch (body.mode) {
      case "meta":
        return Response.json({ ...meta, today: chicagoToday() }, { headers: { "Cache-Control": "no-store" } });
      case "played":
        return Response.json({ ...preview(await playedRows(sb, body.filters, meta), body.sort), ms: Date.now() - t0 }, { headers: { "Cache-Control": "no-store" } });
      case "never":
        return Response.json({ ...preview(await neverRows(sb, body.filters), body.sort), ms: Date.now() - t0 }, { headers: { "Cache-Control": "no-store" } });
      case "playedCsv":
        return csvResponse(playedCsv(await playedRows(sb, body.filters, meta)), body.name ?? "played");
      case "neverCsv":
        return csvResponse(neverCsv(await neverRows(sb, body.filters), chicagoToday()), body.name ?? "never-played");
      case "pivot": {
        const spec = cleanSpec(body.spec, meta);
        if (!spec) return Response.json({ empty: true });
        return Response.json({ ...(await pivotTable(sb, spec, meta)), spec, ms: Date.now() - t0 }, { headers: { "Cache-Control": "no-store" } });
      }
      default:
        return Response.json({ error: "Unknown mode." }, { status: 400 });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/lifecycle/dataroom] failed", msg);
    return Response.json({ error: msg.slice(0, 300) }, { status: msg === MISSING ? 503 : 500 });
  }
}
