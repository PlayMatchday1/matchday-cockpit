/* CREDIT EVERYONE WHO PAID — one run, N independent adjustments. The manager-no-show case.
 *
 * Ryan: "in the match editors need a button that credits everyone in the match ... Sometimes the
 * manager doesnt show up". The weather case is NOT this: cancelling already credits every
 * signed-up player and texts them, server-side, from the one PATCH the Cancel card fires. This
 * route is REFUSED OUTRIGHT on a cancelled match, because running it there would pay people twice.
 *
 * GET  — a live DRY RUN. The plan, the total, the grouped skips, and whether it is refused. Reads
 *        the roster at confirm time so the number on the button is never a stale render. WRITES
 *        NOTHING.
 * POST — the run. { notify?: boolean }. One adjustment per player, each with its own race check and
 *        its own verdict read back from the API. No retries, ever.
 *
 * ── THE FIVE RULES OF THE PER-PLAYER ROUTE, CARRIED OVER PER PLAYER ────────────────────────────
 *  1. EDIT CREDITS, read fresh from the database — creditsAuth, and again inside apiWrite's
 *     chokepoint (`requires: "credits"`), so a route that forgot its own check is still stopped.
 *  2. THE CLIENT NEVER SENDS A BALANCE. It sends nothing but `notify`. Every amount is computed
 *     here from the live roster, and every absolute balance from a fresh per-player read.
 *  3. THE RACE IS CHECKED, per player. Two reads a few milliseconds apart, immediately around the
 *     write; if the balance moved between them, that player is ABORTED and reported. Never
 *     re-based. NOTE the difference from the single-player route: there, `expected` is the figure a
 *     human was looking at. Here nobody saw 20 balances, so the strongest available check is
 *     "did this balance move while we were working on it" — which catches a concurrent operator or
 *     a second run, and is stated rather than dressed up as more than it is.
 *  4. ONE ATTEMPT PER PLAYER. apiWrite is single-shot; recordWrite calls it once. A failure is
 *     recorded and the run CONTINUES — a half-finished run is the expected shape of this thing, and
 *     pressing the button again is how the rest get paid.
 *  5. EVERY adjustment through recordWrite into change_log with before, after, delta and reason —
 *     PLAYER ID ONLY. No name, no phone, no email.
 *
 * ── IDEMPOTENCY READS OUR OWN LEDGER, AND HERE IS WHAT IT CANNOT SEE ───────────────────────────
 * A second run must credit only the players the first run missed. The roster cannot tell us who was
 * credited — `credit_amount` on a roster row is credit the player SPENT at checkout (the facts
 * doc's identity: total_amount = round((amount − credit_amount) × (1 + rate))), not credit they
 * received. So the skip list is read from change_log: every adjustment this route makes is written
 * with this match's id and this source, and a second run reads back the LANDED ones and skips those
 * players.
 *
 * THE LIMIT, ON THE RECORD: that is a ledger of what CLUBHOUSE did. A wallet credit from any other
 * source — a cancel, Retool, a manual profile edit — is invisible to it. This is not a complete
 * view of a player's wallet and must never be mistaken for one. The one collision that matters, a
 * cancel's own credit, is covered by refusing this control on a cancelled match.
 */

import { randomUUID } from "node:crypto";
import { authenticateCredits } from "@/lib/creditsAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { CONFINED_CITY_ERROR, playerCityAllowed } from "@/lib/cityConfinement";
import { MAX_RUN_CENTS, MAX_RUN_PLAYERS, fmtUsd, planCreditRun, raceCheck, type CreditPlan, type MoneyRosterRow } from "@/lib/creditsModel";
import type { Change } from "@/lib/changeLogModel";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE = "Match editor · credit everyone who paid";
/* THE MESSAGE IS NOT APPROVED YET, so notify cannot be turned on. Ryan has to read the wording
 * before a sentence reaches a real phone; the proposal is in the report. Flipping this to true is
 * the whole change once he has. A control that looks live and does nothing is worse than a disabled
 * one, so the checkbox is DISABLED on screen and this refuses it here as well. */
