// GET /api/crm/threads/awaiting-count — GLOBAL count of open conversations
// waiting on a human reply, for the chat rail badge + the metrics-strip pill.
//
// This is the SAME population the inbox list route reports as counts.awaiting
// (src/app/api/crm/threads/route.ts): open threads whose last message is
// inbound, minus acknowledgments / operator-dismissed ones — via the shared
// isAwaitingReply rule, the single source of truth. Kept as its own tiny
// endpoint so the rail (rendered on every Match Ops page) can poll a cheap
// count without fetching the whole inbox.
//
// Fails safe: on any error it returns 0 so the badge simply disappears rather
// than the page breaking. Auth: admin/chats via authenticateCrm.

import { authenticateCrm } from "@/lib/crmAuth";
import { isAwaitingReply } from "@/lib/awaitingReply";

export const runtime = "nodejs";
export const maxDuration = 10;

const PAGE = 1000;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  try {
    // Bounded scan of the awaiting CANDIDATES only (open + inbound-last — a
    // small set) then the shared isAwaitingReply filter, mirroring the list
    // route's awaitingCountP exactly so the pill and badge can never drift.
    const rows: {
      last_message_preview: string | null;
      last_message_at: string | null;
      no_reply_needed_at: string | null;
    }[] = [];
    let from = 0;
    while (from < 20000) {
      const r = await supabase
        .from("crm_threads")
        .select("last_message_preview, last_message_at, no_reply_needed_at")
        .eq("status", "open")
        .eq("last_message_direction", "inbound")
        .range(from, from + PAGE - 1);
      if (r.error) {
        console.error("[crm:awaiting-count] scan error", r.error);
        return Response.json({ count: 0 }, { status: 200 });
      }
      const page = (r.data ?? []) as typeof rows;
      rows.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    const count = rows.filter((r) =>
      isAwaitingReply({
        status: "open",
        last_message_direction: "inbound",
        last_message_preview: r.last_message_preview,
        last_message_at: r.last_message_at,
        no_reply_needed_at: r.no_reply_needed_at,
      }),
    ).length;
    return Response.json({ count }, { status: 200 });
  } catch (e) {
    console.error("[crm:awaiting-count] threw", e);
    return Response.json({ count: 0 }, { status: 200 });
  }
}
