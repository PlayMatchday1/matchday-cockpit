// Phase 27 — the credit ADJUSTMENT route. The only endpoint in Clubhouse that moves money into or
// out of a player's account, and it is built accordingly.
//
// GET  — the live balance + whether this caller may change it (drives the control, never gates it).
// POST — apply ONE adjustment: { deltaCents, expectedBeforeCents, reason }.
//
// WHAT PART 0 PROVED (see docs/matchday-api-facts.md):
//   • `creditAmount` is CENTS — 22 of 31 non-zero production balances are not multiples of 100.
//   • The write is PUT /admin/players/{id}/profile { creditAmount } and is an ABSOLUTE SET.
//     Retool sends only that one key, which is why PUT here has PATCH semantics like every other
//     PUT in this API — the diff IS the body, and nothing else on the profile is touched.
//
// THE FIVE RULES THIS ROUTE EXISTS TO ENFORCE:
//  1. EDIT CREDITS, read fresh from the database, and NOT implied by Match Ops (creditsAuth).
//     Checked here before any MatchDay call, and again inside apiWrite's unbypassable chokepoint.
//  2. THE CLIENT NEVER SENDS AN ABSOLUTE BALANCE. It sends a DELTA. The absolute value is computed
//     HERE from a fresh server-side read, so a stale or tampered screen cannot set a balance.
//  3. THE RACE IS CHECKED. Re-read immediately before writing; if the balance moved since the
//     screen was drawn, ABORT and report the new figure. Never re-base and continue.
//  4. ONE ATTEMPT. No retry, ever — if the API were a delta a retry would be a second grant, and
//     even for an absolute set a retry is an unnecessary second money movement.
//  5. EVERY change through recordWrite into change_log with before, after, delta and the REASON —
//     and the player ID only. Never a name, phone or email.

import { randomUUID } from "node:crypto";
import { authenticateCredits } from "@/lib/creditsAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { MAX_ADJUSTMENT_CENTS, raceCheck, fmtUsd } from "@/lib/creditsModel";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";
const balanceOf = (p: Record<string, unknown>): number => {
  const n = Number(p?.creditAmount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export async function GET(req: Request, ctx: { params: Promise<{ env: string; playerId: string }> }) {
  // The READ is gated on the same grant as the write. A balance is not secret, but there is no
  // reason to surface a money surface to someone who can never use it.
  const auth = await authenticateCredits(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, playerId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(playerId)) return Response.json({ error: "playerId must be numeric" }, { status: 400 });
  try {
    const p = await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`);
    return Response.json({ playerId: Number(playerId), balanceCents: balanceOf(p), canEditCredits: true });
  } catch (e) { return errToResponse(e); }
}

export async function POST(req: Request, ctx: { params: Promise<{ env: string; playerId: string }> }) {
  const auth = await authenticateCredits(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { env, playerId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(playerId)) return Response.json({ error: "playerId must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    { deltaCents?: unknown; expectedBeforeCents?: unknown; reason?: unknown; source?: unknown } | null;
  if (!body) return Response.json({ error: "body required" }, { status: 400 });

  const delta = Number(body.deltaCents);
  const expected = Number(body.expectedBeforeCents);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";

  // RE-VALIDATED SERVER-SIDE. The UI refuses all of these too, but a greyed button is a courtesy
  // and this is the control. Every one of these returns BEFORE any MatchDay call.
  if (!Number.isInteger(delta) || delta === 0) return Response.json({ error: "deltaCents must be a non-zero integer number of cents" }, { status: 400 });
  if (!Number.isInteger(expected)) return Response.json({ error: "expectedBeforeCents must be an integer number of cents" }, { status: 400 });
  if (Math.abs(delta) > MAX_ADJUSTMENT_CENTS) {
    return Response.json({ error: `${fmtUsd(Math.abs(delta))} is over the ${fmtUsd(MAX_ADJUSTMENT_CENTS)} single-adjustment limit.` }, { status: 400 });
  }
  if (reason.length < 3) return Response.json({ error: "A reason is required and is written to the change log." }, { status: 400 });

  try {
    // ── RULE 3 — THE RACE. Re-read IMMEDIATELY before writing. The endpoint is an absolute set,
    // so if the player spent something since the screen was drawn, `expected + delta` would put
    // the spend back. Abort rather than re-base: the operator chose a number against facts they
    // were shown, and quietly acting on different ones is not the same instruction.
    const before = balanceOf(await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`));
    const race = raceCheck(expected, before);
    if (!race.ok) {
      return Response.json({ error: race.error, aborted: true, balanceCents: before, landed: false, outcome: "NOT APPLIED" }, { status: 409 });
    }
    const after = before + delta;
    if (after < 0) return Response.json({ error: `That would take the balance to ${fmtUsd(after)}. Clubhouse does not send a negative balance.` }, { status: 400 });

    // ── RULE 5 — the audit record. PLAYER ID ONLY. No name, no phone, no email: change_log has
    // different access rules and a longer life than this screen. The REASON is the point of it.
    const changes: Change[] = [
      { key: "creditAmount", field: "Credit balance", before, after },
      { key: "delta", field: "Adjustment", before: "—", after: `${delta > 0 ? "+" : ""}${delta} cents (${fmtUsd(delta)})` },
      { key: "reason", field: "Reason", before: "—", after: reason },
    ];

    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: "Player Lookup · credits", actorName: auth.email, actorEmail: auth.email,
        saveId: randomUUID(), matchId: null, matchName: null,
        // NOTE the target: the player, by ID. Nothing identifying beyond the number.
        method: "PUT", path: `/admin/players/${playerId}/profile`, body: { creditAmount: after },
        keys: ["creditAmount"], label: (k) => (k === "creditAmount" ? "Credit balance" : k),
        // The verdict comes from a RE-READ of the balance, never from the status code.
        applied: (_b, a) => balanceOf((a.player as Record<string, unknown>) ?? {}) === after,
        changes,
      },
      {
        readResource: async () => ({ player: await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`).catch(() => ({})) }),
        // ── RULE 4 — ONE ATTEMPT. apiWrite is single-shot and never retries; this closure is
        // called once by recordWrite. `requires: "credits"` hits the chokepoint guard, so a route
        // that ever forgot its own check above is still stopped before any network call.
        write: () => apiWrite(env, "PUT", `/admin/players/${playerId}/profile`, { creditAmount: after },
          { canEditMatches: false, canEditCredits: true, email: auth.email, userId: auth.appUserId }, "credits"),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    // Report the TRUE balance from a final read, not from what we hoped to set.
    const fresh = balanceOf(await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`).catch(() => ({})));
    const landed = outcome === "landed";
    return Response.json({
      ok: true, landed, outcome: landed ? "LANDED" : "NOT APPLIED",
      beforeCents: before, intendedAfterCents: after, balanceCents: fresh, deltaCents: delta,
      logRecorded: logged, result,
    });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message, landed: false, outcome: "NOT APPLIED" }, { status: 403 });
  // AMBIGUOUS is its own fact and must never read as a clean failure: the write may have landed.
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true, outcome: "UNKNOWN" }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message, landed: false, outcome: "NOT APPLIED" }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message, landed: false, outcome: "FAILED" }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e), outcome: "UNKNOWN" }, { status: 500 });
}
