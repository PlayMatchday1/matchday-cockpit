// SAVE A MEMBERSHIP COMMENT.
//
//   PUT /api/v1/admin/user-subscriptions/{userSubscriptionId}  { comment }
//       -> updateUserSubscriptionComment (subscriptions.service.ts:518-522 at backend 8965437)
//       Stored in user_subscriptions.comment (TEXT). The ONE membership route under /api/v1.
//
// A 2xx IS NOT PROOF. The repository's updateById catches every error and returns null
// (user-subscriptions.repository.ts:123-131), so a failed write answers 2xx with an empty body.
// The read-back is GET /admin/players/{id}, whose include keeps only ACTIVE memberships with an
// unexpired period (users.repository.ts:478-487): for anyone else the comment cannot be read back and
// the outcome is UNKNOWN, said so, never LANDED.
//
// TWO RULES OF OURS (membersPageModel.commentRefusal): an empty box is refused — clearing is not a
// change, and Retool's box wipes stored comments exactly that way — and a no-op is not sent.
//
// THE COMMENT TEXT IS NOT LOGGED. It is a staff note about a player; change_log gets its length.
// The write itself carries the real text.
import { randomUUID } from "node:crypto";
import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { apiWrite } from "@/lib/matchdayStageApi";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import { isEnv, confinementRefusal, readPlayer } from "@/lib/membershipRouteCommon";
import { errToResponse } from "@/lib/membershipRouteErrors";
import { makeServerClient } from "@/lib/supabaseServer";
import { loadMemberRows, dropMemberCache } from "@/lib/membersPageData";
import { commentRefusal } from "@/lib/membersPageModel";
import type { Change } from "@/lib/changeLogModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Body = { playerId?: number; comment?: string; playerName?: string; saveId?: string; source?: string };

/** The comment on one membership off a raw player payload, or `present: false` when the include
 *  dropped the membership (so nothing can be said about its comment). */
function commentOf(playerRaw: Record<string, unknown>, subId: number): { present: boolean; comment: string | null } {
  const d = (playerRaw && typeof playerRaw === "object" && "data" in playerRaw ? (playerRaw.data as Record<string, unknown>) : playerRaw) ?? {};
  const subs = Array.isArray((d as Record<string, unknown>).userSubscriptions) ? ((d as Record<string, unknown>).userSubscriptions as Record<string, unknown>[]) : [];
  const m = subs.find((s) => Number(s.id) === subId);
  return m ? { present: true, comment: typeof m.comment === "string" ? m.comment : null } : { present: false, comment: null };
}

export async function PUT(req: Request, ctx: { params: Promise<{ env: string; subscriptionId: string }> }) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const { env, subscriptionId } = await ctx.params;
  if (!isEnv(env)) return Response.json({ error: `unknown environment ${JSON.stringify(env)}` }, { status: 400 });
  if (!/^\d+$/.test(subscriptionId)) return Response.json({ error: "subscriptionId must be numeric" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Body | null;
  const playerId = Number(body?.playerId);
  if (!Number.isFinite(playerId)) return Response.json({ error: "playerId required" }, { status: 400 });
  const text = (body?.comment ?? "").trim();

  if (!auth.canEditMemberships) {
    console.warn(`[memberships] 403: ${auth.email} attempted to save a comment on ${subscriptionId} without EDIT MEMBERSHIPS`);
    return Response.json({ error: "You do not hold EDIT MEMBERSHIPS. Saving a member comment requires it." }, { status: 403 });
  }
  const subId = Number(subscriptionId);
  const actor = { canEditMatches: auth.canEditMatches, canManagePlayers: auth.canManagePlayers, canEditMemberships: auth.canEditMemberships, email: auth.email, userId: auth.appUserId };
  const sb = makeServerClient();

  try {
    // THE STORED COMMENT IS OURS TO COMPARE AGAINST — the list row, not the player read, which drops
    // memberships it does not consider current and would make every comment look empty.
    const { rows } = await loadMemberRows(env, sb, true);
    const row = rows.find((r) => r.membershipId === subId) ?? null;
    if (!row || row.userId !== playerId) return Response.json({ error: `Membership ${subId} is not player ${playerId}'s.` }, { status: 404 });

    const why = commentRefusal(text, row.comment);
    if (why) return Response.json({ error: why }, { status: why.startsWith("A comment can't") ? 400 : 409 });

    const playerRaw = await readPlayer(env, playerId);
    const refused = await confinementRefusal(env, auth.confinedCity, playerId, playerRaw);
    if (refused) return Response.json({ error: refused }, { status: 403 });

    const path = `/api/v1/admin/user-subscriptions/${subId}`;
    const sendBody = { comment: text };
    const readResource = async (): Promise<Record<string, unknown>> => {
      const r = await readPlayer(env, playerId).catch(() => ({} as Record<string, unknown>));
      return commentOf(r, subId);
    };
    const applied = (_b: Record<string, unknown>, a: Record<string, unknown>): boolean | "unknown" =>
      a.present === true ? (typeof a.comment === "string" && a.comment.trim() === text) : "unknown";

    const changes: Change[] = [{
      key: "comment", field: `Membership ${subId} comment`,
      before: row.comment ? `(${row.comment.trim().length} characters)` : "(none)",
      after: `(${text.length} characters)`,
    }];
    const { result, error, outcome, logged } = await recordWrite(
      {
        env, source: body?.source || "Members", actorName: auth.email, actorEmail: auth.email,
        saveId: body?.saveId || randomUUID(),
        matchId: playerId, matchName: body?.playerName ?? `player ${playerId}`,
        // THE LOGGED BODY IS A LENGTH, NOT THE NOTE.
        method: "PUT", path, body: { comment: `(${text.length} characters)` }, keys: [], label: (k) => k, applied, changes,
      },
      { readResource, write: () => apiWrite(env, "PUT", path, sendBody, actor, "memberships"), now: () => new Date().toISOString() },
      supabaseLogStore(),
    );
    if (error) return errToResponse(error);

    /* THE MIRROR, REFRESHED ON A LANDED WRITE ONLY. mdapi_subscriptions is re-synced daily; without
     * this the page would show the old comment until then. Never on unknown or not-applied. */
    if (outcome === "landed" && env === "production") {
      await sb.from("mdapi_subscriptions").update({ comment: text }).eq("membership_id", subId);
    }
    dropMemberCache(env);

    return Response.json({
      ok: true, result, outcome, logRecorded: logged, landed: outcome === "landed",
      status: outcome === "landed" ? "LANDED" : outcome === "notapplied" ? "NOT APPLIED" : outcome === "unknown" ? "UNKNOWN" : "FAILED",
      row: outcome === "landed" ? "moved" : outcome === "notapplied" ? "unchanged" : "unknown",
    });
  } catch (e) { return errToResponse(e); }
}
