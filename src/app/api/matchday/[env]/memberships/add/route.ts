// ADD A MEMBERSHIP — the comp, or the real $0 subscription. Two endpoints, not two flavours.
//
// THE TWO ARE DIFFERENT OBJECTS AND THE PATH IS THE ONLY THING THAT SAYS WHICH (backend,
// src/core/subscriptions/admin-subscriptions.controller.ts:59 and :69 — NEITHER TAKES A BODY):
//   POST /admin/subscriptions/users/{userId}        -> subscribeSpecificUser      (service :440)
//        status ADDED_FROM_ADMIN, amount = the CITY PLAN price, NO Stripe object of any kind.
//   POST /admin/subscriptions/users/{userId}/free   -> subscribeSpecificUserFree  (service :476)
//        a real Stripe customer, a $0 recurring price and a real subscription. status ACTIVE.
//
// Both throw USER_ALREADY_SUBSCRIBED on `status in (ACTIVE, ADDED_FROM_ADMIN)`. A CANCELED row
// blocks NEITHER, so a closed membership can be reopened — that is the API's rule, checked here on
// the server's own copy of the player so the operator gets a sentence instead of a 403 body.
//
// NOT ON DENY_WRITE_ENDPOINTS, deliberately: that list is for calls that must never fire without a
// named unlock, and this is meant to be used daily.
import { randomUUID } from "node:crypto";

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { actionsFor, addApplied, addPathFor, COMP_ADD_ENABLED, COMP_DISABLED_REASON, type AddKind } from "@/lib/membershipAdminModel";
import { isEnv, membershipOf, confinementRefusal, readPlayer } from "@/lib/membershipRouteCommon";
import type { Change } from "@/lib/changeLogModel";
import { errToResponse } from "@/lib/membershipRouteErrors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = { playerId?: number; kind?: string; playerName?: string; saveId?: string; source?: string };

export async function POST(req: Request, ctx: { params: Promise<{ env: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { env } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Body | null;
  const playerId = Number(body?.playerId);
  if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
  const kind: AddKind = body?.kind === "comp" ? "comp" : "free";
  /* REFUSED AT THE ROUTE, NOT ONLY IN THE UI. A disabled button is a courtesy; this is the rule,
   * and it is here because the row this creates cannot afterwards be read, priced or ended. */
  if (kind === "comp" && !COMP_ADD_ENABLED) {
    return Response.json({ error: COMP_DISABLED_REASON }, { status: 409 });
  }

  // EDIT MEMBERSHIPS, BEFORE ANY MATCHDAY CALL, so a caller without it produces zero outbound
  // requests. apiWrite re-checks with requires:"memberships"; this early return is what makes it free.
  if (!auth.canEditMemberships) {
    console.warn(`[memberships] 403: ${auth.email} attempted to add a membership for player ${playerId} without EDIT MEMBERSHIPS`);
    return Response.json({ error: "You do not hold EDIT MEMBERSHIPS. Adding a membership requires it." }, { status: 403 });
  }

  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canEditMemberships: auth.canEditMemberships, email: auth.email, userId: auth.appUserId };

  try {
    const playerRaw = await readPlayer(env, playerId);
    const refused = await confinementRefusal(env, auth.confinedCity, playerId, playerRaw);
    if (refused) {
      console.warn(`[memberships] 403: ${auth.email} (confined to ${auth.confinedCity}) tried to add a membership for player ${playerId}`);
      return Response.json({ error: refused }, { status: 403 });
    }

    /* THE API'S OWN RULE, APPLIED BEFORE CALLING OUT. USER_ALREADY_SUBSCRIBED comes back as a 403
     * body nobody can act on; this turns it into the sentence the operator needs. */
    const before = membershipOf(playerRaw);
    const allowed = actionsFor(before);
    if (!allowed.add) {
      return Response.json({ error: "This player already holds a membership. End it before adding another." }, { status: 409 });
    }

    const path = addPathFor(playerId, kind);
    const readResource = async (): Promise<Record<string, unknown>> => {
      const r = await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>));
      const m = membershipOf(r);
      return { id: m?.id ?? null, statusRaw: m?.statusRaw ?? null, price: m?.price ?? null, stripeSubscriptionId: m?.stripeSubscriptionId ?? null };
    };
    /* BOTH ENDPOINTS RETURN `true` UNCONDITIONALLY, so the status code proves nothing. The row is
     * read back and the STATUS decides: ADDED_FROM_ADMIN for a comp, ACTIVE for the free one. */
    const applied = (_b: Record<string, unknown>, a: Record<string, unknown>): boolean =>
      addApplied({ id: a.id as number | null, statusRaw: a.statusRaw as string | null, stripeSubscriptionId: null, canceledAt: null, price: a.price as number | null }, kind);

    const changes: Change[] = [{
      key: "addMembership",
      field: kind === "comp" ? "Add membership (comp — no Stripe subscription)" : "Add membership (free — real $0 Stripe subscription)",
      before: before ? `${before.statusRaw ?? "none"}` : "not a member",
      after: kind === "comp" ? "ADDED_FROM_ADMIN at the city plan price — nothing is charged" : "ACTIVE at $0.00 — a real subscription that never charges",
    }];

    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: body?.source || "Player Lookup", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(),
        // The PLAYER is the subject. No name, phone or email beyond the label the caller already sees.
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        method: "POST", path, body: {}, keys: [], label: (k) => k, applied, changes,
      },
      // ONE ATTEMPT, NO RETRY. There is no Idempotency-Key on this API and a duplicate membership
      // is visible to a player.
      { readResource, write: () => apiWrite(env, "POST", path, undefined, actor, "memberships"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    const after = membershipOf(await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>)));
    const landed = outcome === "landed";
    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed,
      status: landed ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : "UNKNOWN",
      kind,
      membership: after,
      // NOTHING HERE CLAIMS A CHARGE. Neither add bills anybody, and both are excluded from paid
      // member counts by membershipStats' price_cents rule.
      note: kind === "comp"
        ? "A comp has no Stripe subscription. Nothing will ever be charged, and it does not appear on any Membership page — the mirror does not carry ADDED_FROM_ADMIN."
        : "A real Stripe subscription at $0.00. It renews and can fail like any other, but never charges, and it does not count as a paid member.",
    });
  } catch (e) { return errToResponse(e); }
}
