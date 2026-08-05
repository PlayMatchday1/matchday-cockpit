// GET /api/growth — the Growth tab's funnel / behavior / ARPP / KPI payload.
// Reads the pre-aggregated growth_* materialized views (growth_player_profile,
// growth_play_dims, growth_registration, growth_downloads_month) plus the small
// mdapi_subscriptions + fin_revenue tables — NO 232k-row matches+players fetch.
// Postgres does the grouping; readGrowthFromViews reshapes into the exact same
// GrowthData computeGrowth used to produce (validated deep-equal, 23/23 fields).
// The churn card reads /api/growth/churn (paginated); the retention curve + cohort
// table read /api/growth/retention (the cohort matrix). players[] is empty here.
//
// Gated on can_access_cities via authenticateCities.

import { authenticateCities } from "@/lib/growthAuth";
import { readGrowthFromViews } from "@/lib/growthFromViews";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const t0 = Date.now();
    const growth = await readGrowthFromViews(auth.supabase, new Date().toISOString());
    const totalMs = Date.now() - t0;
    return Response.json(growth, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "Server-Timing": `growth;dur=${totalMs}`,
      },
    });
  } catch (e) {
    console.error("[api/growth] failed", e);
    return Response.json({ error: "Failed to compute growth data" }, { status: 500 });
  }
}
