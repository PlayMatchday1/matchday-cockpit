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
import { hasPlayedInCity } from "@/lib/playerCityScope";
import { cityNameFor } from "@/lib/cityScope";
import { makeServerClient } from "@/lib/supabaseServer";
import { MAX_RUN_CENTS, MAX_RUN_PLAYERS, fmtUsd, planCreditRun, raceCheck, type CreditPlan, type MoneyRosterRow } from "@/lib/creditsModel";
import type { Change } from "@/lib/changeLogModel";
import { createClient } from "@supabase/supabase-js";
import Telnyx from "telnyx";
import { can } from "@/lib/capabilities";
import { localModeOn } from "@/lib/localMode";
import { normalizePhone } from "@/lib/phone";
import { phoneDigits10 } from "@/lib/aiDraftModel";
import { textOptOuts, type ChatMsg, type ChatThread } from "@/lib/signupExport";
import { creditTextProblem, fillCreditText, planCreditTexts, scrubDigits, type TextCandidate } from "@/lib/creditText";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SOURCE = "Match editor · credit everyone who paid";
/* TEXT THE PLAYERS — ON (Ryan, 2026-11-07: wording approved, src/lib/creditText.ts).
 *   • ONLY players whose credit LANDED in this run are texted, each with their own amount.
 *   • THE SAME SEND AS THE MATCH PANEL'S "Text the players" (/api/match-chats/[chatId]/notify): one
 *     Telnyx message per player. The cancel's own text is NOT this path — it is a server-side effect
 *     of MatchDay's PATCH /cancel and Clubhouse cannot send different words through it.
 *   • OPT-OUTS: a player whose Player Chats thread holds a STOP-type reply (textOptOuts, no later
 *     START) is skipped and counted; so is one with no phone, or a phone already texted this run.
 *     A Telnyx refusal is recorded as failed. Carrier-level opt-outs live at Telnyx, not here.
 *   • SEND MESSAGES is required, read fresh from app_users, as well as EDIT CREDITS.
 *   • LOGGED under the credit run's save id: the message AS STAFF WROTE IT (placeholders, no player
 *     data) and the sent / failed / skipped counts. No phone, no name, no filled text — CLAUDE.md:
 *     a message body is never logged; the template is not a body. */
