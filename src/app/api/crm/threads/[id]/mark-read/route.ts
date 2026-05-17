// POST /api/crm/threads/[id]/mark-read — upserts the viewer's read
// state for a thread.
//
// Body: none.
//
// Auth: dual-mode bearer via src/lib/crmAuth. Session path (admin
// human) is the only meaningful caller — cron has no "viewer" and is
// rejected with 400.
//
// Write rule (universal — display interpretation lives in the
// threads-list query):
//   INSERT (thread_id, viewer_user_id, now())
//   ON CONFLICT DO UPDATE SET last_read_at = now()
//
// The display rule uses this row differently per assignment state:
//   thread unassigned   → MAX(reads.last_read_at) across all admins
//   thread assigned     → only the assignee's row counts
//   non-assignee viewer → never unread for them (their row is
//                         written but has no display effect)
//
// Side effect: the AFTER INSERT/UPDATE trigger on crm_thread_reads
// touches crm_threads.reads_updated_at, which broadcasts a row
// UPDATE event to every admin's realtime subscription. That delivers
// cross-admin unassigned-read convergence on top of the per-user
// subscription that already handles same-user multi-device.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;
  if (!appUserId) {
    return Response.json(
      { error: "mark-read requires a viewer; cron path is not supported" },
      { status: 400 },
    );
  }

  const { id: threadId } = await ctx.params;
  if (!threadId || !UUID_RX.test(threadId)) {
    return Response.json({ error: "Invalid thread id" }, { status: 400 });
  }

  // Ensure the thread exists. Without this we'd silently write read
  // rows pointing at nothing, and a typo'd id would never surface.
  const threadCheck = await supabase
    .from("crm_threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (threadCheck.error) {
    console.error("[crm:mark-read] thread lookup failed", threadCheck.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!threadCheck.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  const upsert = await supabase
    .from("crm_thread_reads")
    .upsert(
      {
        thread_id: threadId,
        user_id: appUserId,
        last_read_at: nowIso,
      },
      { onConflict: "thread_id,user_id" },
    );
  if (upsert.error) {
    console.error("[crm:mark-read] upsert failed", upsert.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  return Response.json(
    { thread_id: threadId, user_id: appUserId, last_read_at: nowIso },
    { status: 200 },
  );
}
