// Remove one strike log from a member's record.
//
// WHY THIS EXISTS. Ryan: "on the player lookup you are suppose to be able to remove strikes in case
// we need to or they are accidental thought we had done it but dont see it". It was never built —
// StrikePanel's own footer said so. Retool can do it, and does it with one click, no confirm, and
// no record of why a penalty against a paying member was reversed. That last part is the whole
// argument for building it here instead: a required reason, into the change log, with the actor.
//
// THE ENDPOINT, READ OUT OF retool-export-prod.json (query `removeStrike`), not guessed:
//   DELETE {serverApiUrl}/admin/strikes/strike-logs/{strikeLog.id}
//   body   { userId, matchId }   <- matchId is the USER-MATCH row id, not the match id, despite the
//                                   key. Retool sends membershipUserMatchDetails.selectedRow.data.id.
//   queryTimeout 10000, requireConfirmation false, and on success it re-runs the profile read.
//
// /admin/strikes/ IS NOT ON DENY_WRITE_ENDPOINTS — that list holds only DELETE /admin/matches/{id}
// and the refund-and-cancel PATCH — so this needs no unlock and matchdayStageApi.ts is untouched.
//
// THE GATE IS THE ONE THE OTHER PLAYER LOOKUP PENALTY WRITE USES. Suspend / expel / lift go through
// authenticateMatchOpsRead plus an explicit canManagePlayers check, with apiWrite carrying
// requires:"manage" as the unbypassable chokepoint. A strike is the same kind of action on the same
// kind of subject, so it takes the same authority rather than a new one.
//
// (write-routes-logged-test scans raw lines for the call, so naming it with its bracket in prose
// reads to that guard as an unlogged write. Left worded this way on purpose.)
import { randomUUID } from "node:crypto";

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiGet, apiWrite, AmbiguousWriteError, WriteFailedError, DeniedFieldError, DeniedEndpointError, ProductionWriteBoltedError, StageHostGuardError, StageConfigError, NotAuthorizedError, type MatchdayEnv } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { CONFINED_CITY_ERROR, playerCityAllowed } from "@/lib/cityConfinement";
import { strikeControl, removalEffect, strikeRemovalApplied, STRIKE_LIMIT } from "@/lib/playerLookupModel";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const isEnv = (x: string): x is MatchdayEnv => x === "staging" || x === "production";

type Body = { playerId?: number; userMatchId?: number | null; reason?: string; playerName?: string; saveId?: string; source?: string };

/** The strike block off a player payload, in the shape the decision needs. */
function strikeOf(p: Record<string, unknown>): {
  activeStrikes: number; isSuspended: boolean; expiredAt: string | null;
  logs: { id: number | null; userMatchId: number | null; penaltyPoint: number; active: boolean }[];
} {
  const d = (p && typeof p === "object" && "data" in p ? (p.data as Record<string, unknown>) : p) ?? {};
  const s = ((d as Record<string, unknown>).strike as Record<string, unknown> | undefined) ?? {};
  const n = (v: unknown): number | null => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const raw = Array.isArray(s.strikeLogs) ? (s.strikeLogs as Record<string, unknown>[]) : [];
  return {
    activeStrikes: n(s.activeStrikes) ?? 0,
    isSuspended: s.isSuspended === true,
    expiredAt: typeof s.expiredAt === "string" ? s.expiredAt : null,
    logs: raw.map((l) => ({
      id: n(l.id), userMatchId: n(l.userMatchId),
      penaltyPoint: n(l.penaltyPoint) ?? 0, active: l.active === true,
    })),
  };
}