const NOTIFY_ENABLED = true;

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
  /** For the message preview and the placeholders: the field and the WALL-CLOCK start. */
  field: string | null; startDate: string | null;
  /** The first player who would be credited, for the live preview. Never sent to MatchDay. */
  textPreview: { firstName: string | null; cents: number } | null;
  /** How many distinct players would be texted if every credit lands (before opt-outs and phones). */
  textRecipients: number;
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
  const firstOf = (uid: number) => {
    const row = players.find((p) => Number(p.userId ?? p.user?.id) === uid) as (MoneyRosterRow & { user?: { firstName?: string | null } }) | undefined;
    return row?.user?.firstName ?? null;
  };
  const owedBy = new Map<number, number>();
  for (const t of plan.pay) owedBy.set(t.userId, (owedBy.get(t.userId) ?? 0) + t.cents);
  const first = plan.pay[0];
  const field = ((match.field as Record<string, unknown> | undefined)?.title as string | undefined) ?? null;
  return {
    matchId, name: (match.name as string) ?? "", cancelled, plan,
    field, startDate: typeof match.startDate === "string" ? match.startDate : null,
    textPreview: first ? { firstName: firstOf(first.userId), cents: owedBy.get(first.userId) ?? first.cents } : null,
    textRecipients: owedBy.size,
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

  const body = (await req.json().catch(() => null)) as { notify?: unknown; message?: unknown } | null;
  const notify = body?.notify === true;
  const message = typeof body?.message === "string" ? body.message : "";
  if (notify && !NOTIFY_ENABLED) {
    return Response.json({ error: "Texting is not switched on yet — the wording has not been approved." }, { status: 400 });
  }
  // REFUSED BEFORE ANY CREDIT, so a bad message never leaves a run half texted.
  if (notify) {
    const problem = creditTextProblem(message);
    if (problem) return Response.json({ error: problem }, { status: 400 });
    const me = await makeServerClient().from("app_users").select("*").eq("id", auth.appUserId).maybeSingle();
    if (!can(me.data as never, "sendMessages", auth.email)) {
      return Response.json({ error: "Texting needs SEND MESSAGES. Untick Text the players to credit without texting." }, { status: 403 });
    }
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
    // Who each player is, from the same live read the credit uses — for the text only, never logged.
    const contact = new Map<number, { firstName: string | null; phone: string | null }>();

    for (const target of view.plan.pay) {
      const playerPath = `/admin/players/${target.userId}`;
      let before = 0;
      try {
        const player = await apiGet<Record<string, unknown>>(env, playerPath);
        // REFUSED BY ID, FROM THE SERVER, PER PLAYER — not by a list that happened not to offer them.
        /* THE PLAYED-IN HALF OF THE BOUNDARY, resolved against the mirror. The payload above is
     * GET /admin/players/{id} and carries no match history, so the union's second branch cannot be
     * answered from it. Asked only when the account is confined: an unconfined caller is allowed
     * by the first line of playerCityAllowed and must not pay for a query to prove it. */
    const playedInScopeT = auth.confinedCity
      ? await hasPlayedInCity(makeServerClient(), cityNameFor(auth.confinedCity) ?? "", Number(target.userId))
      : false;
    if (!playerCityAllowed(auth.confinedCity, player, playedInScopeT)) {
          console.warn(`[credit-all] 403 player ${target.userId}: ${auth.email} confined to ${auth.confinedCity}`);
          results.push({ userId: target.userId, cents: target.cents, verdict: "REFUSED", detail: CONFINED_CITY_ERROR });
          continue;
        }
        before = balanceOf(player);
        const pd = ((player as Record<string, unknown>)?.data ?? player) as Record<string, unknown>;
        contact.set(target.userId, { firstName: typeof pd.firstName === "string" ? pd.firstName : null, phone: typeof pd.phoneNumber === "string" ? pd.phoneNumber : null });
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
    const notified = notify ? await textLanded({ env, saveId, auth, view, message, landed, contact }) : null;
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
      notified: notified ?? { sent: 0, failed: 0, skipped: 0, reasons: [] },
      matchId: view.matchId, name: view.name,
    });
  } catch (e) { return errToResponse(e); }
}

/* THE TEXT, after the credits. One Telnyx message per player whose credit landed, the match panel's
 * send exactly (from TELNYX_FROM_NUMBER, Promise.allSettled, one attempt each, never retried). */
