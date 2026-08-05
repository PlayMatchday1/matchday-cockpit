// GET /api/growth — the Growth tab's data endpoint for the funnel, player
// behavior, ARPP and churn cards. Reads the one cached growth aggregate
// (getGrowthCache): a single keyset-paginated fetch of the mdapi_* mirror +
// fin_revenue, computeGrowth run once, cached in-process keyed on the max match
// date. The retention curve + cohort table read the SAME cache via
// /api/growth/retention — the participation rows are fetched once, not twice.
//
// Gated on can_access_cities via authenticateCities.

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
    return Response.json(c.growth, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "Server-Timing": `growth;dur=${totalMs};desc="${c.cached ? "cache" : "fresh"}"`,
      },
    });
  } catch (e) {
    console.error("[api/growth] failed", e);
    return Response.json({ error: "Failed to compute growth data" }, { status: 500 });
  }
}
