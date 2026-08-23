// GET /api/lifecycle/retention?city=all|<display> — the cohort matrix (all-cities
// rollup by default) from growth_cohort_matrix. No participation fetch; the view
// is pre-aggregated. The cards derive matrix/curve/heat/footers client-side.
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { fetchCohortMatrix, cityAbbrFromDisplay } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const city = new URL(req.url).searchParams.get("city");
    const abbr = !city || city === "all" ? null : cityAbbrFromDisplay(city);
    const t0 = Date.now();
    const payload = await fetchCohortMatrix(auth.supabase, abbr);
    const totalMs = Date.now() - t0;
    return Response.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "Server-Timing": `retention;dur=${totalMs}`,
        "X-Retention-Total-Ms": String(totalMs),
      },
    });
  } catch (e) {
    console.error("[api/lifecycle/retention] failed", e);
    return Response.json({ error: "Failed to load retention" }, { status: 500 });
  }
}
