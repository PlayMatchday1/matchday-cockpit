// STAFF APP PLAYER CHAT PUSH, ON NEEDS A HUMAN (Ryan, 2026-10-31). Replaces the push that fired on every
// player message that left a thread waiting (appPushChat, removed). The rule is the desktop's own
// section (src/lib/crmAttention, through loadAttention), so the phone, the inbox and the badge agree:
//
//   WHEN      a thread is in Needs a human. Run from the auto-send tick, every minute, right after the
//             tick drafts: a fresh player message reads "No draft yet" until its draft decides, so a
//             push at the webhook would reach threads that a minute later are Auto-sending. "No draft
//             yet" pushes only once the draft is overdue (DRAFT_SETTLE_MS) or there is no model key.
//             No 10-minute delay: that is the desktop browser push, left as it is.
//   ONCE      per wait. A wait begins at the first player message after the last staff reply (a message
//             a person sent: sent_by_user_id), so the bot's replies and a strike holding reply do not
//             start a new one. The claim is a row in app_push_chat_waits; the insert is the claim.
//   NEVER     Auto-sending or Answered, nothing owed. A strike dispute owed a person is Needs a human
//             and pushes.
//   TO        the assignee, or with nobody assigned every chat staff member (admin or Player Chats, not
//             a service account) whom the inbox would show the thread to: a city-confined account is
//             never shown an unassigned thread (crmScope), so it is not pushed one either. Then each
//             person's own player chat switch, the admin kill switch and their devices (sendAppPush).
//   SAYS      "Bryan O. · ATX · Category other always goes to a person." Tapping opens the thread.
//   LOGGED    every send and every skip, with the reason, in app_push_log.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAwaitingReply } from "./awaitingReply";
import { loadAttention, strikeHoldingThreadIds } from "./crmAttentionLoad";
import { HUMAN_PUSH_WITHIN_MS, NO_DRAFT_YET } from "./crmAttention";
import { finalRecipients, logPushSkip, sendAppPush, PUSH_TEST_ONLY_EMAILS, type StaffRow } from "./appPush";
import { humanPushText, humanRecipients, settledHuman, waitStartOf, type WaitMsg } from "./appPushHumanRules";

export * from "./appPushHumanRules";

type ThreadRow = { id: string; status: "open" | "closed"; assigned_to_user_id: string | null; player_id: number | null; phone_number: string; last_message_at: string; last_message_preview: string | null; last_message_direction: "inbound" | "outbound" | null; no_reply_needed_at: string | null };
const COLS = "id, status, assigned_to_user_id, player_id, phone_number, last_message_at, last_message_preview, last_message_direction, no_reply_needed_at";

export type HumanPushOpts = {
  /** Compute and report only: no claim, no send, no log. */
  dryRun?: boolean;
  /** Real sends reach these accounts and nobody else (testing). Defaults to the module's test gate. */
  onlyEmails?: readonly string[] | null;
  /** Only these threads (testing). */
  threadIds?: string[];
  /** Whether the tick has a model key: without one no draft will come, so "No draft yet" is final. */
  hasModelKey: boolean;
};

export type HumanPushResult = { thread_id: string; wait_started_at: string | null; action: "sent" | "skipped" | "pending" | "already" | "not_human"; reason: string; recipients?: number; ok?: number };

