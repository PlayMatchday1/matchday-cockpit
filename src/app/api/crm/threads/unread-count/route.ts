// GET /api/crm/threads/unread-count — total unread customer-chat threads
// for the current viewer, used by the "Chats" nav badge.
//
// One indexed round-trip via the crm_unread_count(p_user_id) RPC (see
// migration 0055, which MUST mirror computeUnreadCountsForUsers). Polled
// every 30s by the nav, so it deliberately avoids the 50-round-trip
// fan-out of the JS path.
//
// Auth: dual-mode bearer via src/lib/crmAuth. Cron callers (no viewer)
// return count 0. On RPC error returns 500 — the nav hook treats any
// non-OK as "no badge", so an error here never reaches the page.

import { authenticateCrm } from "@/lib/crmAuth";
import { crmScopedAssignees } from "@/lib/crmScope";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    // Cron path has no viewer — nothing to count.
    return Response.json({ count: 0 }, { status: 200 });
  }

  /* A CONFINED VIEWER counts only its scope. crm_unread_count (0055) counts, among the 50 most
   * recent threads, inbound-last ones that are unassigned (read by anyone) or assigned to the
   * viewer (read by the viewer). Unassigned threads are outside every city scope, and a thread
   * assigned to someone else is never unread for this viewer, so for a confined viewer the same rule
   * reduces to: the viewer's own threads among those 50, unread by the viewer. Unconfined viewers
   * keep the RPC unchanged. */
  if (auth.confinedCity) {
    const scope = await crmScopedAssignees(auth);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
    if (!scope.ids!.includes(appUserId)) return Response.json({ count: 0 }, { status: 200 });
    const recent = await supabase
      .from("crm_threads")
      .select("id, last_message_at, last_message_preview, last_message_direction, assigned_to_user_id")
      .order("last_message_at", { ascending: false })
      .limit(50);
    if (recent.error) return Response.json({ error: recent.error.message }, { status: 500 });
    const mine = (recent.data ?? []).filter((t) => t.assigned_to_user_id === appUserId && t.last_message_preview != null && t.last_message_direction === "inbound");
    if (mine.length === 0) return Response.json({ count: 0 }, { status: 200 });
    const reads = await supabase.from("crm_thread_reads").select("thread_id, last_read_at").eq("user_id", appUserId).in("thread_id", mine.map((t) => t.id));
    if (reads.error) return Response.json({ error: reads.error.message }, { status: 500 });
    const readAt = new Map((reads.data ?? []).map((r) => [r.thread_id as string, Date.parse(r.last_read_at as string)]));
    const count = mine.filter((t) => Date.parse(t.last_message_at as string) > (readAt.get(t.id as string) ?? -Infinity)).length;
    return Response.json({ count }, { status: 200 });
  }
  const { data, error } = await supabase.rpc("crm_unread_count", {
    p_user_id: appUserId,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const count = typeof data === "number" && Number.isFinite(data) ? data : 0;
  return Response.json({ count }, { status: 200 });
}
