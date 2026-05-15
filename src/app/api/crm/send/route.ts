// POST /api/crm/send — outbound SMS from a cockpit operator.
//
// Body: { thread_id: string, body: string }
//
// Auth: dual-mode bearer via src/lib/crmAuth (session JWT with
// app_users.is_admin=true, OR CRON_SECRET). Cron path records
// sent_by_user_id = null.
//
// Flow:
//   1. Auth → derive sent_by_user_id (or null for cron).
//   2. Load thread by id, read phone_number.
//   3. Send via Telnyx Messages API (from = TELNYX_FROM_NUMBER).
//   4. Insert crm_messages row (direction=outbound). On Telnyx
//      failure we still insert with telnyx_message_id=null so the
//      operator's reply isn't silently lost — the response surfaces
//      the error.
//   5. Update thread last_message_at + last_message_preview.
//   6. Return the new message row.
//
// Logging: every send is logged to console for the first week.

import Telnyx from "telnyx";
import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 15;

const PREVIEW_LIMIT = 80;
const MAX_BODY_LEN = 1600; // ~10 SMS segments — sanity bound

type SendBody = { thread_id?: unknown; body?: unknown };

export async function POST(req: Request) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { appUserId, supabase } = auth;

  let parsed: SendBody;
  try {
    parsed = (await req.json()) as SendBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!threadId) {
    return Response.json({ error: "thread_id required" }, { status: 400 });
  }
  if (!body.trim()) {
    return Response.json({ error: "body required" }, { status: 400 });
  }
  if (body.length > MAX_BODY_LEN) {
    return Response.json(
      { error: `body exceeds ${MAX_BODY_LEN} chars` },
      { status: 400 },
    );
  }

  const apiKey = process.env.TELNYX_API_KEY;
  const fromNumber = process.env.TELNYX_FROM_NUMBER;
  if (!apiKey || !fromNumber) {
    return Response.json(
      { error: "Telnyx env not configured" },
      { status: 500 },
    );
  }

  const thread = await supabase
    .from("crm_threads")
    .select("id, phone_number")
    .eq("id", threadId)
    .maybeSingle();
  if (thread.error || !thread.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const toPhone = thread.data.phone_number as string;

  console.log(
    `[crm:send] start thread=${threadId} to=${toPhone} user=${appUserId ?? "cron"} bytes=${body.length}`,
  );

  const telnyx = new Telnyx({ apiKey });
  let telnyxMessageId: string | null = null;
  let segmentCount = 1;
  let sendError: string | null = null;
  try {
    const resp = await telnyx.messages.send({
      from: fromNumber,
      to: toPhone,
      text: body,
    });
    const data = resp.data;
    if (data) {
      telnyxMessageId = typeof data.id === "string" ? data.id : null;
      const parts =
        typeof (data as { parts?: number }).parts === "number"
          ? (data as { parts?: number }).parts
          : null;
      if (parts != null && parts > 0) segmentCount = parts;
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error("[crm:send] telnyx send failed", sendError);
  }

  const nowIso = new Date().toISOString();
  const preview = body.slice(0, PREVIEW_LIMIT);

  const inserted = await supabase
    .from("crm_messages")
    .insert({
      thread_id: threadId,
      direction: "outbound",
      body,
      sent_at: nowIso,
      sent_by_user_id: appUserId,
      telnyx_message_id: telnyxMessageId,
      segment_count: segmentCount,
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) {
    console.error("[crm:send] message insert failed", inserted.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  const upd = await supabase
    .from("crm_threads")
    .update({ last_message_at: nowIso, last_message_preview: preview })
    .eq("id", threadId);
  if (upd.error) {
    console.error("[crm:send] thread update failed", upd.error);
    // Message was stored; UI will reconcile via realtime. Don't fail
    // the response.
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:send] done thread=${threadId} telnyx_id=${telnyxMessageId ?? "-"} segments=${segmentCount} elapsed=${elapsed}ms${sendError ? ` ERROR=${sendError}` : ""}`,
  );

  if (sendError) {
    return Response.json(
      { message: inserted.data, telnyx_error: sendError },
      { status: 502 },
    );
  }

  return Response.json({ message: inserted.data }, { status: 200 });
}
