// GET /api/growth/locations — the Locations page's data. READ ONLY, Supabase only.
// Growth's own gate (authenticateCapability "growth"), like every /api/growth route; moved from
// /api/matchops/locations with the page on 2026-10-08.
//
// Never calls MatchDay on a page load (Ryan, 2026-10-08): /api/sync/player-areas refreshes
// player_area_seen three times a day and this route reads what it wrote. no-store, so Refresh is a
// real re-read. Aggregation happens in src/lib/locationsLoaders.ts + locationsReport.ts (shared with
// the Poland tab's /api/matchops/market-locations); the browser gets totals and groups, not player
// rows — except the 100 most recent, which the page lists by name.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { loadLocationsOverview } from "@/lib/locationsLoaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const report = await loadLocationsOverview(auth.supabase);
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. An empty page and a failed read must never look the same.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
