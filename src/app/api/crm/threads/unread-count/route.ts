// GET /api/crm/threads/unread-count — total unread customer-chat
// threads for the current viewer. Covers BOTH sms and whatsapp
// channels (the customer-conversation surface, as opposed to match
// chats). Reuses computeUnreadCountsForUsers so the nav-bar count
// and the iOS PWA home-screen badge are computed off the same rule
// and the same 50-thread window — they agree by construction.
//
// Auth: dual-mode bearer via src/lib/crmAuth. Cron callers (no
// viewer) get count = 0.

import { authenticateCrm } from "@/lib/crmAuth";
import { computeUnreadCountsForUsers } from "@/lib/crmPushNotify";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    return Response.json({ count: 0 }, { status: 200 });
  }
  const counts = await computeUnreadCountsForUsers(supabase, [appUserId]);
  return Response.json(
    { count: counts.get(appUserId) ?? 0 },
    { status: 200 },
  );
}
