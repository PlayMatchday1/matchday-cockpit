// Staff app HEALTH TAB (Ryan, 2026-11-01): cancel rate and fill rate for a week (Monday to Sunday) or a
// month, by city and field, with a six-period trend. READ ONLY. See src/lib/healthModel.ts for the
// math and src/lib/healthLoad.ts for the read (the Gameday Ops board's own live read and shaping).
//
//   GET ?period=week|month&start=YYYY-MM-DD[&city=<name>][&fresh=1]
//       fresh=1 (pull to refresh): the chosen period is read live and replaces its cached copy.
//       start defaults to the last full week, or the current month so far; forward stops at the
//       current period. city: just that city (404 when it is not in the caller's view).
//
// ACCESS: Match Ops, through the app's read check. A city-confined account reads only its own city,
// filtered on the server before anything is counted; the request cannot name another.

import { authenticateApp, readRefusal } from "@/lib/appAuth";
import { isEnv } from "@/lib/appLive";
import { todayBusinessDate } from "@/lib/goalPace";
import { loadPeriod } from "@/lib/healthLoad";
import { defaultStart, periodOf, stepPeriod, type Period } from "@/lib/healthModel";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TREND = 6;

async function getRoute(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateApp(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const refused = readRefusal(auth);
  if (refused) return Response.json({ error: refused.error }, { status: refused.status });
  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const q = new URL(req.url).searchParams;
  const kind = q.get("period") === "month" ? "month" : "week";
  const today = todayBusinessDate(new Date());
  const start = q.get("start");
  let p: Period = periodOf(kind, start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : defaultStart(kind, today), today);
  if (p.from > today) p = periodOf(kind, today, today);
  const scope = auth.confined ? auth.scopeCity : null;

  try {
    const t0 = Date.now();
    const periods: Period[] = [p];
    for (let i = 1; i < TREND; i++) periods.unshift(stepPeriod(periods[0], -1, today));
    const fresh = q.get("fresh") === "1";
    const loaded = await Promise.all(periods.map((x, i) => loadPeriod(auth.supabase, env, x.from, x.to, scope, x.current, fresh && i === periods.length - 1)));
    const now = loaded[loaded.length - 1], prev = loaded.length > 1 ? loaded[loaded.length - 2] : null;
    const next = stepPeriod(p, 1, today);
    const label = p.current ? "So far" : kind === "week" ? (stepPeriod(p, 1, today).current ? "Last full week" : null) : (next.current ? "Last full month" : null);
    const trendOf = (city: string | null) => loaded.map((x, i) => {
      const r = city == null ? x.total : x.cities.find((c) => c.city === city) ?? null;
      return { from: periods[i].from, cancelRate: r?.cancelRate ?? null, fillRate: r?.fillRate ?? null, scheduled: r?.scheduled ?? 0, capacity: r?.capacity ?? 0 };
    });
    let cities = now.cities.map((c) => ({ ...c, trend: trendOf(c.city) }));
    const cityQ = q.get("city");
    if (cityQ != null) {
      cities = cities.filter((c) => c.city === cityQ);
      if (!cities.length) return Response.json({ error: "That city is not in your view." }, { status: 404 });
    }
    return Response.json({
      env, today, scopeCity: scope,
      period: { ...p, label, canForward: next.from !== p.from },
      total: { ...now.total, trend: trendOf(null) },
      previous: prev ? { from: prev.from, to: prev.to, cancelRate: prev.total.cancelRate, fillRate: prev.total.fillRate } : null,
      cities,
      spotsError: now.spotsError,
      // readAt: when the shown period was read from MatchDay (it can be up to 5 minutes old).
      readAt: now.readAt,
      timing: { ms: Date.now() - t0, cached: loaded.map((x) => x.cached) },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export const GET = reviewMasked(getRoute);
