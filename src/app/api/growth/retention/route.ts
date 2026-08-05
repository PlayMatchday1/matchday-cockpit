// GET /api/growth/retention — the cohort/retention slice of the one cached
// growth aggregate (getGrowthCache). Same cache /api/growth reads, so the 232k
// participation rows are fetched once and both endpoints serve from it.

import { authenticateCities } from "@/lib/growthAuth";
import { getGrowthCache } from "@/lib/growthCache";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const t0 = Date.now();
    const c = await getGrowthCache(auth.supabase);
    const totalMs = Date.now() - t0;
    return Response.json(
      { ...c.retention, timing: { cached: c.cached, fetchMs: c.timing.fetchMs, computeMs: c.timing.computeMs, totalMs } },
      {
        status: 200,
        headers: {
          "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
          "Server-Timing": `retention;dur=${totalMs};desc="${c.cached ? "cache" : "fresh"}"`,
        },
      },
    );
  } catch (e) {
    console.error("[api/growth/retention] failed", e);
    return Response.json({ error: "Failed to compute retention" }, { status: 500 });
  }
}
