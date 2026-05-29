// POST /api/crm/threads/[id]/follow-up — sets the viewer's per-user
// "follow up" star for a thread.
//
// Body: { follow_up: boolean } — the DESIRED state (not a blind toggle),
// so the call is idempotent under retries:
//   follow_up: true  → INSERT (thread_id, viewer, now) ON CONFLICT DO
//                      NOTHING   (no-op if already starred)
//   follow_up: false → DELETE the (thread_id, viewer) row
//                      (no-op if not starred)
//
// Per-user and private: presence of a crm_thread_follow_ups row = the
// viewer flagged the thread. No trigger / no realtime broadcast, unlike
// crm_thread_reads — starring never churns other admins' inboxes.
//
// Auth: dual-mode bearer via src/lib/crmAuth. Cron has no viewer → 400.

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
      { error: "follow-up requires a viewer; cron path is not supported" },
      { status: 400 },
    );
  }

  const { id: threadId } = await ctx.params;
  if (!threadId || !UUID_RX.test(threadId)) {
    return Response.json({ error: "Invalid thread id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { follow_up?: unknown }
    | null;
  if (typeof body?.follow_up !== "boolean") {
    return Response.json(
      { error: "Body must be { follow_up: boolean }" },
      { status: 400 },
    );
  }
  const desired = body.follow_up;

  // Confirm the thread exists so a typo'd id surfaces instead of
  // silently writing a row pointing at nothing.
  const threadCheck = await supabase
    .from("crm_threads")
    .select("id")
    .eq("id", threadId)
    .maybeSingle();
  if (threadCheck.error) {
    console.error("[crm:follow-up] thread lookup failed", threadCheck.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!threadCheck.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }

  if (desired) {
    const ins = await supabase
      .from("crm_thread_follow_ups")
      .upsert(
        { thread_id: threadId, user_id: appUserId },
        { onConflict: "thread_id,user_id", ignoreDuplicates: true },
      );
    if (ins.error) {
      console.error("[crm:follow-up] upsert failed", ins.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
  } else {
    const del = await supabase
      .from("crm_thread_follow_ups")
      .delete()
      .eq("thread_id", threadId)
      .eq("user_id", appUserId);
    if (del.error) {
      console.error("[crm:follow-up] delete failed", del.error);
      return Response.json({ error: "DB error" }, { status: 500 });
    }
  }

  return Response.json(
    { thread_id: threadId, user_id: appUserId, follow_up: desired },
    { status: 200 },
  );
}
