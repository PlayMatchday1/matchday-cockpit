// THE MAP'S INPUTS, read once — SERVER-ONLY, Supabase only, never MatchDay. Shared by
// /api/growth/locations/map (the bubbles) and /api/growth/locations/players (the admin-only table
// under the map), so a bubble and its player list are built from the same rows.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { activeFields, type MapPlayerRow } from "./locationsMap";
import { fetchFieldSnapshots, fetchLatestCities } from "./locationsData";
import { fetchPlayHistory } from "./playHistory";
import { milesBetween } from "./playerAreaModel";

export async function loadLocationsInputs(sb: SupabaseClient) {
  const [players, fieldSnapshots, latest] = await Promise.all([
    selectAll<MapPlayerRow>(() => sb.from("player_area_seen")
      .select("player_id,zip,area_label,state,lat,lng,verdict,verdict_city_id,location_source")
      .eq("has_area", true).eq("is_internal", false)
      .order("player_id")),
    fetchFieldSnapshots(sb),
    fetchLatestCities(sb),
  ]);
  const now = new Date();
  const { fields: live } = activeFields(fieldSnapshots, latest.cities);
  const history = await fetchPlayHistory(sb, players.map((p) => p.player_id!).filter((x) => x != null), new Set(live.map((f) => f.id)), now);
  /* A played field's stored position is held to the same rule as the map's: farther from its own
   * city's centre than that city's radius (1849 Wheatley Heights once sat in China) is no position. */
  for (const f of history.fields.values()) {
    const c = f.cityId != null ? latest.cities.find((x) => x.id === f.cityId) : undefined;
    if (c && f.lat != null && f.lng != null && milesBetween(f.lat, f.lng, c.lat, c.lng) > c.radiusMiles) { f.lat = null; f.lng = null; }
  }
  return { players, cities: latest.cities, citiesAsOf: latest.asOf, fieldSnapshots, history, now };
}
