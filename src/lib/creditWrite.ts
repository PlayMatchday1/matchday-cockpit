// THE CREDIT WRITE ITSELF, from the balance read to the logged PUT. The credit route gates it for a
// signed-in person; the auto-send tick (src/lib/aiDraftAutoRun.ts) calls it with a system actor. The
// route stays closed to the cron secret: only this function is shared, never the route's door.
//
// WHAT PART 0 PROVED (see docs/matchday-api-facts.md): creditAmount is CENTS, and the write is PUT
// /admin/players/{id}/profile { creditAmount }, an ABSOLUTE SET. So the amount is computed here from a
// fresh read, the balance is race-checked against the one the caller saw, one attempt only, and every
// change goes through recordWrite with before, after, delta and the reason. Player ID only: never a
// name, phone or email.

import { randomUUID } from "node:crypto";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { raceCheck, fmtUsd } from "@/lib/creditsModel";
import type { Change } from "@/lib/changeLogModel";

export type WriteAnswer = { status: number; json: Record<string, unknown> };
export type SystemOrPerson = { email: string; userId: string };

export const balanceOf = (p: Record<string, unknown>): number => {
  const n = Number(p?.creditAmount);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

export async function applyCreditAdjustment(a: {
  env: MatchdayEnv; playerId: string; deltaCents: number; expectedBeforeCents: number; reason: string; source: string;
  actor: SystemOrPerson;
  /** The caller's boundary, asked on the same read the race check uses. Returns an error to refuse. */
  boundary?: (player: Record<string, unknown>) => Promise<string | null>;
}): Promise<WriteAnswer> {
  const { env, playerId, reason, source } = a;
  const delta = a.deltaCents, expected = a.expectedBeforeCents;
  try {
    // ── THE RACE. Re-read IMMEDIATELY before writing. The endpoint is an absolute set, so if the player
    // spent something since the balance was seen, `expected + delta` would put the spend back. Abort
    // rather than re-base.
    const player = await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`);
    const refused = a.boundary ? await a.boundary(player) : null;
    if (refused) return { status: 403, json: { error: refused } };
    const before = balanceOf(player);
    const race = raceCheck(expected, before);
    if (!race.ok) return { status: 409, json: { error: race.error, aborted: true, balanceCents: before, landed: false, outcome: "NOT APPLIED" } };
    const after = before + delta;
    if (after < 0) return { status: 400, json: { error: `That would take the balance to ${fmtUsd(after)}. Clubhouse does not send a negative balance.` } };

    // ── The audit record. PLAYER ID ONLY. The REASON is the point of it.
    const changes: Change[] = [
      { key: "creditAmount", field: "Credit balance", before, after },
      { key: "delta", field: "Adjustment", before: "—", after: `${delta > 0 ? "+" : ""}${delta} cents (${fmtUsd(delta)})` },
      { key: "reason", field: "Reason", before: "—", after: reason },
    ];

    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source, actorName: a.actor.email, actorEmail: a.actor.email,
        saveId: randomUUID(), matchId: null, matchName: null,
        // NOTE the target: the player, by ID. Nothing identifying beyond the number.
        method: "PUT", path: `/admin/players/${playerId}/profile`, body: { creditAmount: after },
        keys: ["creditAmount"], label: (k) => (k === "creditAmount" ? "Credit balance" : k),
        // The verdict comes from a RE-READ of the balance, never from the status code.
        applied: (_b, aft) => balanceOf((aft.player as Record<string, unknown>) ?? {}) === after,
        changes,
      },
      {
        readResource: async () => ({ player: await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`).catch(() => ({})) }),
        // ── ONE ATTEMPT. apiWrite is single-shot and never retries; recordWrite calls this once.
        // "credits" hits the chokepoint guard, so a caller that forgot its own check is still stopped.
        write: () => apiWrite(env, "PUT", `/admin/players/${playerId}/profile`, { creditAmount: after },
          { canEditMatches: false, canEditCredits: true, email: a.actor.email, userId: a.actor.userId }, "credits"),
        now: () => new Date().toISOString(),
      },
      supabaseLogStore(),
    );
    if (error) return creditErrorAnswer(error);

    // Report the TRUE balance from a final read, not from what we hoped to set.
    const fresh = balanceOf(await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`).catch(() => ({})));
    const landed = outcome === "landed";
    return {
      status: 200,
      json: {
        ok: true, landed, outcome: landed ? "LANDED" : "NOT APPLIED",
        beforeCents: before, intendedAfterCents: after, balanceCents: fresh, deltaCents: delta,
        logRecorded: logged, result,
      },
    };
  } catch (e) { return creditErrorAnswer(e); }
}

export function creditErrorAnswer(e: unknown): WriteAnswer {
  if (e instanceof NotAuthorizedError) return { status: 403, json: { error: e.message, landed: false, outcome: "NOT APPLIED" } };
  // AMBIGUOUS is its own fact and must never read as a clean failure: the write may have landed.
  if (e instanceof AmbiguousWriteError) return { status: 502, json: { error: e.message, ambiguous: true, outcome: "UNKNOWN" } };
  if (e instanceof ProductionWriteBoltedError) return { status: 503, json: { error: e.message, landed: false, outcome: "NOT APPLIED" } };
  if (e instanceof DeniedEndpointError) return { status: 403, json: { error: e.message } };
  if (e instanceof DeniedFieldError) return { status: 400, json: { error: e.message } };
  if (e instanceof StageHostGuardError) return { status: 500, json: { error: e.message } };
  if (e instanceof WriteFailedError) return { status: e.status >= 400 && e.status < 600 ? e.status : 400, json: { error: e.message, landed: false, outcome: "FAILED" } };
  if (e instanceof StageConfigError) return { status: 500, json: { error: e.message } };
  return { status: 500, json: { error: e instanceof Error ? e.message : String(e), outcome: "UNKNOWN" } };
}
