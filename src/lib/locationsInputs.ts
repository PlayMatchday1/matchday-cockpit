// THE MAP'S INPUTS, read once — SERVER-ONLY, Supabase only, never MatchDay. Shared by
// /api/growth/locations/map (the bubbles) and /api/growth/locations/players (the admin-only table
// under the map), so a bubble and its player list are built from the same rows.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAllParallel } from "./supabasePagination";
import { activeFields, type MapPlayerRow } from "./locationsMap";
import { fetchFieldSnapshots, fetchLatestCities, fetchVenueLinks } from "./locationsData";
import { fetchPlayHistory } from "./playHistory";
import { fetchPlayStatsRaw, historyFromStats } from "./playStats";
import { milesBetween } from "./playerAreaModel";
import { areaLabelPattern, type LocationScope } from "./locationScopes";

/* A SCOPE (locationScopes.ts) filters IN THE QUERIES: players by area label, fields by the match's
 * city, cities to the scope's own. Play history is then cut to that city's fields, so a scoped
 * payload names no field outside the market. */
export async function loadLocationsInputs(sb: SupabaseClient, scope?: LocationScope | null) {
  const now = new Date();
  // Pages fetched together, not one after another (selectAllParallel: read-only use, stable order).
  const placed = (cols: string, head = false) => {
    const q = sb.from("player_area_seen").select(cols, head ? { count: "exact", head: true } : undefined)
      .eq("has_area", true).eq("is_internal", false);
    return scope ? q.ilike("area_label", areaLabelPattern(scope)) : q;
  };
  const [players, fieldSnapshots, latest, venueLinks, stats] = await Promise.all([
    selectAllParallel<MapPlayerRow>(
      () => placed("player_id,zip,area_label,state,lat,lng,verdict,verdict_city_id,location_source").order("player_id") as never,
      () => placed("player_id", true) as never),
    fetchFieldSnapshots(sb, now, scope),
    fetchLatestCities(sb, scope),
    fetchVenueLinks(sb),
    fetchPlayStatsRaw(sb),
  ]);
  const { fields: live } = activeFields(fieldSnapshots, latest.cities);
  const ids = players.map((p) => p.player_id!).filter((x) => x != null);
  const activeIds = new Set(live.map((f) => f.id));
  /* PLAY HISTORY from the hourly precompute (playStats.ts, migration 0233); read live only when it is
   * not there yet. playsAsOf says which: the refresh instant, or now for a live read. */
  const stored = stats ? historyFromStats(stats, ids, activeIds) : null;
  const history = stored ?? await fetchPlayHistory(sb, ids, activeIds, now);
  const playsAsOf = stored?.asOf ?? now.toISOString();
  if (scope) {
    const inScope = new Set(latest.cities.map((c) => c.id));
    for (const [id, f] of history.fields) if (f.cityId == null || !inScope.has(f.cityId)) history.fields.delete(id);
    for (const [pid, plays] of history.playsByPlayer) history.playsByPlayer.set(pid, plays.filter((p) => history.fields.has(p.fieldId)));
  }
  /* A played field's stored position is held to the same rule as the map's: farther from its own
   * city's centre than that city's radius (1849 Wheatley Heights once sat in China) is no position. */
  for (const f of history.fields.values()) {
    const c = f.cityId != null ? latest.cities.find((x) => x.id === f.cityId) : undefined;
    if (c && f.lat != null && f.lng != null && milesBetween(f.lat, f.lng, c.lat, c.lng) > c.radiusMiles) { f.lat = null; f.lng = null; }
  }
  return { players, cities: latest.cities, citiesAsOf: latest.asOf, fieldSnapshots, history, venueLinks, now, playsAsOf, playsStored: stored != null };
}
