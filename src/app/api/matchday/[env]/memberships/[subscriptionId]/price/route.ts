// RE-PRICE A MEMBERSHIP.
//
//   PATCH /admin/subscriptions/{userSubscriptionId}   -> updateSubscriptionPrice (service :582)
//   body  { price }   CENTS. update-subscription-dto is @IsNumber() and NOTHING ELSE — no @Min,
//                     no @IsInt — so zero, negative and fractional cents all pass the API.
//                     Every guard on this number is ours.
//
// THE ID IS THE NUMERIC userSubscriptions.id, through ParseIntPipe. The Stripe `sub_…` string is
// not accepted, which is why playerProfile now carries both.
//
// TWO BRANCHES INSIDE THE API, and they are not the same write:
//   ADDED_FROM_ADMIN -> a new recurring price is minted and the row's amount/stripePriceId change
//                       LOCALLY. There is no Stripe subscription to update, so no charge moves.
//   otherwise        -> updateUserSubscriptionPrice -> stripe.subscriptions.update with
//                       proration_behavior:'none' (stripe.service :171). The current period is
//                       neither re-charged nor refunded.
//
// AND IT HAS NO STATUS FILTER AND NO deletedAt FILTER. It will reprice a CANCELED row and answer
// `true`. That refusal is ours — see priceRefusal.
import { randomUUID } from "node:crypto";

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { priceRefusal, verdictSentence, verdictLogValue, dollarsFromCents, isComp } from "@/lib/membershipAdminModel";
import { isEnv, membershipById, confinementRefusal, readPlayer, verdictFrom } from "@/lib/membershipRouteCommon";
import type { Change } from "@/lib/changeLogModel";
import { errToResponse } from "@/lib/membershipRouteErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = { playerId?: number; cents?: number; playerName?: string; saveId?: string; source?: string };

export async function PATCH(req: Request, ctx: { params: Promise<{ env: string; subscriptionId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { env, subscriptionId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(subscriptionId)) return Response.json({ error: "subscriptionId must be numeric" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const playerId = Number(body?.playerId);
  if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
  const cents = Number(body?.cents);

  if (!auth.canEditMemberships) {
    console.warn(`[memberships] 403: ${auth.email} attempted to re-price subscription ${subscriptionId} without EDIT MEMBERSHIPS`);
    return Response.json({ error: "You do not hold EDIT MEMBERSHIPS. Changing a membership price requires it." }, { status: 403 });
  }

  const subId = Number(subscriptionId);
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canEditMemberships: auth.canEditMemberships, email: auth.email, userId: auth.appUserId };

  try {
    const playerRaw = await readPlayer(env, playerId);
    const refused = await confinementRefusal(env, auth.confinedCity, playerId, playerRaw);
    if (refused) {
      console.warn(`[memberships] 403: ${auth.email} (confined to ${auth.confinedCity}) tried to re-price ${subId} on player ${playerId}`);
      return Response.json({ error: refused }, { status: 403 });
    }

    const before = membershipById(playerRaw, subId);
    if (!before) return Response.json({ error: `Subscription ${subId} is not on player ${playerId}'s record.` }, { status: 404 });

    // OURS, NOT THE API'S: closed rows, non-integers, negatives and no-ops.
    const why = priceRefusal(before, cents);
    if (why) return Response.json({ error: why }, { status: 409 });

    const path = `/admin/subscriptions/${subId}`;
    const writeBody = { price: cents };

    const readResource = async (): Promise<Record<string, unknown>> => {
      const r = await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>));
      const m = membershipById(r, subId);
      return { price: m?.price ?? null, statusRaw: m?.statusRaw ?? null, stripeSubscriptionId: m?.stripeSubscriptionId ?? null };
    };
    // `true` COMES BACK EITHER WAY. The row's amount is what says it landed.
    const applied = (_b: Record<string, unknown>, a: Record<string, unknown>): boolean => Number(a.price) === cents;

    const changes: Change[] = [{
      key: "membershipPrice",
      field: `Membership ${subId} price`,
      before: `$${dollarsFromCents(before.price)} (${before.price ?? 0} cents)`,
      after: `$${dollarsFromCents(cents)} (${cents} cents)`,
    }];

    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: body?.source || "Player Lookup", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(),
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        method: "PATCH", path, body: writeBody, keys: ["price"], label: (k) => k, applied, changes,
      },
      { readResource, write: () => apiWrite(env, "PATCH", path, writeBody, actor, "memberships"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = membershipById(await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>)), subId);
    const rowMoved = (after?.price ?? null) === cents;

    /* ── THE SECOND READ. This is what stops the Stripe half being inferred ──────────────────
     * MatchDay swallows a Stripe failure and writes its own amount regardless, so the row alone
     * cannot say whether the player's charge changed. A comp has no subscription and reports
     * "absent" rather than a false alarm. */
    const verdict = await verdictFrom(
      rowMoved,
      isComp(before) ? null : before.stripeSubscriptionId,
      (s) => s.unitAmount === cents,
    );

    // BOTH FACTS INTO THE LOG, not just ours.
    await recordWrite(
      {
        env, source: "Player Lookup — Stripe check", actorName: auth.email, actorEmail: auth.email,
        saveId: `${body?.saveId || subId}-stripe`,
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        method: "PATCH", path: `${path}#stripe-verify`, body: {}, keys: [], label: (k) => k,
        applied: () => true,
        changes: [{ key: "stripeCheck", field: `Stripe after re-pricing ${subId}`, before: "—", after: verdictLogValue(verdict) }],
      },
      { readResource: async () => ({}), write: async () => ({}), now: () => new Date().toISOString() },
      supabaseLogStore(),
    ).catch(() => undefined);

    const landed = outcome === "landed";
    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed,
      status: landed ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN",
      verdict, message: verdictSentence(verdict, "price"),
      membership: after,
    });
  } catch (e) { return errToResponse(e); }
}
