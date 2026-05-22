// Shared push fan-out for /chats inbound messages. Called from both
// the WhatsApp and Telnyx inbound webhooks after the crm_messages
// insert succeeds.
//
// Recipient resolution mirrors the assignment-aware unread rule
// (PR #69):
//   thread.assigned_to_user_id IS NULL  → push every admin
//   thread.assigned_to_user_id  set     → push only the assignee
//
// Each helper call is bounded by PUSH_TIMEOUT_MS so a slow Apple /
// Google push service can't stall the webhook ack. Never throws —
// errors are logged and absorbed. The webhook ack must always
// succeed regardless of push outcome.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sendPushNotificationToMany,
  type PushPayload,
  type StoredSubscription,
} from "@/lib/webPush";

const PUSH_TIMEOUT_MS = 2000;
const BODY_PREVIEW_LEN = 80;

export type CrmInboundPushArgs = {
  threadId: string;
  phoneNumber: string;
  playerId: number | null;
  // Verbatim message body. For media inbound (image/video/document
  // caption), this is the caption. For audio/sticker (no caption
  // per Meta spec) and for non-text messages whose media fetch
  // failed, this is empty or the placeholder.
  body: string;
  mediaKind?: "image" | "video" | "audio" | "document" | "sticker" | null;
  mediaFilename?: string | null;
  supabase: SupabaseClient;
};

