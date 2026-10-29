// THE LOCATIONS PAGE'S OVERVIEW AND "WHERE TO OPEN NEXT" READS — SERVER-ONLY, Supabase only, never
// MatchDay. One body for two pages:
//
//   /api/growth/locations[/open-next]          unscoped — the US page, exactly as before
//   /api/matchops/market-locations[/open-next] scoped (locationScopes.ts) — the Poland tab
//
// A SCOPE FILTERS IN THE QUERIES, not after: player rows by area label (ilike), matches by
// city_identifier, cities to the scope's own. The scoped payload therefore never carries another
// market's player, field or city. Staff and synthetic accounts are removed the same way on both:
// player_area_seen.is_internal (the sync's @matchday.com / @playmatchday.com rule) and, for the
// active and total counts, isSettledPlayRow (no fake players, PAID or FREE) plus the same staff-email ids.
//
// Moved here from the two growth route files on 2026-10-23 so the Poland tab reuses the code rather
// than forking it; the unscoped path is the same statements in the same order.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { buildLocationsReport, type LocationsReport, type SeenRow } from "./locationsReport";
import { activePlayerIds, isSettledPlayRow, type SettledPlayRowLike } from "./playerActivity";
import { activeFields } from "./locationsMap";
import { fetchFieldSnapshots, fetchLatestCities, fetchVenueLinks } from "./locationsData";
import { groupIntoUnits } from "./venueUnits";
import { placeName, type AreaCity } from "./playerAreaModel";
import { effectiveVerdict, openNextForCity, placesWithNearestField, MIN_PLAYERS_FOR_SUGGESTIONS, type CityOpenNext, type Verdict } from "./locationsInsights";
import { areaLabelPattern, perMile, type LocationScope } from "./locationScopes";

const scopedRows = <Q extends { ilike: (c: string, p: string) => Q }>(q: Q, scope: LocationScope | null | undefined) =>
  (scope ? q.ilike("area_label", areaLabelPattern(scope)) : q);

/* THE SCOPE'S PLAYER COUNT — the denominator "of N" and the never-set line use. The sync's
 * players_total is every MatchDay account, which on the Poland tab would be a US number. A scope's
 * players are: anyone with a settled roster row (PAID or FREE, never WAITING) on a match in its city (any date), plus anyone located
 * in it; staff removed. */
async function scopePlayersTotal(sb: SupabaseClient, scope: LocationScope, located: number[], staff: Set<number> | null): Promise<number> {
  const matches = await selectAll<{ api_id: number }>(() => sb.from("mdapi_matches").select("api_id")
    .eq("city_identifier", scope.cityAbbr).eq("is_cancelled", false).is("deleted_at", null).order("api_id"));
  const ids = new Set<number>(located);
  const mids = matches.map((m) => m.api_id);
  for (let i = 0; i < mids.length; i += 200) {
    const rows = await selectAll<SettledPlayRowLike & { api_id: number; user_id: number | null }>(() => sb.from("mdapi_match_players")
      .select("api_id,user_id,is_cancelled,user_is_fake_player,user_type,paid_status").in("match_api_id", mids.slice(i, i + 200))
      .is("deleted_at", null).order("api_id"));
    for (const r of rows) if (r.user_id != null && isSettledPlayRow(r)) ids.add(r.user_id);
  }
  if (staff) for (const id of staff) ids.delete(id);
  return ids.size;
}

