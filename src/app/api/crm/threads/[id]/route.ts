// GET /api/crm/threads/[id] — chat-pane data for a single thread.
//
// Returns the thread row, all messages chronological asc, signed
// media URLs, the current assignee, and the latest inbound timestamp
// (for the WhatsApp 24-hour window check in the composer).
//
// Player + recent/upcoming matches + historical-account count moved
// to a separate /context endpoint so the chat pane can render
// without waiting on those heavier queries. ContextPanel fetches
// /context lazily only when it becomes visible.
//
// Auth: dual-mode bearer via src/lib/crmAuth.
//
// Response:
//   {
//     thread:    {...},
//     messages:  [...],   // signed_media_url minted per row
//     assignee:  { id, email, full_name } | null,
//     latest_inbound_at: string | null,
//   }

import { authenticateCrm } from "@/lib/crmAuth";
import { getSignedMediaUrl } from "@/lib/crmMedia";

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
      "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at, channel, status, closed_at, closed_by_user_id",
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

  // Current assignee (Phase 1).
  let assignee: { id: string; email: string; full_name: string | null } | null =
    null;
  if (thread.assigned_to_user_id) {
    const a = await supabase
      .from("app_users")
      .select("id, email, full_name")
      .eq("id", thread.assigned_to_user_id)
      .maybeSingle();
    if (!a.error && a.data) {
      assignee = a.data as {
        id: string;
        email: string;
        full_name: string | null;
      };
    }
  }

  const messagesRes = await supabase
    .from("crm_messages")
    .select(
      "id, thread_id, direction, body, sent_at, sent_by_user_id, telnyx_message_id, external_message_id, segment_count, channel, delivery_status, delivery_status_updated_at, media_url, media_mime_type, media_filename, media_size_bytes, media_kind, reaction_target_wamid",
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
  // Mint signed URLs for any media-bearing rows in parallel. The raw
  // media_url (Storage path) is stripped from the response — clients
  // only need the time-limited signed URL.
  const rawMessages = messagesRes.data ?? [];
  const signedUrls = await Promise.all(
    rawMessages.map((m) =>
      typeof m.media_url === "string" && m.media_url.length > 0
        ? getSignedMediaUrl(supabase, m.media_url)
        : Promise.resolve(null),
    ),
  );
  const messages = rawMessages.map((m, i) => {
    const { media_url: _omit, ...rest } = m;
    return {
      ...rest,
      sender:
        typeof m.sent_by_user_id === "string"
          ? sendersById.get(m.sent_by_user_id) ?? null
          : null,
      signed_media_url: signedUrls[i],
    };
  });

  // Latest inbound message timestamp — used client-side to enforce
  // the WhatsApp 24-hour session window (compose disabled past it).
  // Derived from the already-loaded messages so no extra query.
  let latest_inbound_at: string | null = null;
  for (let i = (messagesRes.data?.length ?? 0) - 1; i >= 0; i--) {
    const m = messagesRes.data![i];
    if (m.direction === "inbound" && typeof m.sent_at === "string") {
      latest_inbound_at = m.sent_at;
      break;
    }
  }

  return Response.json(
    {
      thread,
      messages,
      assignee,
      latest_inbound_at,
    },
    { status: 200 },
  );
}
