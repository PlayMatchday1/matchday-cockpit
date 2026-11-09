/* CHURN WIN-BACK — the send routes' half (2026-11-09).
 *
 * Churn's Message button notes a PENDING row in churn_winback (message_id null) for the staff member and thread.
 * When that staff member's next WhatsApp message on that thread goes out — /api/crm/send or
 * /api/crm/send-template, after Meta accepted it and the crm_messages row exists — this fills the pending row with
 * the message and the time. Only filled rows read as "Messaged [date]" on Churn.
 *
 * A pending row older than 24 hours is left alone: a message sent days later from the inbox was not sent "from
 * Churn". Best effort: a failure here is logged and never fails the send. */
import type { SupabaseClient } from "@supabase/supabase-js";

export const WINBACK_PENDING_HOURS = 24;

export async function markWinbackSent(sb: SupabaseClient, threadId: string, staffEmail: string | null, messageId: string): Promise<void> {
  if (!staffEmail) return;
  try {
    const since = new Date(Date.now() - WINBACK_PENDING_HOURS * 3600_000).toISOString();
    const { error } = await sb.from("churn_winback")
      .update({ message_id: messageId, messaged_at: new Date().toISOString() })
      .eq("thread_id", threadId).eq("messaged_by", staffEmail.toLowerCase()).is("message_id", null).gte("messaged_at", since);
    if (error) console.warn(`[churn] win-back not marked for thread ${threadId}: ${error.message}`);
  } catch (e) {
    console.warn(`[churn] win-back not marked for thread ${threadId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
