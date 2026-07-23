// POST /api/crm/threads/bulk-status — close or undo-close many
// conversations in one request.
//
// Body: { action: "close" | "undo_close", thread_ids: string[] }
//   close      → set matching OPEN threads to closed (closed_at=now(),
//                closed_by=viewer) in one UPDATE, then insert one
//                'close' audit row per thread in one INSERT. Returns
//                the ids that actually changed (already-closed threads
//                are skipped).
//   undo_close → set matching CLOSED threads back to open in one
//                UPDATE, then delete each thread's most recent 'close'
//                audit row so the batch close leaves no trace. Powers
//                the "N threads closed — Undo" toast.
//
// Two statements (UPDATE, then INSERT/DELETE) rather than one wrapping
// transaction — the same non-transactional-but-atomic-per-statement
// discipline the single close/reopen and assign routes use. Each
// statement is atomic across the whole batch (not N per-thread calls).
//
// Permissions: any chat operator (is_admin OR can_access_chats),
// attributable operator session required. Cron path rejected.
// Auto-reopen on new inbound still applies to bulk-closed threads
// (webhook path is unchanged).

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 15;

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guardrail: a single bulk action covers at most one inbox page worth
// of threads plus headroom. The client only ever selects the current
// page (~100), so this is a defensive ceiling, not a normal limit.
const MAX_IDS = 500;

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId, isAdmin, canAccessChats } = auth;

  if (!isAdmin && !canAccessChats) {
    return Response.json(
      { error: "Chat operator access required" },
      { status: 403 },
    );
  }
  if (!appUserId) {
    return Response.json(
      { error: "Operator session required" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown; thread_ids?: unknown }
    | null;
  const action = body?.action;
  if (action !== "close" && action !== "undo_close") {
    return Response.json(
      { error: 'Body must be { action: "close" | "undo_close", thread_ids }' },
      { status: 400 },
    );
  }
  if (
    !Array.isArray(body?.thread_ids) ||
    body.thread_ids.length === 0 ||
    !body.thread_ids.every(
      (x): x is string => typeof x === "string" && UUID_RX.test(x),
    )
  ) {
    return Response.json(
      { error: "thread_ids must be a non-empty array of thread uuids" },
      { status: 400 },
    );
  }
  // Dedupe defensively.
  const ids = Array.from(new Set(body.thread_ids));
  if (ids.length > MAX_IDS) {
    return Response.json(
      { error: `Too many threads (max ${MAX_IDS})` },
      { status: 400 },
    );
  }

  if (action === "close") {
    const nowIso = new Date().toISOString();
    // Only OPEN threads flip — idempotent, and never re-stamps a
    // thread that was already closed.
    const upd = await supabase
      .from("crm_threads")
      .update({
        status: "closed",
        closed_at: nowIso,
        closed_by_user_id: appUserId,
      })
      .in("id", ids)
      .eq("status", "open")
      .select("id");
    if (upd.error) {
      console.error("[crm:bulk-status] close update failed", upd.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
    const closedIds = (upd.data ?? []).map((r) => r.id as string);

    if (closedIds.length > 0) {
      const logIns = await supabase.from("crm_thread_status_log").insert(
        closedIds.map((id) => ({
          thread_id: id,
          action: "close",
          performed_by_user_id: appUserId,
        })),
      );
      if (logIns.error) {
        // Audit gap is recoverable; the closes themselves landed.
        console.error(
          "[crm:bulk-status] AUDIT GAP — close log insert failed",
          logIns.error,
        );
      }
    }

    console.log(
      `[crm:bulk-status] closed ${closedIds.length}/${ids.length} by=${appUserId}`,
    );
    return Response.json({ closed_ids: closedIds }, { status: 200 });
  }

  // action === "undo_close"
  const upd = await supabase
    .from("crm_threads")
    .update({ status: "open", closed_at: null, closed_by_user_id: null })
    .in("id", ids)
    .eq("status", "closed")
    .select("id");
  if (upd.error) {
    console.error("[crm:bulk-status] undo update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const reopenedIds = (upd.data ?? []).map((r) => r.id as string);

  // Delete each batch thread's most recent 'close' audit row so the
  // undone close leaves no trace. Two queries regardless of batch size:
  // fetch candidate close rows, pick the latest per thread, delete them.
  const closeRows = await supabase
    .from("crm_thread_status_log")
    .select("id, thread_id, performed_at")
    .in("thread_id", ids)
    .eq("action", "close")
    .order("performed_at", { ascending: false });
  if (closeRows.error) {
    console.error(
      "[crm:bulk-status] undo: close-row lookup failed",
      closeRows.error,
    );
  } else {
    const latestByThread = new Map<string, string>();
    for (const r of (closeRows.data ?? []) as {
      id: string;
      thread_id: string;
    }[]) {
      if (!latestByThread.has(r.thread_id)) {
        latestByThread.set(r.thread_id, r.id);
      }
    }
    const delIds = Array.from(latestByThread.values());
    if (delIds.length > 0) {
      const del = await supabase
        .from("crm_thread_status_log")
        .delete()
        .in("id", delIds);
      if (del.error) {
        console.error(
          "[crm:bulk-status] undo: audit delete failed",
          del.error,
        );
      }
    }
  }

  console.log(
    `[crm:bulk-status] reopened ${reopenedIds.length}/${ids.length} by=${appUserId}`,
  );
  return Response.json({ reopened_ids: reopenedIds }, { status: 200 });
}
