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
import { buildLocationsMap } from "@/lib/locationsMap";
import { loadLocationsInputs } from "@/lib/locationsInputs";
import { cityParam, sliceLocationsMap } from "@/lib/locationsMapSlice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // SERVER-TIMING (2026-10-27): where the request's time went, read in the browser's network panel.
  const t0 = Date.now();
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;
  const t1 = Date.now();

  try {
    const { players, cities, citiesAsOf, fieldSnapshots, history, venueLinks, now, playsAsOf, playsStored } = await loadLocationsInputs(sb);
    const t2 = Date.now();
    const map = buildLocationsMap({ players, cities, fieldSnapshots, history, venueLinks, now });
    // ?city=<id> sends that city's share, no city the All cities share (locationsMapSlice.ts).
    const body = JSON.stringify({ ...sliceLocationsMap(map, cityParam(req.url)), citiesAsOf, playsAsOf });
    const t3 = Date.now();
    return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store",
      "Server-Timing": `auth;dur=${t1 - t0}, inputs;dur=${t2 - t1};desc="${playsStored ? "stored plays" : "live plays"}", build;dur=${t3 - t2}` } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
