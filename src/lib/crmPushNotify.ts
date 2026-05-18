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

  // 2. Resolve push subscriptions for those recipients.
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

  const payload: PushPayload = {
    title,
    body: previewBody,
    tag: threadId,
    data: {
      thread_id: threadId,
      route: `/chats?threadId=${encodeURIComponent(threadId)}`,
    },
  };
  const results = await sendPushNotificationToMany(subs, payload);
  const okCount = results.filter((r) => r.ok).length;
  console.log(
    `[crm:push] sent thread=${threadId} recipients=${recipientIds.length} subs=${subs.length} delivered=${okCount}`,
  );
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
