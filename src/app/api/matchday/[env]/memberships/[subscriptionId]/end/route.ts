// END A MEMBERSHIP.
//
//   POST /admin/subscriptions/{userSubscriptionId}/unsubscribe -> unsubscribeForAdmin (service :566)
//   body { reason }   cancel-subscription-dto is @IsString() ONLY, so "" passes the API.
//                     The non-empty requirement is ours, and it is the only record of why a
//                     paying member was cancelled. Retool sends the literal "Removed by Retool".
//
// WHAT ENDING MEANS HERE, AND IT IS NOT WHAT THE CARD USED TO SAY:
//   unsubscribeForAdmin matches { id, status != CANCELED, deletedAt: null } and RETURNS FALSE on no
//   match — on a 2xx. Then cancelSubscriptionsForAdmin (service :647), per row:
//     - if stripeSubscriptionId is set -> stripe.subscriptions.cancel(id)  IMMEDIATE (stripe :220)
//     - writes canceledAt, cancelReason AND status: CANCELED
//   There is no proration and no refund. The unused part of a paid period is simply not returned.
//
//   The PLAYER's own path (cancelSubscriptions, service :635) is a different animal: it writes
//   canceledAt and cancelReason only, sets no status and calls NO Stripe. cancel_at_period_end is
//   set later by the invoice.paid WEBHOOK (stripe :633), conditional on another invoice being paid.
//   So "they keep it to the period end" is true of the player's cancellation and NOT of this one.
//
// A PLAYER-CANCELLED ROW IS STILL ENDABLE — its status is still ACTIVE, so `status != CANCELED`
// matches it.
import { randomUUID } from "node:crypto";

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { endRefusal, verdictSentence, verdictLogValue, isComp, dollarsFromCents } from "@/lib/membershipAdminModel";
import { isEnv, membershipById, confinementRefusal, readPlayer, verdictFrom } from "@/lib/membershipRouteCommon";
import type { Change } from "@/lib/changeLogModel";
import { errToResponse } from "@/lib/membershipRouteErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = { playerId?: number; reason?: string; playerName?: string; saveId?: string; source?: string };

export async function POST(req: Request, ctx: { params: Promise<{ env: string; subscriptionId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { env, subscriptionId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(subscriptionId)) return Response.json({ error: "subscriptionId must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const playerId = Number(body?.playerId);
  if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
  const reason = (body?.reason ?? "").trim();

  if (!auth.canEditMemberships) {
    console.warn(`[memberships] 403: ${auth.email} attempted to end subscription ${subscriptionId} without EDIT MEMBERSHIPS`);
    return Response.json({ error: "You do not hold EDIT MEMBERSHIPS. Ending a membership requires it." }, { status: 403 });
  }

  const subId = Number(subscriptionId);
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canEditMemberships: auth.canEditMemberships, email: auth.email, userId: auth.appUserId };

  try {
    const playerRaw = await readPlayer(env, playerId);
    const refused = await confinementRefusal(env, auth.confinedCity, playerId, playerRaw);
    if (refused) {
      console.warn(`[memberships] 403: ${auth.email} (confined to ${auth.confinedCity}) tried to end ${subId} on player ${playerId}`);
      return Response.json({ error: refused }, { status: 403 });
    }

    const before = membershipById(playerRaw, subId);
    if (!before) return Response.json({ error: `Subscription ${subId} is not on player ${playerId}'s record.` }, { status: 404 });

    // THE EMPTY-REASON REFUSAL IS OURS. @IsString() alone would take "".
    const why = endRefusal(before, reason);
    if (why) return Response.json({ error: why }, { status: why.startsWith("A reason") ? 400 : 409 });

    const path = `/admin/subscriptions/${subId}/unsubscribe`;
    const writeBody = { reason };

    const readResource = async (): Promise<Record<string, unknown>> => {
      const r = await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>));
      const m = membershipById(r, subId);
      return { present: m != null, statusRaw: m?.statusRaw ?? null, canceledAt: m?.canceledAt ?? null };
    };
    /* ── WHAT "IT LANDED" MEANS HERE, AND WHY IT IS AN ABSENCE ───────────────────────────────
     * MEASURED ON STAGING, not assumed. `false` comes back on a 2xx when nothing matched, so the
     * status code proves nothing — but reading the status back does not work either, because
     * GET /admin/players/{id} does NOT return the row once it is cancelled:
     *
     *     users.repository.ts — include: { userSubscriptions: {
     *       where: { status: { in: [ACTIVE] }, currentPeriodEnd: { gte: new Date() } } } }
     *
     * So a successful end makes the row VANISH from the only payload we can read. Checking for
     * `statusRaw === "CANCELED"` can therefore never be true and reported NOT APPLIED on a write
     * that had plainly landed — the strikes route made the same mistake in the same direction.
     *
     * THE OBSERVABLE SIGNAL IS PRESENCE THEN ABSENCE. The include filter has exactly two terms; the
     * period cannot expire inside one request, so a row that was there before and is gone after
     * left ACTIVE. That is the end. The CANCELED branch is kept because it is the honest reading if
     * the filter is ever widened. */
    const applied = (b: Record<string, unknown>, a: Record<string, unknown>): boolean =>
      String(a.statusRaw ?? "").toUpperCase() === "CANCELED"
      || (b.present === true && a.present === false);

    const changes: Change[] = [{
      key: "endMembership",
      field: `End membership ${subId}${before.price ? ` ($${dollarsFromCents(before.price)})` : ""}`,
      before: `${before.statusRaw ?? "unknown"}${before.canceledAt ? " (player had already cancelled)" : ""}`,
      after: `CANCELED — ${reason}`,
    }];

    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: body?.source || "Player Lookup", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(),
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        method: "POST", path, body: writeBody, keys: [], label: (k) => k, applied, changes,
      },
      { readResource, write: () => apiWrite(env, "POST", path, writeBody, actor, "memberships"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = membershipById(await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>)), subId);
    // SAME RULE AS `applied`: gone from the payload is the end, because the include filter drops it.
    const rowMoved = String(after?.statusRaw ?? "").toUpperCase() === "CANCELED" || after == null;

    /* ── THE SECOND READ, AND ON THIS ROUTE IT IS THE WHOLE POINT ────────────────────────────
     * cancelSubscriptionsForAdmin catches a Stripe failure into a bare `// TODO` and marks the row
     * CANCELED anyway. A row reading CANCELED is therefore NOT evidence that billing stopped. Read
     * Stripe and report it separately; a comp has no subscription and reports "absent". */
    const verdict = await verdictFrom(
      rowMoved,
      isComp(before) ? null : before.stripeSubscriptionId,
      (s) => s.status === "canceled",
    );

    await recordWrite(
      {
        env, source: "Player Lookup — Stripe check", actorName: auth.email, actorEmail: auth.email,
        saveId: `${body?.saveId || subId}-stripe`,
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        method: "POST", path: `${path}#stripe-verify`, body: {}, keys: [], label: (k) => k,
        applied: () => true,
        changes: [{ key: "stripeCheck", field: `Stripe after ending ${subId}`, before: "—", after: verdictLogValue(verdict) }],
      },
      { readResource: async () => ({}), write: async () => ({}), now: () => new Date().toISOString() },
      supabaseLogStore(),
    ).catch(() => undefined);

    const landed = outcome === "landed";
    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed,
      status: landed ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN",
      verdict, message: verdictSentence(verdict, "end"),
      membership: after,
    });
  } catch (e) { return errToResponse(e); }
}
