// GET /api/growth/locations/map — the Locations page's Map tab. READ ONLY, Supabase only.
// Growth's own gate, like every /api/growth route; moved from /api/matchops with the page.
//
// HARD RULE (Ryan, 2026-10-08): no MatchDay call on page load and no new or longer sync — the API
// dyno has a 512 MB quota and went down today. Field coordinates come from mdapi_matches.raw.field,
// which the existing match sync already stores; cities from the latest player-areas run; players
// from player_area_seen. Aggregation is src/lib/locationsMap.ts.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { buildLocationsMap, type MapPlayerRow } from "@/lib/locationsMap";
import { fetchFieldSnapshots, fetchLatestCities } from "@/lib/locationsData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  try {
    const [players, fieldSnapshots, latest] = await Promise.all([
      selectAll<MapPlayerRow>(() => sb.from("player_area_seen")
        .select("zip,area_label,state,lat,lng,verdict,verdict_city_id")
        .eq("has_area", true).eq("is_internal", false)
        .order("player_id")),
      fetchFieldSnapshots(sb),
      fetchLatestCities(sb),
    ]);
    const map = buildLocationsMap({ players, cities: latest.cities, fieldSnapshots });
    return Response.json({ ...map, citiesAsOf: latest.asOf }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
