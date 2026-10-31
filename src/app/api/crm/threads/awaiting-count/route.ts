// GET /api/crm/threads/awaiting-count — the count of NEEDS A HUMAN (src/lib/crmAttention), for the chat
// rail badge. A thread with a hold running isn't owed a person yet, so it isn't counted; a strike holding
// reply was answered and is. The inbox section reads the same rule.
//
// The waiting population before that:
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
import { crmScopedAssignees } from "@/lib/crmScope";
import { isAwaitingReply } from "@/lib/awaitingReply";
import { loadAttention, strikeHoldingThreadIds } from "@/lib/crmAttentionLoad";

export const runtime = "nodejs";
export const maxDuration = 10;

const PAGE = 1000;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;
  // The red badge counts only the caller's scope: a number for threads it cannot open is a leak.
  const scope = await crmScopedAssignees(auth);
  if (!scope.ok) return Response.json({ count: 0 }, { status: 200 });

  try {
    // Bounded scan of the awaiting CANDIDATES only (open + inbound-last — a
    // small set) then the shared isAwaitingReply filter, mirroring the list
    // route's awaitingCountP exactly so the pill and badge can never drift.
    const rows: {
      id: string;
      last_message_preview: string | null;
      last_message_at: string | null;
      no_reply_needed_at: string | null;
    }[] = [];
    let from = 0;
    while (from < 20000) {
      let q = supabase
        .from("crm_threads")
        .select("id, last_message_preview, last_message_at, no_reply_needed_at")
        .eq("status", "open")
        .eq("last_message_direction", "inbound");
      if (scope.ids) q = q.in("assigned_to_user_id", scope.ids);
      const r = await q.range(from, from + PAGE - 1);
      if (r.error) {
        console.error("[crm:awaiting-count] scan error", r.error);
        return Response.json({ count: 0 }, { status: 200 });
      }
      const page = (r.data ?? []) as typeof rows;
      rows.push(...page);
      if (page.length < PAGE) break;
      from += PAGE;
    }
    const waiting = rows.filter((r) =>
      isAwaitingReply({
        status: "open",
        last_message_direction: "inbound",
        last_message_preview: r.last_message_preview,
        last_message_at: r.last_message_at,
        no_reply_needed_at: r.no_reply_needed_at,
      }),
    );
    // Counted wide if the sections can't be read: everyone waiting, never a false zero.
    try {
      const heldIds = await strikeHoldingThreadIds(supabase, Date.now());
      let held = heldIds.length ? supabase.from("crm_threads").select("id, last_message_at").in("id", heldIds).eq("status", "open").eq("last_message_direction", "outbound") : null;
      if (held && scope.ids) held = held.in("assigned_to_user_id", scope.ids);
      const heldRows = held ? await held : null;
      if (heldRows?.error) throw new Error(heldRows.error.message);
      const attention = await loadAttention(supabase, [
        ...waiting.map((r) => ({ id: r.id, awaiting: true, last_message_at: r.last_message_at ?? "" })),
        ...((heldRows?.data ?? []) as { id: string; last_message_at: string }[]).map((r) => ({ id: r.id, awaiting: false, last_message_at: r.last_message_at })),
      ]);
      return Response.json({ count: [...attention.values()].filter((a) => a.section === "human").length }, { status: 200 });
    } catch (e) {
      console.error("[crm:awaiting-count] sections unreadable, counting everyone waiting", e);
      return Response.json({ count: waiting.length }, { status: 200 });
    }
  } catch (e) {
    console.error("[crm:awaiting-count] threw", e);
    return Response.json({ count: 0 }, { status: 200 });
  }
}