export async function notifyAppNeedsHuman(sb: SupabaseClient, now: number, opts: HumanPushOpts): Promise<HumanPushResult[]> {
  const out: HumanPushResult[] = [];
  let rows: ThreadRow[];
  if (opts.threadIds?.length) {
    const r = await sb.from("crm_threads").select(COLS).in("id", opts.threadIds);
    if (r.error) throw new Error(r.error.message);
    rows = (r.data ?? []) as ThreadRow[];
  } else {
    const open = await sb.from("crm_threads").select(COLS).eq("status", "open").eq("last_message_direction", "inbound").gte("last_message_at", new Date(now - HUMAN_PUSH_WITHIN_MS).toISOString());
    if (open.error) throw new Error(open.error.message);
    rows = [...((open.data ?? []) as ThreadRow[])];
    const held = await strikeHoldingThreadIds(sb, now);
    if (held.length) {
      const h = await sb.from("crm_threads").select(COLS).in("id", held).eq("status", "open").eq("last_message_direction", "outbound");
      if (h.error) throw new Error(h.error.message);
      rows.push(...((h.data ?? []) as ThreadRow[]));
    }
  }
  if (!rows.length) return out;
  const attention = await loadAttention(sb, rows.map((t) => ({ id: t.id, last_message_at: t.last_message_at, awaiting: isAwaitingReply(t) })));

  let staff: StaffRow[] | null = null;
  for (const t of rows) {
    const a = attention.get(t.id) ?? null;
    if (!a || a.section !== "human") { out.push({ thread_id: t.id, wait_started_at: null, action: "not_human", reason: a ? "Auto-sending" : "Answered, nothing owed" }); continue; }

    const m = await sb.from("crm_messages").select("direction, sent_at, sent_by_user_id, media_kind").eq("thread_id", t.id).order("sent_at", { ascending: true }).limit(1000);
    if (m.error) throw new Error(m.error.message);
    const waitStart = waitStartOf((m.data ?? []) as WaitMsg[]);
    if (!waitStart) { out.push({ thread_id: t.id, wait_started_at: null, action: "skipped", reason: "No player message since the last staff reply." }); continue; }
    const reason = a.reason ?? "Needs a person";
    if (!settledHuman(a, now, opts.hasModelKey)) { out.push({ thread_id: t.id, wait_started_at: waitStart, action: "pending", reason: `${NO_DRAFT_YET}: waiting for the draft.` }); continue; }

    if (!opts.dryRun) {
      const claim = await sb.from("app_push_chat_waits").insert({ thread_id: t.id, wait_started_at: waitStart, inbound_id: a.inbound_id });
      if (claim.error) {
        // 23505: this wait was claimed already (sent or skipped once). Anything else: do not push blind.
        if (claim.error.code === "23505") { out.push({ thread_id: t.id, wait_started_at: waitStart, action: "already", reason: "Pushed for this wait already." }); continue; }
        throw new Error(`app_push_chat_waits: ${claim.error.message}`);
      }
    }

    if (!staff) {
      const s = await sb.from("app_users").select("id, email, is_admin, can_access_chats, can_access_matchops, is_city_manager, is_service_account, city_identifier");
      if (s.error) throw new Error(s.error.message);
      staff = (s.data ?? []) as StaffRow[];
    }
    const recipientIds = finalRecipients(humanRecipients(staff, t.assigned_to_user_id), staff, null, opts.onlyEmails === undefined ? PUSH_TEST_ONLY_EMAILS : opts.onlyEmails);

    let player: { first_name: string | null; last_name: string | null; preferable_city_normalized: string | null } | null = null;
    if (t.player_id != null) {
      const p = await sb.from("mdapi_users").select("first_name, last_name, preferable_city_normalized").eq("id", t.player_id).maybeSingle();
      player = (p.data as typeof player) ?? null;
    }
    const text = humanPushText(player, t.phone_number, reason);
    if (opts.dryRun) { out.push({ thread_id: t.id, wait_started_at: waitStart, action: "sent", reason: `dry run: ${text.body}`, recipients: recipientIds.length }); continue; }

    const r = await sendAppPush(sb, { event: "player_chat", subject: t.id, recipientIds, ...text, reason: `Needs a human: ${reason}`, data: { kind: "player_chat", threadId: t.id } });
    if (r.skipped) {
      await logPushSkip(sb, "player_chat", t.id, `${r.skipped} (Needs a human: ${reason})`);
      out.push({ thread_id: t.id, wait_started_at: waitStart, action: "skipped", reason: r.skipped, recipients: r.recipients });
    } else {
      out.push({ thread_id: t.id, wait_started_at: waitStart, action: "sent", reason, recipients: r.recipients, ok: r.ok });
    }
  }
  return out;
}
