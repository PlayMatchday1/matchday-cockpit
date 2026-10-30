// GET /api/match-chats/[chatId]/messages — the newest messages of one match chat, oldest first.
//
// The desktop reads a match chat live from Firestore in the browser (ChatPane's onSnapshot). The
// staff app cannot hold Firebase credentials, so it reads the same Firestore path here, through the
// same admin client the reply route writes with. READ ONLY: nothing here writes Firestore or
// Supabase. Phone numbers and emails on the message's user block are dropped, not passed on.
//
// Auth: authenticateCrm (Chats), and the match's city through assertMatchInScope, exactly as the
// context and reply routes for a chat.

import { authenticateCrm } from "@/lib/crmAuth";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import { firestore } from "@/lib/firebaseAdmin";
import { createdAtToIso, isValidChatId, MATCHDAY_SENDER_NAME, type FirestoreMessage } from "@/lib/matchChats";

export const runtime = "nodejs";
export const maxDuration = 10;

const LIMIT = 100;

type RouteCtx = { params: Promise<{ chatId: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const { chatId } = await ctx.params;
  {
    const scope = await assertMatchInScope(auth.supabase, auth.confinedCity, chatId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!chatId || !isValidChatId(chatId)) {
    return Response.json({ error: "chatId must be a numeric Firestore chat id" }, { status: 400 });
  }

  let docs: { id: string; data: FirestoreMessage }[];
  try {
    const snap = await firestore().collection("Chats").doc(chatId).collection("messages").orderBy("createdAt", "desc").limit(LIMIT).get();
    docs = snap.docs.map((d) => ({ id: d.id, data: d.data() as FirestoreMessage }));
  } catch (err) {
    console.error("[match-chats:messages] firestore read failed", err);
    return Response.json({ error: "Firestore read failed" }, { status: 502 });
  }

  const messages = docs
    .map(({ id, data: m }) => ({
      id,
      text: m.text ?? null,
      kind: m.messageType ?? "Text",
      sentBy: m.sentBy || m.user?.name || null,
      isMatchDay: m.sentBy === MATCHDAY_SENDER_NAME,
      imageUrl: m.image ?? (m.media && /^image\//.test(m.media.type ?? "") ? m.media.url : null),
      sentAt: createdAtToIso(m.createdAt),
    }))
    .reverse();
  return Response.json({ chat_id: chatId, messages, limit: LIMIT }, { status: 200 });
}
