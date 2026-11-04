import "server-only";
// THE PUBLIC WEBSITE FEED — the reads. Shaping is in publicSite.ts.
//
// READ ONLY, and bounded. Per rebuild: TWO production API GETs (/cities, /admin/fields — the only
// home of a field's address, coordinates and cover), plus mirror reads. The edge serves the
// result for an hour (see the route), so the production API sees about two GETs an hour, well
// inside the one-request-per-two-seconds rule. No sweep ever touches the API: matches and every
// count come from the mdapi_* mirror.
//
// NOTHING PERSONAL IS SELECTED. growth_player_profile is read for city_counts only (no user_id
// leaves this file; the per-city figure is a count). mdapi_matches is read for schedule columns
// and the team COUNT (raw->teams, of which only the length is used; teams carry a write-only
// `password` key that is never read or emitted).

import { apiGet } from "./matchdayStageApi";
import { makeServerClient } from "./supabaseServer";
import { selectAll, selectAllParallel } from "./supabasePagination";
import type { VenueLink } from "./venueUnits";
import { addDays, buildSitePayload, EXCLUDED_CITY_ABBRS, WINDOW_DAYS, type ApiCityRow, type ApiFieldRow, type CityTotals, type MatchRow, type SitePayload } from "./publicSite";

export async function buildPublicSite(now = new Date()): Promise<SitePayload> {
  const [cities, fields] = await Promise.all([
    apiGet<ApiCityRow[]>("production", "/cities"),
    apiGet<ApiFieldRow[]>("production", "/admin/fields"),
  ]);
  if (!Array.isArray(cities) || cities.length === 0) throw new Error("GET /cities returned no cities");
  if (!Array.isArray(fields) || fields.length === 0) throw new Error("GET /admin/fields returned no fields");
  const sb = makeServerClient();

  // Wall-clock dates compared as wall-clock text: a day of slack each side covers every zone; the
  // builder then applies each city's exact window.
  const utcToday = now.toISOString().slice(0, 10);
  const lo = addDays(utcToday, -WINDOW_DAYS - 1), hi = addDays(utcToday, WINDOW_DAYS + 2);
  type Raw = Omit<MatchRow, "team_count"> & { teams: unknown };
  const raw = await selectAll<Raw>(() => sb.from("mdapi_matches")
    .select("api_id,field_id,city_identifier,start_date,start_date_utc,end_date,registration_price,max_player_count,player_count,teams:raw->teams")
    .is("deleted_at", null).eq("is_cancelled", false)
    .gte("start_date", `${lo}T00:00:00Z`).lt("start_date", `${hi}T00:00:00Z`)
    .order("api_id", { ascending: true }));
  const matches: MatchRow[] = raw.map(({ teams, ...m }) => ({ ...m, team_count: Array.isArray(teams) && teams.length > 0 ? teams.length : null }));

  // Venue links: fin_venue_fields -> fin_venues.venue_name.
  const { data: linkRows, error: le } = await sb.from("fin_venue_fields").select("mdapi_field_id,fin_venue_id,counts_as_regular_play");
  if (le) throw new Error(`fin_venue_fields: ${le.message}`);
  const { data: venueRows, error: ve } = await sb.from("fin_venues").select("id,venue_name,neighborhood");
  if (ve) throw new Error(`fin_venues: ${ve.message}`);
  const venueName = new Map((venueRows ?? []).map((v) => [Number(v.id), String(v.venue_name ?? "").trim()]));
  const links = new Map<number, VenueLink>();
  for (const l of linkRows ?? []) {
    const name = venueName.get(Number(l.fin_venue_id));
    if (l.mdapi_field_id != null && name) links.set(Number(l.mdapi_field_id), { venueId: Number(l.fin_venue_id), venueName: name });
  }

  // Per-city all-time counts. Head counts only; one per city.
  const nowIso = now.toISOString();
  const cityTotals = new Map<string, CityTotals>();
  const abbrs = cities.map((c) => (c.abbr ?? "").trim()).filter(Boolean);
  const profiles = await selectAllParallel<{ city_counts: Record<string, number> | null }>(
    () => sb.from("growth_player_profile").select("city_counts").order("user_id", { ascending: true }),
    () => sb.from("growth_player_profile").select("user_id", { count: "exact", head: true }),
  );
  const playersByCity = new Map<string, number>();
  let playersAllTime = 0;
  for (const p of profiles) {
    const keys = Object.keys(p.city_counts ?? {}).filter((k) => (p.city_counts![k] ?? 0) > 0);
    for (const k of keys) playersByCity.set(k, (playersByCity.get(k) ?? 0) + 1);
    if (keys.some((k) => !EXCLUDED_CITY_ABBRS.has(k))) playersAllTime++;
  }
  for (const a of abbrs) {
    const [held, ever] = await Promise.all([
      sb.from("mdapi_matches").select("api_id", { count: "exact", head: true })
        .eq("city_identifier", a).is("deleted_at", null).eq("is_cancelled", false).lte("start_date_utc", nowIso),
      sb.from("mdapi_matches").select("api_id", { count: "exact", head: true }).eq("city_identifier", a),
    ]);
    if (held.error || held.count == null) throw new Error(`matches_all_time ${a}: ${held.error?.message ?? "no count"}`);
    if (ever.error || ever.count == null) throw new Error(`ever ${a}: ${ever.error?.message ?? "no count"}`);
    cityTotals.set(a, { matchesAllTime: held.count, playersAllTime: playersByCity.get(a) ?? 0, everHadMatch: ever.count > 0 });
  }

  const regularPlayFieldIds = new Set((linkRows ?? []).filter((l) => l.counts_as_regular_play === true && l.mdapi_field_id != null).map((l) => Number(l.mdapi_field_id)));
  const venueNeighborhoods = new Map<number, string>();
  for (const v of venueRows ?? []) { const n = String((v as { neighborhood?: string | null }).neighborhood ?? "").trim(); if (n) venueNeighborhoods.set(Number(v.id), n); }
  return buildSitePayload({ now, cities, fields, matches, links, venueNeighborhoods, regularPlayFieldIds, cityTotals, playersAllTime });
}

/* CORS: the two site origins, exact match on the parsed origin. Anything else gets no ACAO header. */
const SITE_ORIGINS = new Set(["https://playmatchday.com", "https://www.playmatchday.com"]);
export function corsHeaders(req: Request): Record<string, string> {
  const o = req.headers.get("origin");
  const h: Record<string, string> = { Vary: "Origin" };
  if (o && SITE_ORIGINS.has(o)) { h["Access-Control-Allow-Origin"] = o; h["Access-Control-Allow-Methods"] = "GET, OPTIONS"; }
  return h;
}
/* Edge cache: fresh for an hour, then served stale while ONE background rebuild runs. An error is never cached. */
export const EDGE_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
