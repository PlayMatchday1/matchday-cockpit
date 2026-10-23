// GET /api/matchops/market-locations/map — the Poland tab's Map. READ ONLY, Supabase only. The same
// build as /api/growth/locations/map (locationsInputs.ts + locationsMap.ts), scoped in the queries
// and with every distance and reach in the scope's unit (km).

import { authenticateMarketLocations } from "@/lib/marketLocationsAuth";
import { buildLocationsMap } from "@/lib/locationsMap";
import { loadLocationsInputs } from "@/lib/locationsInputs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateMarketLocations(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const { players, cities, citiesAsOf, fieldSnapshots, history, venueLinks, now } = await loadLocationsInputs(auth.supabase, auth.scope);
    const map = buildLocationsMap({ players, cities, fieldSnapshots, history, venueLinks, now, unit: auth.scope.unit });
    return Response.json({ ...map, citiesAsOf }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
