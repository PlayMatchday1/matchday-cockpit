// POST /api/crm/threads/[id]/status — close or reopen a conversation.
//
// Body: { action: "close" | "reopen", reason?: string }
//   close  → status='closed', closed_at=now(), closed_by_user_id=viewer
//            audit row action='close'
//   reopen → status='open',   closed_at=null,  closed_by_user_id=null
//            audit row action='reopen'
//
// Permissions: admin-only. Any app_users.is_admin = true operator can
// close or reopen. City managers (can_access_chats without is_admin)
// can view threads but not action them, so a non-admin session is
// rejected 403. The cron path has no attributable operator and is
// rejected too — close/reopen must always name a human actor.
//
// Two writes are sequential, not transactional: UPDATE crm_threads
// then INSERT crm_thread_status_log. A failed audit insert is logged
// loudly but does not fail the response (see writeThreadStatusLog).
//
// Response: { thread: <updated row> }

import { authenticateCrm } from "@/lib/crmAuth";
import { writeThreadStatusLog } from "@/lib/crmThreadStatus";

export const runtime = "nodejs";
export const maxDuration = 10;

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const THREAD_COLS =
  "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at, channel, status, closed_at, closed_by_user_id";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId, isAdmin } = auth;

  // Admin-only, and only from an attributable operator session.
  if (!isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  if (!appUserId) {
    return Response.json(
      { error: "Operator session required" },
      { status: 403 },
    );
  }

  const { id: threadId } = await ctx.params;
  if (!threadId || !UUID_RX.test(threadId)) {
    return Response.json({ error: "Invalid thread id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown; reason?: unknown }
    | null;
  const action = body?.action;
  if (action !== "close" && action !== "reopen") {
    return Response.json(
      { error: 'Body must be { action: "close" | "reopen" }' },
      { status: 400 },
    );
  }
  const reason =
    typeof body?.reason === "string" ? body.reason.trim() || null : null;

  const cur = await supabase
    .from("crm_threads")
    .select("id, status")
    .eq("id", threadId)
    .maybeSingle();
  if (cur.error) {
    console.error("[crm:status] read failed", cur.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!cur.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const curStatus = (cur.data.status as string | null) ?? "open";
  const targetStatus = action === "close" ? "closed" : "open";

  // Idempotent no-op: already in the requested state. Return the
  // current row without writing an audit entry.
  if (curStatus === targetStatus) {
    const row = await supabase
      .from("crm_threads")
      .select(THREAD_COLS)
      .eq("id", threadId)
      .single();
    return Response.json({ thread: row.data, noop: true }, { status: 200 });
  }

  const nowIso = new Date().toISOString();
  const patch =
    action === "close"
      ? { status: "closed", closed_at: nowIso, closed_by_user_id: appUserId }
      : { status: "open", closed_at: null, closed_by_user_id: null };

  const upd = await supabase
    .from("crm_threads")
    .update(patch)
    .eq("id", threadId)
    .select(THREAD_COLS)
    .single();
  if (upd.error || !upd.data) {
    console.error("[crm:status] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  await writeThreadStatusLog(supabase, {
    threadId,
    action,
    performedByUserId: appUserId,
    reason,
  });

  console.log(
    `[crm:status] thread=${threadId} ${action} by=${appUserId}`,
  );

  return Response.json({ thread: upd.data }, { status: 200 });
}
