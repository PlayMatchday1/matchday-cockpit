// PATCH /api/crm/threads/[id]/assign — set or clear a thread's
// assignee. Audit-logged to crm_assignment_log.
//
// Body: { user_id: string | null }
//   - non-null uuid → set assigned_to_user_id, stamp assigned_at = now()
//   - null         → unassign (the "Unassign" option in the dropdown)
//
// Auth: dual-mode bearer via src/lib/crmAuth. Session path enforces
// corp gate (app_users.is_admin = true). Cron path records a log row
// with changed_by_user_id = null (audit-honest about server writes).
//
// Two writes are sequential, not transactional: UPDATE crm_threads
// then INSERT crm_assignment_log. If the log insert fails after the
// update succeeds, the thread state is correct but an audit row is
// missing — we log loudly and return success because the user-facing
// assignment did land. A periodic audit-gap scan can reconcile.
//
// Response: { thread: <updated row>, assignee: <app_users row | null> }

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AssignBody = { user_id?: unknown };

type RouteCtx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: RouteCtx) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase, appUserId } = auth;

  const { id: threadId } = await ctx.params;
  if (!threadId || !UUID_RX.test(threadId)) {
    return Response.json({ error: "Invalid thread id" }, { status: 400 });
  }

  let parsed: AssignBody;
  try {
    parsed = (await req.json()) as AssignBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  // user_id is required in the payload — distinguish "null = unassign"
  // from "key missing = bad request". `null` is intentional, undefined
  // is not.
  if (!("user_id" in parsed)) {
    return Response.json({ error: "user_id required" }, { status: 400 });
  }
  const raw = parsed.user_id;
  let toUserId: string | null;
  if (raw === null) {
    toUserId = null;
  } else if (typeof raw === "string" && UUID_RX.test(raw)) {
    toUserId = raw;
  } else {
    return Response.json(
      { error: "user_id must be a uuid or null" },
      { status: 400 },
    );
  }

  // Look up the thread (and prior assignee for the audit row).
  const cur = await supabase
    .from("crm_threads")
    .select("id, assigned_to_user_id")
    .eq("id", threadId)
    .maybeSingle();
  if (cur.error) {
    console.error("[crm:assign] read failed", cur.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  if (!cur.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const fromUserId = (cur.data.assigned_to_user_id as string | null) ?? null;

  // No-op shortcut: clicking the same assignee shouldn't write an
  // audit row.
  if (fromUserId === toUserId) {
    return Response.json(
      {
        thread: cur.data,
        assignee: null,
        noop: true,
      },
      { status: 200 },
    );
  }

  // If a non-null toUserId was requested, make sure it's actually an
  // admin operator. Frontend dropdown already filters, but defense in
  // depth.
  let assignee: {
    id: string;
    email: string;
    full_name: string | null;
  } | null = null;
  if (toUserId != null) {
    const op = await supabase
      .from("app_users")
      .select("id, email, full_name, is_admin")
      .eq("id", toUserId)
      .maybeSingle();
    if (op.error || !op.data) {
      return Response.json({ error: "User not found" }, { status: 404 });
    }
    if (op.data.is_admin !== true) {
      return Response.json(
        { error: "Target user is not a corp operator" },
        { status: 403 },
      );
    }
    assignee = {
      id: op.data.id as string,
      email: op.data.email as string,
      full_name: (op.data.full_name as string | null) ?? null,
    };
  }

  const nowIso = new Date().toISOString();

  // Update the thread row.
  const upd = await supabase
    .from("crm_threads")
    .update({
      assigned_to_user_id: toUserId,
      assigned_at: nowIso,
    })
    .eq("id", threadId)
    .select(
      "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, created_at, assigned_to_user_id, assigned_at",
    )
    .single();
  if (upd.error || !upd.data) {
    console.error("[crm:assign] thread update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // Audit row.
  const logIns = await supabase.from("crm_assignment_log").insert({
    thread_id: threadId,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    changed_by_user_id: appUserId,
    changed_at: nowIso,
  });
  if (logIns.error) {
    // Don't fail the response — the user-facing assignment landed.
    // Audit gap is recoverable; loud log so we notice.
    console.error("[crm:assign] AUDIT GAP — log insert failed", logIns.error);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:assign] thread=${threadId} from=${fromUserId ?? "-"} to=${toUserId ?? "-"} by=${appUserId ?? "cron"} elapsed=${elapsed}ms`,
  );

  return Response.json(
    { thread: upd.data, assignee },
    { status: 200 },
  );
}