async function textLanded(a: {
  env: string; saveId: string; auth: { email: string }; view: View; message: string;
  landed: { userId: number; cents: number }[];
  contact: Map<number, { firstName: string | null; phone: string | null }>;
}): Promise<{ sent: number; failed: number; skipped: number; reasons: { reason: string; count: number }[] }> {
  const cents = new Map<number, number>();
  for (const r of a.landed) cents.set(r.userId, (cents.get(r.userId) ?? 0) + r.cents);
  const ids = [...cents.keys()];
  const sb = makeServerClient();
  // OPT-OUTS: the threads of these players (by account or by phone), and their inbound STOP / START.
  const phones = ids.map((id) => normalizePhone(a.contact.get(id)?.phone ?? null)).filter((p): p is string => !!p);
  let opt = { phones: new Set<string>(), players: new Set<number>() };
  let optRead = true;
  if (ids.length) {
    const t = await sb.from("crm_threads").select("id, phone_number, player_id").or(`player_id.in.(${ids.join(",")})${phones.length ? `,phone_number.in.(${phones.map((p) => `"${p}"`).join(",")})` : ""}`);
    const threads = (t.data ?? []) as ChatThread[];
    if (t.error) optRead = false;
    if (threads.length) {
      const m = await sb.from("crm_messages").select("thread_id, body, sent_at").eq("direction", "inbound").in("thread_id", threads.map((x) => x.id));
      if (m.error) optRead = false;
      opt = textOptOuts((m.data ?? []) as ChatMsg[], threads);
    }
  }
  const key = (p: string | null) => { const d = (p ?? "").replace(/\D/g, ""); return d ? phoneDigits10(d) ?? d : null; };
  const cands: TextCandidate[] = ids.map((id) => {
    const c = a.contact.get(id);
    const e164 = normalizePhone(c?.phone ?? null);
    const k = key(e164);
    // If the opt-out read failed, nobody is texted: "couldn't check" is not "didn't opt out".
    return { userId: id, cents: cents.get(id) ?? 0, firstName: c?.firstName ?? null, phoneE164: e164, optedOut: !optRead || opt.players.has(id) || (k != null && opt.phones.has(k)) };
  });
  const plan = planCreditTexts(cands);
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_FROM_NUMBER?.trim();
  let sent = 0, failed = 0;
  const errors: string[] = [];
  if (plan.send.length && (!apiKey || !from || localModeOn())) {
    failed = plan.send.length;
    errors.push(localModeOn() ? "Texting is off in local mode." : "Texting isn't configured (TELNYX_API_KEY / TELNYX_FROM_NUMBER).");
  } else if (plan.send.length) {
    const telnyx = new Telnyx({ apiKey: apiKey! });
    const settled = await Promise.allSettled(plan.send.map((c) => telnyx.messages.send({
      from: from!, to: c.phoneE164!,
      text: fillCreditText(a.message, { firstName: c.firstName, cents: c.cents, field: a.view.field, startDate: a.view.startDate }),
    })));
    for (const s of settled) {
      if (s.status === "fulfilled") sent++;
      else { failed++; errors.push(scrubDigits(s.reason instanceof Error ? s.reason.message : String(s.reason))); }
    }
  }
  const reasonCounts = new Map<string, number>();
  for (const k of plan.skipped) reasonCounts.set(k.reason, (reasonCounts.get(k.reason) ?? 0) + 1);
  if (!optRead) reasonCounts.set("opt-outs couldn't be checked", plan.skipped.filter((k) => k.reason === "opted out").length);
  const reasons = [...reasonCounts].map(([reason, count]) => ({ reason, count })).filter((r) => r.count > 0);
  const skipped = plan.skipped.length;
  /* LOGGED UNDER THE CREDIT RUN (same save id): the message as written and the counts. No phones,
   * names or filled texts. Best effort, like recordWrite: a logging outage never undoes a send. */
  try {
    await supabaseLogStore().insert({
      saveId: a.saveId, at: new Date().toISOString(), actorName: a.auth.email, actorEmail: a.auth.email,
      source: SOURCE, env: a.env, matchId: a.view.matchId, matchName: a.view.name,
      method: "POST", endpoint: "/sms/credit-text",
      body: { message: a.message, players: ids.length, sent, failed, skipped, skipped_reasons: reasons },
      outcome: failed > 0 ? "failed" : "landed",
      serverSaid: errors.length ? errors.slice(0, 3).join(" | ") : null,
      changes: [
        { key: "text", field: "Text the players", before: "—", after: `${sent} sent · ${failed} failed · ${skipped} skipped` },
        { key: "message", field: "Message (as written)", before: "—", after: a.message },
      ],
    });
  } catch (e) { console.error("[credit-all] text log insert failed (texts already sent):", e instanceof Error ? e.message : e); }
  console.log(`[credit-all] text match=${a.view.matchId} players=${ids.length} sent=${sent} failed=${failed} skipped=${skipped}`);
  return { sent, failed, skipped, reasons };
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
