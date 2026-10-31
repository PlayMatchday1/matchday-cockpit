// POST /api/crm/send — outbound reply from a cockpit operator.
//
// Body: { thread_id: string, body: string, draft_id?: string }
//
// draft_id: set when the text started as a Claude draft ("Use draft"). After a SUCCESSFUL send the
// server compares what went out with the stored draft and records sent_unchanged / sent_edited and
// the edit distance on crm_ai_drafts (src/lib/aiDraftOutcome). It never changes what is sent.
//
// Auth: dual-mode bearer via src/lib/crmAuth (session JWT with
// app_users.is_admin=true, OR CRON_SECRET). Cron path records
// sent_by_user_id = null.
//
// Flow:
//   1. Auth → derive sent_by_user_id (or null for cron).
//   2. Load thread by id, read phone_number + channel.
//   3. Channel branch:
//      - 'sms'     → Telnyx Messages API (from = TELNYX_FROM_NUMBER).
//                    Stores telnyx_message_id, segment_count.
//      - 'whatsapp'→ Meta Cloud API (sendWhatsAppText).
//                    Enforces the 24-hour session window: the most
//                    recent INBOUND message in this thread must be
//                    < 24h old. 422 with a clear error otherwise.
//                    Stores external_message_id (wamid).
//   4. Insert crm_messages row (direction=outbound) on success OR
//      provider failure — the operator's reply isn't silently lost.
//      The response surfaces any provider error.
//   5. Update thread last_message_at + last_message_preview.
//   6. Return the new message row.

import Telnyx from "telnyx";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertThreadInScope } from "@/lib/crmScope";
import { authenticateCrm } from "@/lib/crmAuth";
import { logCrmSend } from "@/lib/crmSendLog";
import { recordDraftSent } from "@/lib/aiDraftOutcome";
import { autoSendAllowed, type AutoSendCheck, type AutoSendConfig } from "@/lib/aiDraftModel";
import {
  sendWhatsAppText,
  WhatsAppApiError,
} from "@/lib/whatsapp";

export const runtime = "nodejs";
export const maxDuration = 15;

const PREVIEW_LIMIT = 80;
const MAX_BODY_LEN = 1600; // ~10 SMS segments — sanity bound (WhatsApp's own cap is higher)

// WhatsApp's 24-hour customer service window. Outbound text messages
// outside this window require a pre-approved template; we don't ship
// those in Phase 1.
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

type SendBody = { thread_id?: unknown; body?: unknown; draft_id?: unknown; auto_send?: unknown };