export async function DELETE(req: Request, ctx: { params: Promise<{ env: string; strikeLogId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { env, strikeLogId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(strikeLogId)) return Response.json({ error: "strikeLogId must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const playerId = Number(body?.playerId);
  if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });

  // A REASON IS THE POINT OF THIS ROUTE. Whitespace is not a reason.
  const reason = (body?.reason ?? "").trim();
  if (!reason) {
    return Response.json({ error: "A reason is required — it is the only record of why this penalty was reversed." }, { status: 400 });
  }

  // MANAGE PLAYERS, before any MatchDay call, so a caller without it produces zero outbound
  // requests. apiWrite re-checks with requires:"manage"; this early return is what makes it free.
  if (!auth.canManagePlayers) {
    console.warn(`[manage-players] 403: ${auth.email} attempted to remove strike ${strikeLogId} on player ${playerId} without MANAGE PLAYERS`);
    return Response.json({ error: "You do not hold MANAGE PLAYERS. Removing a strike requires it." }, { status: 403 });
  }

  const logId = Number(strikeLogId);
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, email: auth.email, userId: auth.appUserId };

  try {
    const playerRaw = await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`);

    /* CONFINEMENT IS CHECKED ON THE SERVER'S COPY OF THE PLAYER, not on a list that happened not to
     * offer them. The id can be sent directly, so a Warsaw operator must be refused here and not
     * merely find the control absent from a page. */
    if (!playerCityAllowed(auth.confinedCity, playerRaw)) {
      console.warn(`[strikes] 403: ${auth.email} (confined to ${auth.confinedCity}) tried to remove strike ${logId} on player ${playerId}`);
      return Response.json({ error: CONFINED_CITY_ERROR }, { status: 403 });
    }

    const before = strikeOf(playerRaw);
    const log = before.logs.find((l) => l.id === logId) ?? null;
    if (!log) {
      return Response.json({ error: `Strike ${logId} is not on player ${playerId}'s record.` }, { status: 404 });
    }

    /* THE SAME REFUSAL THE UI SHOWS, ENFORCED HERE TOO. The control being disabled is a courtesy;
     * this is the rule. An expired or zero-point log is already off the total and removing it would
     * change nothing, so it is refused rather than sent. */
    const ctl = strikeControl(log, before.expiredAt);
    if (!ctl.enabled) {
      return Response.json({ error: `This strike cannot be removed: ${ctl.why}.`, label: ctl.label }, { status: 409 });
    }

    /* THE BODY IS RETOOL'S. `matchId` is the user-match row id; the client sends what it read off
     * the log, and the server prefers its own copy so a stale screen cannot redirect the write. */
    const userMatchId = log.userMatchId ?? (Number.isFinite(Number(body?.userMatchId)) ? Number(body?.userMatchId) : null);
    const path = `/admin/strikes/strike-logs/${logId}`;
    const writeBody: Record<string, unknown> = { userId: playerId, matchId: userMatchId };

    const readResource = async (): Promise<Record<string, unknown>> => {
      const r = await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`).catch(() => ({} as Record<string, unknown>));
      const s = strikeOf(r);
      const mine = s.logs.find((l) => l.id === logId) ?? null;
      return {
        activeStrikes: s.activeStrikes, isSuspended: s.isSuspended,
        present: mine != null, points: mine ? mine.penaltyPoint : null,
      };
    };
    /* WHAT "IT LANDED" MEANS, MEASURED ON STAGING RATHER THAN ASSUMED.
     *
     * The API does NOT delete the row. Removing log 614 on staging player 569 left it in place,
     * still active:true, with penaltyPoint moved 1 -> 0, and dropped the parent's activeStrikes
     * from 3 to 2. When the last points go the whole strike record disappears and the player's
     * strike block comes back with no strikeLogs key at all.
     *
     * So both shapes are the penalty reversed: the log is gone, or it is still there carrying zero.
     * The first version of this predicate checked only for absence and reported NOT APPLIED on a
     * write that had plainly landed — which is exactly the failure recordWrite exists to catch, in
     * the wrong direction. A 2xx on its own still proves nothing. */
    const applied = (_b: Record<string, unknown>, a: Record<string, unknown>): boolean =>
      strikeRemovalApplied({ present: a.present === true, points: a.points as number | null });

    const eff = removalEffect(before.activeStrikes, log.penaltyPoint, before.isSuspended, STRIKE_LIMIT);
    const changes: Change[] = [{
      key: "removeStrike",
      field: `Remove strike ${logId} (${log.penaltyPoint} point${log.penaltyPoint === 1 ? "" : "s"})`,
      before: `${before.activeStrikes} of ${STRIKE_LIMIT} points${before.isSuspended ? ", suspended" : ""}`,
      after: `${eff.after} of ${STRIKE_LIMIT} points — ${reason}`,
    }];

    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: body?.source || "Player Lookup", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(),
        // The player is the subject here, exactly as the ban route logs it. No name, phone or email
        // beyond the display label the caller already sees.
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        method: "DELETE", path, body: writeBody, keys: [], label: (k) => k, applied, changes,
      },
      { readResource, write: () => apiWrite(env, "DELETE", path, writeBody, actor, "manage"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = strikeOf(await apiGet<Record<string, unknown>>(env, `/admin/players/${playerId}`).catch(() => ({} as Record<string, unknown>)));
    const landed = outcome === "landed";
    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed,
      status: landed ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN",
      // The server's own numbers, so the client never has to compute one.
      before: { activeStrikes: before.activeStrikes, isSuspended: before.isSuspended },
      after: { activeStrikes: after.activeStrikes, isSuspended: after.isSuspended },
      promised: eff.after, penaltyPoint: log.penaltyPoint,
    });
  } catch (e) { return errToResponse(e); }
}

function errToResponse(e: unknown): Response {
  if (e instanceof NotAuthorizedError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof AmbiguousWriteError) return Response.json({ error: e.message, ambiguous: true }, { status: 502 });
  if (e instanceof ProductionWriteBoltedError) return Response.json({ error: e.message }, { status: 503 });
  if (e instanceof DeniedEndpointError) return Response.json({ error: e.message }, { status: 403 });
  if (e instanceof DeniedFieldError) return Response.json({ error: e.message }, { status: 400 });
  if (e instanceof StageHostGuardError) return Response.json({ error: e.message }, { status: 500 });
  if (e instanceof WriteFailedError) return Response.json({ error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 400 });
  if (e instanceof StageConfigError) return Response.json({ error: e.message }, { status: 500 });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
