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

  const { data, error } = await supabase.rpc("crm_unread_count", {
    p_user_id: appUserId,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const count = typeof data === "number" && Number.isFinite(data) ? data : 0;
  return Response.json({ count }, { status: 200 });
}