// Top-level entry. Wraps doNotify in a timeout race so the webhook
// can ack within budget even if a push service is slow.
export async function notifyInboundChatMessage(
  args: CrmInboundPushArgs,
): Promise<void> {
  try {
    await Promise.race([
      doNotify(args),
      new Promise<void>((resolve) => setTimeout(resolve, PUSH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error("[crm:push] notify failed:", err);
  }
}

async function doNotify({
  threadId,
  phoneNumber,
  playerId,
  body,
  mediaKind,
  mediaFilename,
  supabase,
}: CrmInboundPushArgs): Promise<void> {
  // 1. Resolve recipients per the assignment-aware rule.
  const thread = await supabase
    .from("crm_threads")
    .select("assigned_to_user_id")
    .eq("id", threadId)
    .maybeSingle();
  if (thread.error || !thread.data) {
    console.error("[crm:push] thread lookup failed", thread.error);
    return;
  }
  const assigneeId = (thread.data.assigned_to_user_id as string | null) ?? null;

  let recipientIds: string[];
  if (assigneeId) {
    recipientIds = [assigneeId];
  } else {
    const admins = await supabase
      .from("app_users")
      .select("id")
      .eq("is_admin", true);
    if (admins.error) {
      console.error("[crm:push] admin lookup failed", admins.error);
      return;
    }
    recipientIds = (admins.data ?? []).map((r) => r.id as string);
  }
  if (recipientIds.length === 0) return;

  // 2. Resolve push subscriptions for those recipients, grouped by
  // user_id. Per-user grouping lets us send a personalized payload
  // (different unread_count per viewer) without re-querying subs.
  const subsRes = await supabase
    .from("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth")
    .in("user_id", recipientIds);
  if (subsRes.error) {
    console.error("[crm:push] subscription lookup failed", subsRes.error);
    return;
  }
  const subs = (subsRes.data ?? []) as StoredSubscription[];
  if (subs.length === 0) {
    console.log(
      `[crm:push] no subscriptions for thread=${threadId} recipients=${recipientIds.length}`,
    );
    return;
  }
  const subsByUser = new Map<string, StoredSubscription[]>();
  for (const s of subs) {
    const list = subsByUser.get(s.user_id) ?? [];
    list.push(s);
    subsByUser.set(s.user_id, list);
  }

  // 3. Title — player display name when we have one, else the
  // phone number. Phone is a useful fallback because the lock-
  // screen reader at least sees who messaged.
  let title = phoneNumber;
  if (playerId != null) {
    const player = await supabase
      .from("mdapi_users")
      .select("first_name, last_name")
      .eq("id", playerId)
      .maybeSingle();
    if (!player.error && player.data) {
      const first = ((player.data.first_name as string | null) ?? "").trim();
      const last = ((player.data.last_name as string | null) ?? "").trim();
      const full = `${first} ${last}`.trim();
      if (full) title = full;
    }
  }

  // 4. Body — caption preview when present, else a kind-aware emoji
  // hint. Mirrors the inbox preview convention from the webhook's
  // previewFor / send-media route's PREVIEW_LABEL so the lock-
  // screen text matches the inbox row text.
  const previewBody = bodyPreview(body, mediaKind ?? null, mediaFilename ?? null);

  // 5. Per-recipient unread counts for the iOS PWA home-screen badge.
  // Shares the expensive direction / threads / reads queries across
  // recipients so this stays O(threads) regardless of recipient count.
  const unreadCounts = await computeUnreadCountsForUsers(
    supabase,
    Array.from(subsByUser.keys()),
  );

  // 6. Fan out per recipient. Each recipient gets a payload with
  // their own unread_count so the SW can call setAppBadge() to the
  // right number.
  let totalOk = 0;
  for (const [userId, userSubs] of subsByUser) {
    const payload: PushPayload = {
      title,
      body: previewBody,
      tag: threadId,
      unread_count: unreadCounts.get(userId) ?? 1,
      data: {
        thread_id: threadId,
        route: `/chats?threadId=${encodeURIComponent(threadId)}`,
      },
    };
    const results = await sendPushNotificationToMany(userSubs, payload);
    totalOk += results.filter((r) => r.ok).length;
  }
  console.log(
    `[crm:push] sent thread=${threadId} recipients=${recipientIds.length} subs=${subs.length} delivered=${totalOk}`,
  );
}

// Computes per-user unread thread counts using the same rule as
// GET /api/crm/threads (src/app/api/crm/threads/route.ts:205-228):
//   - cap at 50 most-recent threads
//   - require last_message_preview non-null
//   - require latest message direction = "inbound"
//   - unassigned threads: effective = MAX(last_read_at) across all admins
//   - assigned-to-user: effective = that user's own last_read_at
//   - assigned-to-someone-else: never unread for this viewer
//   - is_unread = (effective IS NULL OR last_message_at > effective)
//
// Per-recipient counts are derived from a single set of shared
// queries so this is O(threads) regardless of recipient count.
export async function computeUnreadCountsForUsers(
  supabase: SupabaseClient,
  userIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const id of userIds) counts.set(id, 0);
  if (userIds.length === 0) return counts;

  const threadsRes = await supabase
    .from("crm_threads")
    .select("id, last_message_at, last_message_preview, assigned_to_user_id")
    .order("last_message_at", { ascending: false })
    .limit(50);
  if (threadsRes.error || !threadsRes.data || threadsRes.data.length === 0) {
    return counts;
  }
  const threads = threadsRes.data as Array<{
    id: string;
    last_message_at: string;
    last_message_preview: string | null;
    assigned_to_user_id: string | null;
  }>;
  const threadIds = threads.map((t) => t.id);

  // Latest direction per thread — one bounded query each, same
  // strategy as GET /api/crm/threads.
  const directionResults = await Promise.all(
    threads.map(async (t) => {
      const r = await supabase
        .from("crm_messages")
        .select("direction")
        .eq("thread_id", t.id)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return [t.id, (r.data?.direction as string | null) ?? null] as const;
    }),
  );
  const directionByThreadId = new Map(directionResults);

  const readsRes = await supabase
    .from("crm_thread_reads")
    .select("thread_id, user_id, last_read_at")
    .in("thread_id", threadIds);
  const readsRows = (readsRes.data ?? []) as Array<{
    thread_id: string;
    user_id: string;
    last_read_at: string;
  }>;

  const readsByThreadMax = new Map<string, string>();
  const readsByUserThread = new Map<string, Map<string, string>>();
  for (const r of readsRows) {
    const prev = readsByThreadMax.get(r.thread_id);
    if (!prev || Date.parse(r.last_read_at) > Date.parse(prev)) {
      readsByThreadMax.set(r.thread_id, r.last_read_at);
    }
    let perUser = readsByUserThread.get(r.user_id);
    if (!perUser) {
      perUser = new Map();
      readsByUserThread.set(r.user_id, perUser);
    }
    perUser.set(r.thread_id, r.last_read_at);
  }

  for (const userId of userIds) {
    let count = 0;
    for (const t of threads) {
      if (!t.last_message_preview) continue;
      if (directionByThreadId.get(t.id) !== "inbound") continue;
      let effective: string | null;
      if (t.assigned_to_user_id == null) {
        effective = readsByThreadMax.get(t.id) ?? null;
      } else if (t.assigned_to_user_id === userId) {
        effective = readsByUserThread.get(userId)?.get(t.id) ?? null;
      } else {
        continue;
      }
      if (
        effective == null ||
        Date.parse(t.last_message_at) > Date.parse(effective)
      ) {
        count++;
      }
    }
    counts.set(userId, count);
  }
  return counts;
}

function bodyPreview(
  body: string,
  mediaKind: string | null,
  mediaFilename: string | null,
): string {
  const fromBody = body.slice(0, BODY_PREVIEW_LEN);
  if (fromBody) return fromBody;
  switch (mediaKind) {
    case "image":
      return "📷 Image";
    case "video":
      return "🎬 Video";
    case "audio":
      return (mediaFilename ?? "").startsWith("voice-note")
        ? "🎤 Voice note"
        : "🎵 Audio";
    case "document":
      return mediaFilename
        ? `📄 ${mediaFilename.slice(0, BODY_PREVIEW_LEN - 3)}`
        : "📄 Document";
    case "sticker":
      return "🌟 Sticker";
    default:
      return "";
  }
}
