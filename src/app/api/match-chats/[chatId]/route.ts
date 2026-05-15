// GET /api/match-chats/[chatId] — minimal match context for the
// detail page (header rendering + Manager badge derivation).
//
// Just an mdapi_matches lookup keyed on the chat id. Returns
// match=null if the chat id has no matching row (orphan) — the UI
// renders the "Match {id} · (no match data)" fallback.
//
// Auth: admin-only via src/lib/crmAuth.

import { authenticateCrm } from "@/lib/crmAuth";
import { isValidChatId } from "@/lib/matchChats";

export const runtime = "nodejs";
export const maxDuration = 10;

type RouteCtx = { params: Promise<{ chatId: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const { chatId } = await ctx.params;
  if (!chatId || !isValidChatId(chatId)) {
    return Response.json({ chat_id: chatId, match: null }, { status: 200 });
  }
  const apiId = Number(chatId);
  if (!Number.isFinite(apiId)) {
    return Response.json({ chat_id: chatId, match: null }, { status: 200 });
  }

  const r = await supabase
    .from("mdapi_matches")
    .select(
      "api_id, field_title, field_address, start_date_utc, city_identifier, city_name, manager_email, manager_first_name, manager_last_name, is_cancelled",
    )
    .eq("api_id", apiId)
    .maybeSingle();
  if (r.error) {
    console.error("[match-chats:context] db error", r.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  return Response.json(
    { chat_id: chatId, match: r.data ?? null },
    { status: 200 },
  );
}
