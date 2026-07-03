// Shared helper for the crm_thread_status_log audit trail (close /
// reopen / auto_reopen). Used by the close-reopen API route and by
// both inbound webhook handlers (WhatsApp + Telnyx) for the
// system-actor auto_reopen path.
//
// Best-effort by design: a failed audit insert is logged loudly but
// never thrown, mirroring the crm_assignment_log discipline. The
// user-facing (or webhook-facing) status change has already landed by
// the time this runs, so failing here would be worse than a
// recoverable audit gap. A periodic audit-gap scan can reconcile.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

export type ThreadStatusAction = "close" | "reopen" | "auto_reopen";

export async function writeThreadStatusLog(
  sb: SupabaseClient,
  entry: {
    threadId: string;
    action: ThreadStatusAction;
    // null for auto_reopen (actor is the system / inbound webhook).
    performedByUserId: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const ins = await sb.from("crm_thread_status_log").insert({
    thread_id: entry.threadId,
    action: entry.action,
    performed_by_user_id: entry.performedByUserId,
    reason: entry.reason ?? null,
  });
  if (ins.error) {
    console.error(
      `[crm:status-log] AUDIT GAP — ${entry.action} log insert failed for thread=${entry.threadId}`,
      ins.error,
    );
  }
}
