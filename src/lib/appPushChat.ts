// PLAYER CHAT PUSH TO THE STAFF APP. Called from the WhatsApp and Telnyx inbound webhooks right beside
// notifyInboundChatMessage (the desktop browser push), after the inbound message is stored.
//
// ONE PUSH PER WAIT (Ryan, 2026-10-30: "a player chat message that makes a thread waiting on a
// reply"). The thread must be waiting now by the listing's own rule (isAwaitingReply), and no
// player_chat push may already exist for this thread since the wait began. The wait begins where the
// inbox's own clock says it does (waitingSinceMs: the first player message after our last reply, in
// the current episode). So three messages in a row push once, two messages in one webhook delivery
// push once, and a thread that had been answered pushes again on the next player message.
//
// Never throws, and bounded by the caller's timeout like the desktop push.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAwaitingReply, waitingSinceMs } from "./awaitingReply";
import { chatPushText, chatRecipients, finalRecipients, sendAppPush, type StaffRow } from "./appPush";

export async function notifyAppPlayerChat(args: { threadId: string; supabase: SupabaseClient }): Promise<void> {
  const sb = args.supabase;
  try {
    const t = await sb.from("crm_threads")
      .select("id, status, created_at, player_id, assigned_to_user_id, last_message_at, last_message_preview, last_message_direction, no_reply_needed_at")
      .eq("id", args.threadId).maybeSingle();
    if (t.error || !t.data) return;
    const thread = t.data as { id: string; status: "open" | "closed"; created_at: string; player_id: number | null; assigned_to_user_id: string | null; last_message_at: string; last_message_preview: string | null; last_message_direction: "inbound" | "outbound" | null; no_reply_needed_at: string | null };
    if (!isAwaitingReply(thread)) return;

    /* When this wait began. The episode starts at the latest CLOSE, not the latest reopen: an
     * auto_reopen is logged a moment AFTER the player message that caused it (20:34:43.702 message,
     * 20:34:43.861 reopen, 2026-10-30), so starting at the reopen dropped that very message and no
     * push went out. Everything after a close belongs to the new episode. Never closed: the start. */
    const closed = await sb.from("crm_thread_status_log").select("performed_at").eq("thread_id", thread.id).eq("action", "close").order("performed_at", { ascending: false }).limit(1);
    const episodeStart = closed.data?.[0] ? Date.parse(closed.data[0].performed_at as string) : Date.parse(thread.created_at);
    const msgs = await sb.from("crm_messages").select("direction, body, sent_at, is_auto_reply").eq("thread_id", thread.id).gte("sent_at", new Date(episodeStart).toISOString()).order("sent_at", { ascending: true }).limit(500);
    if (msgs.error || !msgs.data?.length) return;
    const rows = msgs.data as { direction: "inbound" | "outbound"; body: string | null; sent_at: string; is_auto_reply: boolean | null }[];
    const since = waitingSinceMs(rows.map((m) => ({ direction: m.direction, sentAtMs: Date.parse(m.sent_at), isAutoReply: m.is_auto_reply === true })), episodeStart);
    if (since == null) return;

    // Already pushed for this wait? (A dry run never counts.)
    const done = await sb.from("app_push_log").select("id").eq("event", "player_chat").eq("subject", thread.id).eq("dry_run", false).gte("created_at", new Date(since).toISOString()).limit(1);
    if (done.error || (done.data?.length ?? 0) > 0) return;

    const staff = await sb.from("app_users").select("id, email, is_admin, can_access_chats, can_access_matchops, is_city_manager, is_service_account, city_identifier");
    if (staff.error) return;
    const all = (staff.data ?? []) as StaffRow[];
    // Caused by the player, never by staff: there is nobody to leave out.
    const recipientIds = finalRecipients(chatRecipients(all, thread.assigned_to_user_id), all, null);
    if (recipientIds.length === 0) return;

    let first: string | null = null;
    if (thread.player_id != null) {
      const p = await sb.from("mdapi_users").select("first_name").eq("id", thread.player_id).maybeSingle();
      first = (p.data?.first_name as string | null) ?? null;
    }
    const latest = [...rows].reverse().find((m) => m.direction === "inbound");
    const text = chatPushText(first, latest?.body || thread.last_message_preview || "");
    await sendAppPush(sb, { event: "player_chat", subject: thread.id, recipientIds, ...text, data: { kind: "player_chat", threadId: thread.id } });
  } catch (e) {
    console.error(`[app-push] player chat notify failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
