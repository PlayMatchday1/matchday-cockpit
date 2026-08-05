// GET /api/growth/retention/players?cohort=YYYY-MM&age=N&city=all|<display>
// age 0 -> the whole starting cohort; age >= 1 -> churned (active at N-1 AND NOT
// active at N), the set subtraction done in SQL by growth_cohort_players. Lazy.
import { authenticateCities } from "@/lib/growthAuth";
import { fetchCohortPlayers, cityAbbrFromDisplay } from "@/lib/growthViews";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const auth = await authenticateCities(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sp = new URL(req.url).searchParams;
  const cohort = sp.get("cohort");
  const age = Number(sp.get("age"));
  if (!cohort || Number.isNaN(age)) return Response.json({ error: "cohort and age required" }, { status: 400 });
  const city = sp.get("city");
  const abbr = !city || city === "all" ? null : cityAbbrFromDisplay(city);
  try {
    const t0 = Date.now();
    const players = await fetchCohortPlayers(auth.supabase, cohort, age, abbr);
    return Response.json({ cohort, age, count: players.length, players }, { status: 200, headers: { "Server-Timing": `players;dur=${Date.now() - t0}` } });
  } catch (e) {
    console.error("[api/growth/retention/players] failed", e);
    return Response.json({ error: "Failed to load players" }, { status: 500 });
  }
}
