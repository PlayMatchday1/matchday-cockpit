// POST /api/crm/threads/[id]/no-reply — mark a thread "no reply needed"
// or reactivate it, without sending a reply or closing it.
//
// Body: { action: "dismiss" | "reactivate" }
//   dismiss    → no_reply_needed_at = now(). The thread leaves the
//                Awaiting queue for the muted "Wrapping up" state. A new
//                inbound (which advances last_message_at past this stamp)
//                revives it automatically.
//   reactivate → no_reply_needed_at = null ("Reply anyway"). The thread
//                is governed again purely by direction + the ack heuristic.
//
// This is distinct from close/reopen — the thread stays OPEN either way;
// only its awaiting classification changes. It is also distinct from
// sending a reply: no message is written, so the Median first-response
// metric is untouched.
//
// Permissions: any chat operator (is_admin OR can_access_chats) from an
// attributable session. Mirrors the status route.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

const UUID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const THREAD_COLS =
  "id, phone_number, player_id, match_ambiguous, last_message_at, last_message_preview, last_message_direction, last_message_is_template, created_at, assigned_to_user_id, assigned_at, channel, status, closed_at, closed_by_user_id, no_reply_needed_at";

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: RouteCtx) {
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

  const { id: threadId } = await ctx.params;
  if (!threadId || !UUID_RX.test(threadId)) {
    return Response.json({ error: "Invalid thread id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown }
    | null;
  const action = body?.action;
  if (action !== "dismiss" && action !== "reactivate") {
    return Response.json(
      { error: 'Body must be { action: "dismiss" | "reactivate" }' },
      { status: 400 },
    );
  }

  const patch = {
    no_reply_needed_at: action === "dismiss" ? new Date().toISOString() : null,
  };

  const upd = await supabase
    .from("crm_threads")
    .update(patch)
    .eq("id", threadId)
    .select(THREAD_COLS)
    .single();
  if (upd.error || !upd.data) {
    console.error("[crm:no-reply] update failed", upd.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  console.log(
    `[crm:no-reply] thread=${threadId} ${action} by=${appUserId}`,
  );

  return Response.json({ thread: upd.data }, { status: 200 });
}
