// GET /api/growth/locations/map — the Locations page's Map tab. READ ONLY, Supabase only.
// Growth's own gate, like every /api/growth route; moved from /api/matchops with the page.
//
// HARD RULE (Ryan, 2026-10-08): no MatchDay call on page load and no new or longer sync — the API
// dyno has a 512 MB quota and went down today. Field coordinates come from mdapi_matches.raw.field,
// which the existing match sync already stores; cities from the latest player-areas run; players
// from player_area_seen. Aggregation is src/lib/locationsMap.ts.
//
// WHERE THEY PLAY (2026-10-08): each bubble also carries its players' plays by field and their
// activity buckets, from mdapi_match_players + mdapi_matches (playHistory.ts). Aggregated per bubble
// on the server — the browser still never receives a player row or a player id.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { activeFields, buildLocationsMap, type MapPlayerRow } from "@/lib/locationsMap";
import { fetchFieldSnapshots, fetchLatestCities } from "@/lib/locationsData";
import { fetchPlayHistory } from "@/lib/playHistory";
import { milesBetween } from "@/lib/playerAreaModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    const [players, fieldSnapshots, latest] = await Promise.all([
      selectAll<MapPlayerRow>(() => sb.from("player_area_seen")
        .select("player_id,zip,area_label,state,lat,lng,verdict,verdict_city_id")
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
    const map = buildLocationsMap({ players, cities: latest.cities, fieldSnapshots, history, now });
    return Response.json({ ...map, citiesAsOf: latest.asOf }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
