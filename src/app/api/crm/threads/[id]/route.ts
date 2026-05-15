// GET /api/crm/threads/[id] — full thread for the center pane.
// Returns the thread, all messages chronological asc, and the
// player context payload for the right pane.
//
// Player context: name, city, phone, email, is_member, +
// total_match_count from mdapi_match_players (where player_id = X).
//
// Auth: dual-mode bearer via src/lib/crmAuth.
//
// Response:
//   {
//     thread: {...},
//     messages: [...],
//     player: { id, first_name, last_name, email, phone_number,
//               preferable_city_normalized, is_member,
//               total_match_count } | null
//   }

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const { id: threadId } = await ctx.params;
  if (!threadId) {
    return Response.json({ error: "id required" }, { status: 400 });
  }

  const threadRes = await supabase
    .from("crm_threads")
    .select(
      "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at",
    )
    .eq("id", threadId)
    .maybeSingle();
  if (threadRes.error) {
    console.error("[crm:threads.detail] db error", threadRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!threadRes.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const thread = threadRes.data;

  const messagesRes = await supabase
    .from("crm_messages")
    .select(
      "id, thread_id, direction, body, sent_at, sent_by_user_id, telnyx_message_id, segment_count",
    )
    .eq("thread_id", threadId)
    .order("sent_at", { ascending: true });
  if (messagesRes.error) {
    console.error(
      "[crm:threads.detail] messages query error",
      messagesRes.error,
    );
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // sender_email for outbound rows so the UI can label bubbles.
  const senderIds = Array.from(
    new Set(
      (messagesRes.data ?? [])
        .map((m) => m.sent_by_user_id)
        .filter((x): x is string => typeof x === "string"),
    ),
  );
  const sendersById = new Map<string, { email: string; full_name: string | null }>();
  if (senderIds.length > 0) {
    const senders = await supabase
      .from("app_users")
      .select("id, email, full_name")
      .in("id", senderIds);
    if (!senders.error && senders.data) {
      for (const s of senders.data as {
        id: string;
        email: string;
        full_name: string | null;
      }[]) {
        sendersById.set(s.id, { email: s.email, full_name: s.full_name });
      }
    }
  }
  const messages = (messagesRes.data ?? []).map((m) => ({
    ...m,
    sender:
      typeof m.sent_by_user_id === "string"
        ? sendersById.get(m.sent_by_user_id) ?? null
        : null,
  }));

  // Player context — only if thread has a player_id.
  let player: unknown = null;
  if (thread.player_id != null) {
    const playerRes = await supabase
      .from("mdapi_users")
      .select(
        "id, first_name, last_name, email, phone_number, preferable_city_normalized, preferable_city_name, is_member, created_at",
      )
      .eq("id", thread.player_id)
      .maybeSingle();
    if (!playerRes.error && playerRes.data) {
      // Total matches "attended" (registrations not cancelled).
      // Counted on mdapi_match_players.user_id with head + count to
      // avoid pulling rows.
      const matchCount = await supabase
        .from("mdapi_match_players")
        .select("api_id", { count: "exact", head: true })
        .eq("user_id", thread.player_id)
        .not("is_cancelled", "is", true);
      const total_match_count = matchCount.error ? null : matchCount.count;
      player = { ...playerRes.data, total_match_count };
    }
  }

  return Response.json({ thread, messages, player }, { status: 200 });
}
