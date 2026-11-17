// Staff app WARM (Ryan, 2026-11-02): keeps the slow, cached reads ready so nobody opening the app
// waits on them. CRON_SECRET only; nothing a person can call. Every 5 minutes (vercel.json).
//
//   HEALTH    each default view's periods (the current week and month, and the ended periods of
//             their trends), ONCE for all cities (a confined account's view is cut from the same
//             copy), one range after another, stopping at the first failure. Ended periods are read
//             only when the cache does not hold them yet; the current ones refresh once stale. Through
//             healthLoad's queue: one request a second, none while a failure is backing off.
//             (Ryan, 2026-11-17: the old per-scope, parallel version took production down. This job is
//             out of vercel.json until Ryan turns it back on.)
//   PLAYERS   the default period of each kind and the five before it, for both pages.
//   GOALS     the year's field rollup (src/lib/fieldGoalsRollup.ts) that Field Goals and Goals read.
//
// PLAIN CACHED READS, NEVER FORCED: a stale entry is served and refreshed in the background
// (stale-while-revalidate), a missing one is read. Forcing (expiring the tag first) made the next
// person's read wait for a live one. Health and Players run side by side.
//
// Production only. It writes nothing anywhere: every call is a read that fills the data cache.

import { makeServerClient } from "@/lib/supabaseServer";
import { fieldGoalsRollup } from "@/lib/fieldGoalsRollup";
import { GOAL_YEAR, businessYesterday } from "@/lib/fieldGoals";
import { todayBusinessDate } from "@/lib/goalPace";
import { healthBackoff, healthRequestsMade, loadPeriod } from "@/lib/healthLoad";
import { defaultStart, periodOf, stepPeriod, type Period } from "@/lib/healthModel";
import { acquisitionPeriod, activityPeriods, androidPeriod, periodOf as playersPeriodOf, stepOf, type Kind } from "@/lib/appPlayers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TREND = 6;

export async function POST(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const secret = process.env.CRON_SECRET;
  if (!secret || token !== secret) return Response.json({ error: "Not authorised." }, { status: 401 });

  const sb = makeServerClient();
  const today = todayBusinessDate(new Date());
  const t0 = Date.now();
  const done: string[] = [];
  const failed: string[] = [];
  const run = async (label: string, f: () => Promise<unknown>) => {
    const s = Date.now();
    try { await f(); done.push(`${label} ${Date.now() - s}ms`); } catch (e) { failed.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // HEALTH: each default view's periods, all cities, each range once.
  const healthViews: Period[][] = (["week", "month"] as const).map((kind) => {
    const ps: Period[] = [periodOf(kind, defaultStart(kind, today), today)];
    for (let i = 1; i < TREND; i++) ps.unshift(stepPeriod(ps[0], -1, today));
    const next = stepPeriod(ps[ps.length - 1], 1, today);
    if (next.from !== ps[ps.length - 1].from) ps.push(next);   // the current week, after the last full one
    return ps;
  });
  const ranges = [...new Map(healthViews.flat().map((p) => [`${p.from}:${p.to}:${p.current}`, p])).values()];
  const requestsBefore = healthRequestsMade();
  const health = async () => {
    const paused = healthBackoff("production");
    if (paused) { failed.push(`health skipped: paused until ${new Date(paused.until).toISOString()}`); return; }
    for (const p of ranges) {
      const before = failed.length;
      await run(`health ${p.from}`, () => loadPeriod(sb, "production", p.from, p.to, null, p.current));
      if (failed.length > before) return;   // the first failure stops Health for this run
    }
  };

  // PLAYERS: the route's own reads for each kind's default view.
  const players = () => Promise.all((["month", "week", "day"] as Kind[]).map((kind) => {
    const ps = [playersPeriodOf(kind, today)];
    for (let i = 1; i < TREND; i++) ps.unshift(stepOf(ps[0], -1));
    const cur = (x: { from: string; to: string }) => x.to >= today && x.from <= today;
    return run(`players ${kind}`, () => Promise.all([
      ...ps.map((x) => acquisitionPeriod(sb, x, cur(x))),
      ...ps.map((x) => androidPeriod(sb, x, cur(x))),
      activityPeriods(sb, ps, today),
    ]));
  }));

  await Promise.all([health(), players(), run("goals rollup", () => fieldGoalsRollup(sb, GOAL_YEAR, businessYesterday(new Date())))]);
  const apiRequests = healthRequestsMade() - requestsBefore;
  console.log(`[app-warm] ${done.length} warmed, ${failed.length} failed in ${Date.now() - t0} ms; ${apiRequests} MatchDay requests${failed.length ? `; first failure: ${failed[0].split(" Body:")[0]}` : ""}`);
  return Response.json({ ok: failed.length === 0, ms: Date.now() - t0, apiRequests, done: done.length, failed: failed.map((f) => f.split(" Body:")[0]) });
}

export const GET = POST;
