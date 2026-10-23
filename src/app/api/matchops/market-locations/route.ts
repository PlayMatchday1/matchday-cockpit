// GET /api/matchops/market-locations — the Poland tab's Overview (Match Ops → Locations). READ ONLY,
// Supabase only, never MatchDay. The same read as /api/growth/locations (locationsLoaders.ts) with
// the caller's scope applied IN THE QUERIES, so no other market's player reaches this response.
// The scope comes from the session (marketLocationsAuth.ts).

import { authenticateMarketLocations } from "@/lib/marketLocationsAuth";
import { loadLocationsOverview } from "@/lib/locationsLoaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateMarketLocations(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const report = await loadLocationsOverview(auth.supabase, auth.scope);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
