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
import { cityIdentifierForLabel } from "@/lib/cityScope";
import { loadReviewRows, matchIds, reviewsView } from "@/lib/appReviews";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* A SHORT SERVER CACHE (Ryan, 2026-11-02): reviews arrive with the mirror sync, not by the second.
 * KEYED BY THE CALLER, never shared between accounts: the scope comes from the session (confinement
 * and the city-manager tier), so two people may see different cities for the same request. The
 * cached body is the unmasked view; reviewMasked still masks it per request. */
const TTL_MS = 2 * 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

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

  const cityQ = q.get("city");
  const key = `${auth.appUserId}|${kind}|${from}|${cityQ == null ? "" : canonCity(cityQ)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Response.json(hit.body, { headers: { "Cache-Control": "no-store", "X-Reviews-Cache": "hit" } });
  try {
    const [s, ids] = await Promise.all([loadReviewRows(req, auth.supabase, from, to), matchIds(auth.supabase, from, to)]);
    if ("error" in s) return Response.json({ error: s.error }, { status: s.status });
    const view = reviewsView(s, from, to, cityQ, ids);
    // A city outside a scoped caller's own is refused; any city with no reviews this period is empty.
    if (cityQ != null && s.scope && cityIdentifierForLabel(canonCity(cityQ) ?? cityQ) !== s.scope) {
      return Response.json({ error: "That city is not in your view." }, { status: 404 });
    }
    const body = {
      kind, today, scope: s.scope,
      period: { from, to, current: today >= from && today <= to, canForward: nextFrom <= today },
      ...view,
    };
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at >= TTL_MS) cache.delete(k);
    return Response.json(body, { headers: { "Cache-Control": "no-store", "X-Reviews-Cache": "miss" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export const GET = reviewMasked(getRoute);
