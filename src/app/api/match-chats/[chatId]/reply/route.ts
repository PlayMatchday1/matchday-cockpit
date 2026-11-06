// POST /api/match-chats/[chatId]/reply — the desktop's reply to a match chat.
//
// The Firestore document is written as "MatchDay" (the shared system identity) so players see one
// voice; the operator who pressed Send is recorded in match_chat_audit_log. The write itself is
// src/lib/matchChatWrite.ts postMatchDayText, the ONE writer the staff app's chat route and the
// auto-posters share, so every Clubhouse message has the same document shape and the same audit row.
//
// Body: { body: string }
// Auth: authenticateCrm (Chats), the match's city through assertMatchInScope, and SENDING IS ITS
// OWN RIGHT (can_send_messages), on every send path (Ryan, 2026-10-30).
//
// Production only: the desktop reads the production mirror, so this chat is the production chat.
// The staff app's per-environment route (/api/app/{env}/matches/{id}/chat) takes the staging prefix.

import { localModeRefusal } from "@/lib/localMode";
import { authenticateCrm } from "@/lib/crmAuth";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import { isValidChatId } from "@/lib/matchChats";
import { MAX_BODY_LEN, postMatchDayText } from "@/lib/matchChatWrite";

export const runtime = "nodejs";
export const maxDuration = 15;

type ReplyBody = { body?: unknown };

type RouteCtx = { params: Promise<{ chatId: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  { const local = localModeRefusal("Match chat reply"); if (local) return local; }
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    // Match Chats replies require an operator identity.
    return Response.json(
      { error: "Operator identity required" },
      { status: 403 },
    );
  }

  const { chatId } = await ctx.params;

  /* THE CITY BOUNDARY ON A CHAT. A chatId IS a match api_id, so this is the SAME derivation the
   * match routes use — assertMatchInScope, one implementation, not a second rule that happens to
   * agree. Deny-by-default is the point: a chat whose match the mirror does not carry cannot be
   * proved in scope, so it is refused rather than served with a null match. Hiding a thread from
   * a list does not stop its id being typed. */
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, chatId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  // SENDING IS ITS OWN RIGHT (crmAuth canSendMessages), on every send path, not only /api/crm/send.
  // Ryan, 2026-10-30. Checked before anything is sent.
  if (!auth.canSendMessages) {
    return Response.json(
      { error: "You don't have permission to send messages.", reason: "no_send_permission" },
      { status: 403 },
    );
  }
  if (!chatId || !isValidChatId(chatId)) {
    return Response.json(
      { error: "chatId must be a numeric Firestore chat id" },
      { status: 400 },
    );
  }

  let parsed: ReplyBody;
  try {
    parsed = (await req.json()) as ReplyBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!body.trim()) {
    return Response.json({ error: "body required" }, { status: 400 });
  }
  if (body.length > MAX_BODY_LEN) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_LEN} chars` },
      { status: 400 },
    );
  }

  /* THE PLAYERS' "NEW MESSAGE" PUSH (Ryan, 2026-11-06), the one the player app asks for after a
   * player posts, asked for here after a MatchDay post, one per burst (matchChatPush.ts). The
   * desktop reads the production mirror, so the chat and the push are production's. A held or
   * failed push never fails the reply; the outcome is in the response. */
  const push = { env: "production" as const, matchId: chatId, actor: { canEditMatches: false, canSendMessages: auth.canSendMessages, email: auth.email ?? undefined, userId: appUserId } };
  const r = await postMatchDayText({ supabase, chatDocId: chatId, body, appUserId, tag: "match-chats:reply", push });
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });

  console.log(`[match-chats:reply] elapsed=${Date.now() - startedAt}ms`);
  return Response.json(
    {
      ok: true,
      firestore_doc_id: r.firestoreDocId,
      message_id: r.messageId,
      push: r.push,
    },
    { status: 200 },
  );
}