const NOTIFY_ENABLED = false;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const balanceOf = (p: Record<string, unknown>): number => {
  const n = Number(p?.creditAmount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

async function readLive(env: MatchdayEnv, id: string) {
  const [match, playersRaw] = await Promise.all([
    apiGet<Record<string, unknown>>(env, `/admin/matches/${id}`),
    apiGet<unknown[] | { data?: unknown[] }>(env, `/admin/matches/${id}/players`).catch(() => []),
  ]);
  const players = (Array.isArray(playersRaw) ? playersRaw : (playersRaw?.data ?? [])) as MoneyRosterRow[];
  return { match, players };
}

/** The players THIS route has already landed a credit for on THIS match, from change_log. */
async function alreadyCredited(env: string, matchId: number): Promise<number[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from("change_log")
    .select("endpoint, outcome")
    .eq("match_id", matchId)
    .eq("env", env)
    .eq("source", SOURCE)
    .eq("outcome", "landed");
  if (error) throw new Error(`change_log: ${error.message}`);
  // The player id comes off the endpoint we wrote, which is the only identity the log carries.
  const ids: number[] = [];
  for (const r of data ?? []) {
    const m = /\/admin\/players\/(\d+)\/profile/.exec(String(r.endpoint ?? ""));
    if (m) ids.push(Number(m[1]));
  }
  return [...new Set(ids)];
}

type View = {
  matchId: number; name: string; cancelled: boolean;
  plan: CreditPlan; alreadyCreditedCount: number;
  refused: string | null;
  cancelCredited: { count: number; totalCents: number } | null;
};

async function buildView(env: MatchdayEnv, id: string): Promise<View> {
  const { match, players } = await readLive(env, id);
  const matchId = Number(id);
  const cancelled = match.isCancelled === true;
  const already = cancelled ? [] : await alreadyCredited(env, matchId);
  const plan = planCreditRun(players, { alreadyCreditedUserIds: already });
  /* WHAT THE CANCEL ALREADY CREDITED, stated on the refusal so the operator knows why the control
   * is gone rather than guessing. The numbers are the cancel preview's own: the match value times
   * the players it credits. */
  const perPlayer = Number(match.registrationPrice) || 0;
  const creditable = players.filter((p) => !(p.isFakePlayer === true || p.user?.isFakePlayer === true) && !(p.isCancelled === true || p.canceledAt != null)).length;
  return {
    matchId, name: (match.name as string) ?? "", cancelled, plan,
    alreadyCreditedCount: already.length,
    /* THE REFUSAL SAYS WHAT THE CANCEL ALREADY DID, and says it differently when there was nobody
     * to credit — "credited 0 players $0.00 and texted them" implies a text that never went. */
    refused: cancelled
      ? (creditable === 0
        ? "Cancelled. Nobody was signed up, so the cancel credited nothing."
        : `Cancelled. The cancel credited ${creditable} player${creditable === 1 ? "" : "s"} ${fmtUsd(creditable * perPlayer)} and texted them.`)
      : plan.overCap,
    cancelCredited: cancelled ? { count: creditable, totalCents: creditable * perPlayer } : null,
  };
}

export async function GET(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  // The dry run is gated on the same grant as the write: there is no reason to show a money surface
  // to somebody who can never use it.
  const auth = await authenticateCredits(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "match id must be numeric" }, { status: 400 });
  try {
    const view = await buildView(env, id);
    return Response.json({
      ...view,
      notifyAvailable: NOTIFY_ENABLED,
      caps: { maxRunCents: MAX_RUN_CENTS, maxRunPlayers: MAX_RUN_PLAYERS },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return errToResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; id: string }> }) {
  const auth = await authenticateCredits(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, id } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(id)) return Response.json({ error: "match id must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { notify?: unknown } | null;
  const notify = body?.notify === true;
  if (notify && !NOTIFY_ENABLED) {
    return Response.json({ error: "Texting is not switched on yet — the wording has not been approved." }, { status: 400 });
  }

  try {
    // THE PLAN IS REBUILT HERE, LIVE. Nothing the client sent decides who is paid or how much.
    const view = await buildView(env, id);
    if (view.cancelled) return Response.json({ ...view, error: view.refused, refusedRun: true }, { status: 409 });
    if (view.plan.overCap) return Response.json({ ...view, error: view.plan.overCap, refusedRun: true }, { status: 400 });
    if (view.plan.pay.length === 0) {
      return Response.json({ ok: true, ran: 0, landed: 0, aborted: 0, failed: 0, skipped: view.plan.skips, results: [], totalCreditedCents: 0, ...view });
    }

    const saveId = randomUUID();   // one run, one save id, N rows in the log
    const results: { userId: number; cents: number; verdict: "LANDED" | "ABORTED" | "FAILED" | "REFUSED"; detail?: string }[] = [];

    for (const target of view.plan.pay) {
      const playerPath = `/admin/players/${target.userId}`;
      let before = 0;
      try {
        const player = await apiGet<Record<string, unknown>>(env, playerPath);
        // REFUSED BY ID, FROM THE SERVER, PER PLAYER — not by a list that happened not to offer them.
        if (!playerCityAllowed(auth.confinedCity, player)) {
          console.warn(`[credit-all] 403 player ${target.userId}: ${auth.email} confined to ${auth.confinedCity}`);
          results.push({ userId: target.userId, cents: target.cents, verdict: "REFUSED", detail: CONFINED_CITY_ERROR });
          continue;
        }
        before = balanceOf(player);
      } catch (e) {
        results.push({ userId: target.userId, cents: target.cents, verdict: "FAILED", detail: e instanceof Error ? e.message : String(e) });
        continue;
      }

      // RULE 3 — re-read immediately before writing. A move between these two reads means somebody
      // else is touching this balance right now; that player is aborted, not re-based.
      let fresh = before;
      try {
        fresh = balanceOf(await apiGet<Record<string, unknown>>(env, playerPath));
      } catch (e) {
        results.push({ userId: target.userId, cents: target.cents, verdict: "FAILED", detail: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const race = raceCheck(before, fresh);
      if (!race.ok) {
        results.push({ userId: target.userId, cents: target.cents, verdict: "ABORTED", detail: race.error });
        continue;
      }

      const after = before + target.cents;
      const changes: Change[] = [
        { key: "creditAmount", field: "Credit balance", before, after },
        { key: "delta", field: "Adjustment", before: "—", after: `+${target.cents} cents (${fmtUsd(target.cents)})` },
        { key: "reason", field: "Reason", before: "—", after: `Credit everyone who paid · match ${view.matchId} · manager no-show` },
      ];

      try {
        const { outcome, error } = await recordWrite(
          {
            env, source: SOURCE, actorName: auth.email, actorEmail: auth.email,
            saveId, matchId: view.matchId, matchName: view.name,
            // PLAYER ID ONLY. The endpoint carries the id, which is also what a second run reads back.
            method: "PUT", path: `${playerPath}/profile`, body: { creditAmount: after },
            keys: ["creditAmount"], label: (k) => (k === "creditAmount" ? "Credit balance" : k),
            applied: (_b, a) => balanceOf((a.player as Record<string, unknown>) ?? {}) === after,
            changes,
          },
          {
            readResource: async () => ({ player: await apiGet<Record<string, unknown>>(env, playerPath).catch(() => ({})) }),
            // RULE 4 — one attempt. Single-shot, and the chokepoint re-checks the grant.
            write: () => apiWrite(env, "PUT", `${playerPath}/profile`, { creditAmount: after },
              { canEditMatches: false, canEditCredits: true, email: auth.email, userId: auth.appUserId }, "credits"),
            now: () => new Date().toISOString(),
          },
          supabaseLogStore(),
        );
        if (error) {
          results.push({ userId: target.userId, cents: target.cents, verdict: outcome === "landed" ? "LANDED" : "FAILED", detail: error.message });
          continue;
        }
        results.push({ userId: target.userId, cents: target.cents, verdict: outcome === "landed" ? "LANDED" : "FAILED" });
      } catch (e) {
        // ONE PLAYER'S FAILURE DOES NOT STOP THE RUN. It is recorded and the next player proceeds.
        results.push({ userId: target.userId, cents: target.cents, verdict: "FAILED", detail: e instanceof Error ? e.message : String(e) });
      }
    }

    const landed = results.filter((r) => r.verdict === "LANDED");
    return Response.json({
      ok: true,
      ran: results.length,
      landed: landed.length,
      aborted: results.filter((r) => r.verdict === "ABORTED").length,
      failed: results.filter((r) => r.verdict === "FAILED").length,
      refusedPlayers: results.filter((r) => r.verdict === "REFUSED").length,
      totalCreditedCents: landed.reduce((s, r) => s + r.cents, 0),
      // The per-player verdict, by id. No names leave this route.
      results,
      skipped: view.plan.skips,
      notified: 0,
      matchId: view.matchId, name: view.name,
    });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true, outcome: "UNKNOWN" }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e), outcome: "UNKNOWN" }, { status: 500 });
}
