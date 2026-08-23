// GET /api/lifecycle — the Growth tab's funnel / behavior / ARPP / KPI payload.
// Reads the pre-aggregated growth_* materialized views (growth_player_profile,
// growth_play_dims, growth_registration, growth_downloads_month) plus the small
// mdapi_subscriptions + fin_revenue tables — NO 232k-row matches+players fetch.
// Postgres does the grouping; readGrowthFromViews reshapes into the exact same
// GrowthData computeGrowth used to produce (validated deep-equal, 23/23 fields).
// The churn card reads /api/lifecycle/churn (paginated); the retention curve + cohort
// table read /api/lifecycle/retention (the cohort matrix). players[] is empty here.
//
// Gated on can_access_lifecycle via authenticateLifecycle.

import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { readGrowthFromViews } from "@/lib/growthFromViews";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const t0 = Date.now();
    const timing: { fetchMs?: number; computeMs?: number } = {};
    const growth = await readGrowthFromViews(auth.supabase, new Date().toISOString(), timing);
    const totalMs = Date.now() - t0;
    return Response.json(growth, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "Server-Timing": `growth;dur=${totalMs}`,
        // Custom headers survive Vercel (Server-Timing is stripped) — lets us read
        // the true lambda-internal cold time without the caller's WAN latency.
        "X-Growth-Total-Ms": String(totalMs),
        "X-Growth-Fetch-Ms": String(timing.fetchMs ?? -1),
        "X-Growth-Compute-Ms": String(timing.computeMs ?? -1),
      },
    });
  } catch (e) {
    console.error("[api/lifecycle] failed", e);
    return Response.json({ error: "Failed to compute growth data" }, { status: 500 });
  }
}
