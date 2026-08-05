// GET /api/growth/retention?city=all|<display> — the cohort matrix (all-cities
// rollup by default) from growth_cohort_matrix. No participation fetch; the view
// is pre-aggregated. The cards derive matrix/curve/heat/footers client-side.
import { authenticateCities } from "@/lib/growthAuth";
import { fetchCohortMatrix, cityAbbrFromDisplay } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  try {
    const city = new URL(req.url).searchParams.get("city");
    const abbr = !city || city === "all" ? null : cityAbbrFromDisplay(city);
    const t0 = Date.now();
    const payload = await fetchCohortMatrix(auth.supabase, abbr);
    return Response.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=60, stale-while-revalidate=300",
        "Server-Timing": `retention;dur=${Date.now() - t0}`,
      },
    });
  } catch (e) {
    console.error("[api/growth/retention] failed", e);
    return Response.json({ error: "Failed to load retention" }, { status: 500 });
  }
}
