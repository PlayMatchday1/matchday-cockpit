// GET /api/matchops/market-locations/open-next?reach=10 — the Poland tab's "Where to open next".
// READ ONLY, Supabase only. loadOpenNext (locationsLoaders.ts) with the session's scope; `reach` is
// in the scope's unit, so 3 / 5 / 10 / 15 are kilometres here.

import { authenticateMarketLocations } from "@/lib/marketLocationsAuth";
import { loadOpenNext, OPEN_NEXT_REACHES } from "@/lib/locationsLoaders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateMarketLocations(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const reach = Number(new URL(req.url).searchParams.get("reach") ?? 10);
  if (!OPEN_NEXT_REACHES.has(reach)) return Response.json({ error: "reach must be 3, 5, 10 or 15" }, { status: 400 });
  try {
    return Response.json(await loadOpenNext(auth.supabase, reach, auth.scope), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