export async function loadLocationsOverview(sb: SupabaseClient, scope?: LocationScope | null): Promise<LocationsReport> {
  // ACTIVE players (the Users lens's 30-day definition) and the staff ids to remove — @matchday.com
  // and @playmatchday.com, the same rule as the rest of this page, matched on the synced emails.
  // Scoped: active at a match in the scope's city.
  const activeP = activePlayerIds(sb, new Date(), scope?.cityAbbr);
  const snapsP = fetchFieldSnapshots(sb, new Date(), scope);
  const staffP = selectAll<{ id: number }>(() => sb.from("mdapi_users").select("id")
    .or("email.ilike.*@matchday.com,email.ilike.*@playmatchday.com").order("id"));
  const [rows, lastRun, okRun, firstRun, freshRun] = await Promise.all([
    selectAll<SeenRow>(() => scopedRows(sb.from("player_area_seen")
      .select("player_id,first_seen_at,seeded,has_area,zip,lat,lng,area_label,state,area_source,location_source,is_internal,verdict,verdict_city_id,nearest_city_id,nearest_city_mi"), scope)
      .order("player_id")),
    sb.from("player_area_sync_runs").select("started_at,finished_at,ok,error,complete")
      .order("started_at", { ascending: false }).limit(1).maybeSingle(),
    // FULL passes only (migration 0230): an incremental run carries no cities, and its players_total
    // is the handful whose location changed, not everyone.
    sb.from("player_area_sync_runs").select("finished_at,players_total,players_internal,cities")
      .eq("ok", true).eq("kind", "full").order("finished_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("player_area_sync_runs").select("finished_at")
      .eq("ok", true).order("finished_at", { ascending: true }).limit(1).maybeSingle(),
    sb.from("player_area_sync_runs").select("finished_at")
      .eq("ok", true).order("finished_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const r of [lastRun, okRun, firstRun, freshRun]) if (r.error) throw new Error(r.error.message);

  // Names for the recent table only. mdapi_users can lag a brand-new signup by up to an hour;
  // those rows render the player id instead of a name.
  const recentIds = rows.filter((r) => r.has_area && !r.is_internal)
    .sort((a, b) => b.first_seen_at.localeCompare(a.first_seen_at) || b.player_id - a.player_id)
    .slice(0, 100).map((r) => r.player_id);
  const names = new Map<number, string>();
  if (recentIds.length > 0) {
    const users = await selectAll<{ id: number; first_name: string | null; last_name: string | null }>(() =>
      sb.from("mdapi_users").select("id,first_name,last_name").in("id", recentIds).order("id"));
    for (const u of users) {
      const n = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
      if (n) names.set(u.id, n);
    }
  }

  // The active figure must never take the page down: if it fails, the card says so and the rest stands.
  const [activeIds, staff, snaps] = await Promise.all([activeP.catch(() => null), staffP.catch(() => null), snapsP]);
  // Market cities = cities with an active field (the Map's field set); see effectiveVerdict.
  const allCities = (Array.isArray(okRun.data?.cities) ? okRun.data!.cities : []) as AreaCity[];
  const cityList = scope ? allCities.filter((c) => c.abbr === scope.cityAbbr) : allCities;
  const live = activeFields(snaps, cityList).fields;
  const markets = new Set(live.map((f) => f.cityId));
  const staffIds = staff ? new Set(staff.map((u) => u.id)) : null;
  const located = rows.filter((r) => r.has_area && !r.is_internal);
  const k = perMile(scope?.unit);
  const report = buildLocationsReport({
    activeIds, internalIds: staffIds, markets,
    rows, names,
    run: lastRun.data ?? null,
    okRun: okRun.data ? { ...okRun.data, cities: cityList } : null,
    firstRunAt: firstRun.data?.finished_at ?? null,
    freshAt: freshRun.data?.finished_at ?? null,
    now: new Date(),
    ...(scope ? { playersTotal: await scopePlayersTotal(sb, scope, located.map((r) => r.player_id), staffIds).catch(() => null), perMile: k } : {}),
  });
  if (!scope) return report;
  // THE PLACE LIST: by place, against the scope's VENUES (venueUnits.ts), as the map pins them.
  const units = groupIntoUnits(live, await fetchVenueLinks(sb));
  const points = located.filter((r) => r.lat != null && r.lng != null)
    .map((r) => ({ lat: r.lat as number, lng: r.lng as number, label: r.area_label }));
  return { ...report, scope: { name: scope.name, cityName: scope.cityName, unit: scope.unit, places: placesWithNearestField(points, units, k) } };
}

// ── WHERE TO OPEN NEXT ────────────────────────────────────────────────────────────────────────
//
// CACHED until the next sync: the result depends only on the stored player locations (which change
// when a player-areas run finishes), the active field set (which changes with the match sync), the
// reach and the scope. All four are in the key, so a new sync or a field change recomputes and
// nothing older is served. In memory, per server instance — a cold instance simply computes it once.

export const OPEN_NEXT_REACHES = new Set([3, 5, 10, 15]);
export type OpenNextPayload = { reach: number; minPlayers: number; cities: { id: number; name: string }[]; results: CityOpenNext[] };
const cache = new Map<string, OpenNextPayload>();

type OpenNextRow = { zip: string | null; lat: number | null; lng: number | null; area_label: string | null; state: string | null; verdict: Verdict; verdict_city_id: number | null };

export async function loadOpenNext(sb: SupabaseClient, reach: number, scope?: LocationScope | null): Promise<OpenNextPayload & { cached: boolean }> {
  const [latest, snaps, venueLinks] = await Promise.all([fetchLatestCities(sb, scope), fetchFieldSnapshots(sb, new Date(), scope), fetchVenueLinks(sb)]);
  // VENUES, not field records (venueUnits.ts): a suggestion's "nearest field" names the place once.
  const fields = groupIntoUnits(activeFields(snaps, latest.cities).fields, venueLinks);
  // The venue grouping is in the key too, so linking a field to a venue recomputes.
  const fieldsKey = fields.map((f) => `${f.id}:${f.lat},${f.lng}:${f.fields.map((x) => x.id).join("+")}`).sort().join("|");
  const generation = `${scope?.key ?? "all"}|${latest.asOf}|${fieldsKey}`;
  const key = `${generation}|${reach}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const markets = new Set(fields.map((f) => f.cityId));
  const rows = await selectAll<OpenNextRow>(() => scopedRows(sb.from("player_area_seen")
    .select("zip,lat,lng,area_label,state,verdict,verdict_city_id")
    .eq("has_area", true).eq("is_internal", false), scope).order("player_id"));
  const byCity = new Map<number, { lat: number; lng: number; label: string | null; zip: string | null }[]>();
  for (const raw of rows) {
    const r = effectiveVerdict(raw, markets);
    if (r.verdict !== "in_market" || r.verdict_city_id == null || r.lat == null || r.lng == null) continue;
    const list = byCity.get(r.verdict_city_id) ?? [];
    list.push({ lat: r.lat, lng: r.lng, label: placeName(r.area_label, r.state), zip: r.zip });
    byCity.set(r.verdict_city_id, list);
  }
  // Every MARKET city gets a row: suggestions, or "not enough players yet". A city with no field is
  // not a market (its players are New markets material), so it is not in this table.
  const marketCities = latest.cities.filter((c) => markets.has(c.id));
  const k = perMile(scope?.unit);
  const results = marketCities.map((c) => openNextForCity(c.id, byCity.get(c.id) ?? [], fields, reach, k));
  const payload: OpenNextPayload = { reach, minPlayers: MIN_PLAYERS_FOR_SUGGESTIONS, cities: marketCities.map((c) => ({ id: c.id, name: c.name })), results };
  // Keep this generation's other reaches; drop this scope's older generations, which can never be
  // served again. Another scope's entries are left alone.
  const mine = `${scope?.key ?? "all"}|`;
  for (const c of cache.keys()) if (c.startsWith(mine) && !c.startsWith(`${generation}|`)) cache.delete(c);
  cache.set(key, payload);
  return { ...payload, cached: false };
}
