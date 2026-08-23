// GET /api/lifecycle/retention/cohort-cities?cohort=YYYY-MM — one cohort split by
// first-match city (the city-detail panel). Lazy; not in the initial payload.
import { authenticateLifecycle } from "@/lib/lifecycleAuth";
import { fetchCohortCities } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateLifecycle(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const cohort = new URL(req.url).searchParams.get("cohort");
  if (!cohort) return Response.json({ error: "cohort required" }, { status: 400 });
  try {
    const t0 = Date.now();
    const payload = await fetchCohortCities(auth.supabase, cohort);
    return Response.json(payload, { status: 200, headers: { "Server-Timing": `cohortCities;dur=${Date.now() - t0}` } });
  } catch (e) {
    console.error("[api/lifecycle/retention/cohort-cities] failed", e);
    return Response.json({ error: "Failed to load cohort cities" }, { status: 500 });
  }
}
