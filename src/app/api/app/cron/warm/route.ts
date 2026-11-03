// Staff app WARM (Ryan, 2026-11-02): keeps the slow, cached reads ready so nobody opening the app
// waits on them. CRON_SECRET only; nothing a person can call. Every 5 minutes (vercel.json).
//
//   HEALTH    each default view's periods (the current week and month, and the ended periods of
//             their trends), for all cities and for each city a Match Ops account is confined to.
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
import { confinedCity } from "@/lib/cityConfinement";
import { todayBusinessDate } from "@/lib/goalPace";
import { loadPeriod } from "@/lib/healthLoad";
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

  // The city scopes in use: every Match Ops account confined to a city, plus all cities.
  const users = await sb.from("app_users").select("*");
  const scopes: (string | null)[] = [null, ...new Set((users.data ?? [])
    .filter((u) => u.can_access_matchops === true && u.is_service_account !== true)
    .map((u) => confinedCity(u)).filter((c): c is string => c != null))];

  // HEALTH: each default view's six periods; the current ones live (fresh), the rest from the cache.
  const healthViews: Period[][] = (["week", "month"] as const).map((kind) => {
    const ps: Period[] = [periodOf(kind, defaultStart(kind, today), today)];
    for (let i = 1; i < TREND; i++) ps.unshift(stepPeriod(ps[0], -1, today));
    const next = stepPeriod(ps[ps.length - 1], 1, today);
    if (next.from !== ps[ps.length - 1].from) ps.push(next);   // the current week, after the last full one
    return ps;
  });
  const health = async () => {
    for (const scope of scopes) {
      for (const ps of healthViews) {
        await Promise.all(ps.map((p) => run(`health ${scope ?? "all"} ${p.from}`, () => loadPeriod(sb, "production", p.from, p.to, scope, p.current))));
      }
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
  console.log(`[app-warm] ${done.length} warmed, ${failed.length} failed in ${Date.now() - t0} ms; scopes ${scopes.map((x) => x ?? "all").join(",")}${failed.length ? `; first failure: ${failed[0]}` : ""}`);
  return Response.json({ ok: failed.length === 0, ms: Date.now() - t0, scopes: scopes.map((s) => s ?? "all"), done: done.length, failed });
}

export const GET = POST;