export async function POST(req: Request) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  // SEND is its own right (Phase 19 Step 1). Gated EARLY — before any provider work — so there is
  // no reachable send path without can_send_messages: the route 403s immediately, not "late" after
  // doing work, and the composer greys as a courtesy. can_access_chats still means READ only.
  let parsed: SendBody;
  try {
    parsed = (await req.json()) as SendBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const threadId = typeof parsed.thread_id === "string" ? parsed.thread_id : "";
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const draftId = typeof parsed.draft_id === "string" && parsed.draft_id ? parsed.draft_id : null;
  if (!threadId) {
    return Response.json({ error: "thread_id required" }, { status: 400 });
  }
  {
    // THE CITY BOUNDARY: a confined caller may only touch a thread inside its scope (crmScope).
    const scope = await assertThreadInScope(auth, threadId);
    if (!scope.ok) return Response.json({ error: scope.error }, { status: scope.status });
  }
  if (!auth.canSendMessages) {
    return Response.json(
      { error: "You don't have permission to send messages.", reason: "no_send_permission" },
      { status: 403 },
    );
  }
  const { appUserId, email: actorEmail, supabase } = auth;
  // A player-visible message must have a HUMAN behind it (Phase 19 Step 2 carry-over). The cron
  // auth path (CRON_SECRET) sets canSendMessages=true for full server authority, and nothing
  // scheduled calls this route today — but requiring a real operator (appUserId != null) closes
  // the latent hole so a future scheduled job can never message a player through the operator send
  // route without a human holding the grant. The one legitimate automated path — the inbound-
  // triggered, debounced, reply-only out-of-hours auto-reply — sends via the webhook's own
  // sendWhatsAppText (a bounded system acknowledgment), never here.
  //
  // ONE EXCEPTION (Ryan, 2026-10-31): a draft the auto-send tick has moved to `sending`, whose hold has
  // ended, with auto-send live and a stored yes on that draft, carrying exactly that draft's text
  // (autoSendAllowed, src/lib/aiDraftModel). Everything else still stops here.
  let autoSentDraftId: string | null = null;
  if (!appUserId && parsed.auto_send === true && draftId) {
    const [d, c] = await Promise.all([
      supabase.from("crm_ai_drafts").select("thread_id, draft_text, decision, hold_status, hold_until, outcome").eq("id", draftId).maybeSingle(),
      supabase.from("crm_auto_send_config").select("auto_categories, action_categories, credit_cap_cents, hold_minutes, enabled, shadow").maybeSingle(),
    ]);
    if (autoSendAllowed(d.data as AutoSendCheck | null, c.data as AutoSendConfig | null, { threadId, body, now: Date.now() })) autoSentDraftId = draftId;
  }
  if (!appUserId) {
    if (!autoSentDraftId) {
      return Response.json(
        { error: "Sends require a human operator.", reason: "no_human_actor" },
        { status: 403 },
      );
    }
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

  const thread = await supabase
    .from("crm_threads")
    .select("id, phone_number, channel")
    .eq("id", threadId)
    .maybeSingle();
  if (thread.error || !thread.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const toPhone = thread.data.phone_number as string;
  const channel = (thread.data.channel as string) ?? "sms";

  console.log(
    `[crm:send] start thread=${threadId} channel=${channel} user=${appUserId ?? "cron"} bytes=${body.length}`,
  );

  // ---------------- branch by channel ----------------
  if (channel === "whatsapp") {
    return handleWhatsAppSend({
      threadId,
      toPhone,
      body,
      appUserId,
      actorEmail,
      supabase,
      startedAt,
      draftId,
      autoSentDraftId,
    });
  }
  // Default branch: SMS. Anything other than the two valid channel
  // values would have already failed the CHECK constraint on the
  // column, so reaching here implies 'sms'.
  return handleSmsSend({
    threadId,
    toPhone,
    body,
    appUserId,
    actorEmail,
    supabase,
    startedAt,
    draftId,
    autoSentDraftId,
  });
}

// A person just replied, so a hold on this thread stops. Best-effort: it never fails a delivered send,
// and the tick checks for a staff message again before it sends anything.
async function cancelHoldsForHumanSend(supabase: SupabaseClient, threadId: string, appUserId: string | null): Promise<void> {
  if (appUserId === null) return;
  const r = await supabase.from("crm_ai_drafts").update({ hold_status: "cancelled", hold_note: "A staff member replied.", hold_cancelled_by_user_id: appUserId })
    .eq("thread_id", threadId).eq("hold_status", "holding");
  if (r.error) console.error("[crm:send] hold cancel failed", r.error.message);
}

// ============================================================
// SMS path (Telnyx) — unchanged from Phase 0
// ============================================================

type SendArgs = {
  threadId: string;
  toPhone: string;
  body: string;
  appUserId: string | null;
  actorEmail: string | null;
  supabase: SupabaseClient;
  startedAt: number;
  draftId: string | null;
  autoSentDraftId: string | null;
};

async function handleSmsSend({
  threadId,
  toPhone,
  body,
  appUserId,
  actorEmail,
  supabase,
  startedAt,
  draftId,
  autoSentDraftId,
}: SendArgs) {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const fromNumber = process.env.TELNYX_FROM_NUMBER?.trim();
  if (!apiKey || !fromNumber) {
    return Response.json(
      { error: "Telnyx env not configured" },
      { status: 500 },
    );
  }

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
      channel: "sms",
      body,
      sent_at: nowIso,
      sent_by_user_id: appUserId,
      auto_sent_draft_id: autoSentDraftId,
      telnyx_message_id: telnyxMessageId,
      segment_count: segmentCount,
      // TODO Phase 2: process Telnyx delivery receipts so SMS gets
      // the full sent → delivered → failed lifecycle the WhatsApp
      // path enjoys. For now SMS stops at 'sent' or 'failed'.
      delivery_status: sendError ? "failed" : "sent",
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) {
    console.error("[crm:send] message insert failed", inserted.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  const upd = await supabase
    .from("crm_threads")
    .update({
      last_message_at: nowIso,
      last_message_preview: preview,
      // Outbound = we spoke last → thread is answered, awaiting flag
      // clears. A plain reply is never a template.
      last_message_direction: "outbound",
      last_message_is_template: false,
    })
    .eq("id", threadId);
  if (upd.error) {
    console.error("[crm:send] thread update failed", upd.error);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:send] done channel=sms thread=${threadId} telnyx_id=${telnyxMessageId ?? "-"} segments=${segmentCount} elapsed=${elapsed}ms${sendError ? ` ERROR=${sendError}` : ""}`,
  );

  await logCrmSend({ kind: "text", path: "/api/crm/send", threadId, toPhone, channel: "sms", appUserId, actorEmail, draftId: autoSentDraftId, bodyLength: body.length, sendError, nowIso });
  if (!sendError) await cancelHoldsForHumanSend(supabase, threadId, appUserId);
  if (draftId && !sendError) {
    await recordDraftSent(supabase, { draftId, threadId, sentBody: body, messageId: inserted.data.id as string, userId: appUserId });
  }

  if (sendError) {
    return Response.json(
      { message: inserted.data, send_error: sendError },
      { status: 502 },
    );
  }
  return Response.json({ message: inserted.data }, { status: 200 });
}

// ============================================================
// WhatsApp path (Meta Cloud API) — new
// ============================================================

async function handleWhatsAppSend({
  threadId,
  toPhone,
  body,
  appUserId,
  actorEmail,
  supabase,
  startedAt,
  draftId,
  autoSentDraftId,
}: SendArgs) {
  // 1. 24-hour session window check. Look up the most recent inbound
  //    message timestamp for this thread; if older than 24h, refuse
  //    the send with a 422 + clear error. The client uses this same
  //    rule to disable the composer pre-emptively.
  const lastInbound = await supabase
    .from("crm_messages")
    .select("sent_at")
    .eq("thread_id", threadId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastInbound.error) {
    console.error("[crm:send] last-inbound lookup failed", lastInbound.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const lastInboundIso = (lastInbound.data?.sent_at as string | null) ?? null;
  if (!lastInboundIso) {
    return Response.json(
      {
        error:
          "WhatsApp session expired — player must message first to reopen the 24-hour window.",
        reason: "no_inbound",
      },
      { status: 422 },
    );
  }
  const ageMs = Date.now() - Date.parse(lastInboundIso);
  if (ageMs > WHATSAPP_WINDOW_MS) {
    return Response.json(
      {
        error:
          "WhatsApp session expired — player must message first to reopen the 24-hour window.",
        reason: "window_expired",
        last_inbound_at: lastInboundIso,
      },
      { status: 422 },
    );
  }

  // 2. Send via Meta. Errors get surfaced; on failure we still
  //    persist the outbound row (external_message_id=null) so the
  //    operator can see it didn't go out.
  let wamid: string | null = null;
  let sendError: string | null = null;
  try {
    const result = await sendWhatsAppText(toPhone, body);
    wamid = result.messageId;
  } catch (err) {
    if (err instanceof WhatsAppApiError) {
      sendError = `Meta ${err.status}: ${
        typeof err.body === "string"
          ? err.body
          : JSON.stringify(err.body).slice(0, 500)
      }`;
    } else {
      sendError = err instanceof Error ? err.message : String(err);
    }
    console.error("[crm:send] whatsapp send failed", sendError);
  }

  const nowIso = new Date().toISOString();
  const preview = body.slice(0, PREVIEW_LIMIT);

  const inserted = await supabase
    .from("crm_messages")
    .insert({
      thread_id: threadId,
      direction: "outbound",
      channel: "whatsapp",
      body,
      sent_at: nowIso,
      sent_by_user_id: appUserId,
      auto_sent_draft_id: autoSentDraftId,
      external_message_id: wamid,
      // segment_count column is SMS-only; WhatsApp has no segments.
      // Leave at the DB default (1).
      //
      // 'sent' is the correct initial state after a 2xx from Meta —
      // the wamid in hand means the message was accepted. The
      // status webhook (handled in /api/whatsapp/webhook) will move
      // it to 'delivered' or 'read' as confirmation arrives. Send-
      // time failures go straight to 'failed' so the UI shows the
      // outbound row in red even before any webhook lands.
      delivery_status: sendError ? "failed" : "sent",
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) {
    console.error("[crm:send] message insert failed", inserted.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  const upd = await supabase
    .from("crm_threads")
    .update({
      last_message_at: nowIso,
      last_message_preview: preview,
      // Outbound = we spoke last → thread is answered, awaiting flag
      // clears. A plain reply is never a template.
      last_message_direction: "outbound",
      last_message_is_template: false,
    })
    .eq("id", threadId);
  if (upd.error) {
    console.error("[crm:send] thread update failed", upd.error);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:send] done channel=whatsapp thread=${threadId} wamid=${wamid ?? "-"} elapsed=${elapsed}ms${sendError ? ` ERROR=${sendError}` : ""}`,
  );

  await logCrmSend({ kind: "text", path: "/api/crm/send", threadId, toPhone, channel: "whatsapp", appUserId, actorEmail, draftId: autoSentDraftId, bodyLength: body.length, sendError, nowIso });
  if (!sendError) await cancelHoldsForHumanSend(supabase, threadId, appUserId);
  if (draftId && !sendError) {
    await recordDraftSent(supabase, { draftId, threadId, sentBody: body, messageId: inserted.data.id as string, userId: appUserId });
  }

  if (sendError) {
    return Response.json(
      { message: inserted.data, send_error: sendError },
      { status: 502 },
    );
  }
  return Response.json({ message: inserted.data }, { status: 200 });
}
