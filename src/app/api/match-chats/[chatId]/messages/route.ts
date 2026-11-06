// GET /api/match-chats/[chatId]/messages — the newest messages of one match chat, oldest first.
//
// The desktop reads a match chat live from Firestore in the browser (ChatPane's onSnapshot). The
// staff app cannot hold Firebase credentials, so it reads the same Firestore path here, through the
// same admin client the reply route writes with. READ ONLY: nothing here writes Firestore or
// Supabase. Phone numbers and emails on the message's user block are dropped, not passed on.
//
// The shape is matchChats.ts messageOut — replies, reactions, edits and media as the player app
// stores them, hidden deletes dropped — a superset of what older app builds read (id, text, kind,
// sentBy, isMatchDay, imageUrl, sentAt). `?before=<document id>` pages back, 50 at a time like the
// desktop's Load older; `?limit=` up to 100.
//
// Auth: authenticateCrm (Chats), and the match's city through assertMatchInScope, exactly as the
// context and reply routes for a chat. Production chats only: the staff app's per-environment route
// is /api/app/{env}/matches/{id}/chat.

import { authenticateCrm } from "@/lib/crmAuth";
import { assertMatchInScope } from "@/lib/matchOpsAuth";
import { isValidChatId, MESSAGE_PAGE_SIZE } from "@/lib/matchChats";
import { readMessages } from "@/lib/matchChatWrite";
import { reviewMasked } from "@/lib/reviewAccount";

export const runtime = "nodejs";
export const maxDuration = 10;

const MAX_LIMIT = 100;

type RouteCtx = { params: Promise<{ chatId: string }> };

export function pageParams(url: URL): { limit: number; before: string | null } {
  const asked = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_LIMIT, Math.floor(asked)) : MAX_LIMIT;
  const before = url.searchParams.get("before");
  return { limit, before: before && /^[A-Za-z0-9_-]{1,64}$/.test(before) ? before : null };
}

async function getRoute(req: Request, ctx: RouteCtx) {
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
  const { limit, before } = pageParams(new URL(req.url));
  try {
    const page = await readMessages(chatId, before ? MESSAGE_PAGE_SIZE : limit, before);
    return Response.json({ chat_id: chatId, messages: page.messages, limit: before ? MESSAGE_PAGE_SIZE : limit, has_more: page.hasMore }, { status: 200 });
  } catch (err) {
    console.error("[match-chats:messages] firestore read failed", err);
    return Response.json({ error: "Firestore read failed" }, { status: 502 });
  }
}

export const GET = reviewMasked(getRoute);
