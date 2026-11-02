// Staff app OPS · REVIEWS (Ryan, 2026-11-02). VIEW ONLY: GET is the only method this route exports, and
// nothing here writes (replies stay on the desktop). The desktop Reviews page's data and rules, read
// through src/lib/appReviews.ts.
//
//   GET ?kind=week|month&start=YYYY-MM-DD[&city=<name>]
//       week: Monday to Sunday, default the last full week; month: default the current month so far.
//       city: one city's figures (404 when it is not in the caller's view).
//
// ACCESS: Match Ops through the app's read check, then /api/reviews's own gate and city scope (a
// city-confined account gets its own city only, filtered in SQL from the session).

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { todayBusinessDate } from "@/lib/goalPace";
import { addDays, addMonths, mondayOf, monthStart } from "@/lib/healthModel";
import { canonCity } from "@/lib/reviewsDerive";
import { loadReviewRows, matchIds, reviewsView } from "@/lib/appReviews";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function getRoute(req: Request) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });

  const q = new URL(req.url).searchParams;
  const kind = q.get("kind") === "month" ? "month" : "week";
  const today = todayBusinessDate(new Date());
  const start = q.get("start");
  const dflt = kind === "week" ? addDays(mondayOf(today), -7) : monthStart(today);
  const s0 = start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : dflt;
  let from = kind === "week" ? mondayOf(s0) : monthStart(s0);
  if (from > today) from = kind === "week" ? mondayOf(today) : monthStart(today);
  const to = kind === "week" ? addDays(from, 6) : addDays(addMonths(from, 1), -1);
  const nextFrom = kind === "week" ? addDays(from, 7) : addMonths(from, 1);

  try {
    const s = await loadReviewRows(req, auth.supabase);
    if ("error" in s) return Response.json({ error: s.error }, { status: s.status });
    const ids = await matchIds(auth.supabase, from, to);
    const cityQ = q.get("city");
    const view = reviewsView(s, from, to, cityQ, ids);
    if (cityQ != null && !view.cities.some((c) => canonCity(c.name) === canonCity(cityQ))) {
      // A city outside the scope never reaches the rows (SQL); one with no reviews this period is empty, not foreign.
      const known = s.rows.some((r) => canonCity(r.city) === canonCity(cityQ));
      if (!known) return Response.json({ error: "That city is not in your view." }, { status: 404 });
    }
    return Response.json({
      kind, today, scope: s.scope,
      period: { from, to, current: today >= from && today <= to, canForward: nextFrom <= today },
      ...view,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export const GET = reviewMasked(getRoute);
