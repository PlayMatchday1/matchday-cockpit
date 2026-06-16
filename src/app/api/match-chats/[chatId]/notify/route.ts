// GET  /api/match-chats/[chatId]/notify  - recipient preview (masked).
// POST /api/match-chats/[chatId]/notify  - send operational SMS to all
//   currently-registered PLAYER rows in the match, one personalized
//   message each via Telnyx, then write one match_notify_log audit row.
//
// chatId is the match's mdapi_matches.api_id (string), same convention
// as the rest of /match-chats.
//
// Auth: admin-only. authenticateCrm allows is_admin OR can_access_chats;
// this feature is is_admin-only per spec, so we additionally gate on
// auth.isAdmin and 403 chats-only users.
//
// Recipients are resolved server-side on BOTH verbs (never trust a
// client-supplied list). Sends use Promise.allSettled so one failure
// doesn't block the rest; per-recipient outcome is recorded in the
// audit row's recipients jsonb.

import Telnyx from "telnyx";
import { authenticateCrm } from "@/lib/crmAuth";
import { isValidChatId } from "@/lib/matchChats";
import { resolveMatchNotifyRecipients } from "@/lib/matchNotifyRecipients";
import {
  NOTIFY_TEMPLATE_IDS,
  personalize,
  unfilledTokens,
  maskPhone,
  type NotifyTemplateId,
} from "@/lib/matchNotify";

export const runtime = "nodejs";
// One Telnyx call per recipient, run in parallel. 60s leaves headroom
// for a large match (40+ players) plus the audit write.
export const maxDuration = 60;

const MAX_BODY_LEN = 1600;

type RouteCtx = { params: Promise<{ chatId: string }> };

function matchApiIdFrom(chatId: string): number | null {
  if (!chatId || !isValidChatId(chatId)) return null;
  const n = Number(chatId);
  return Number.isFinite(n) ? n : null;
}

// ---------------- GET: recipient preview ----------------

export async function GET(req: Request, ctx: RouteCtx) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const { chatId } = await ctx.params;
  const matchApiId = matchApiIdFrom(chatId);
  if (matchApiId == null) {
    return Response.json({ error: "Invalid match id" }, { status: 400 });
  }

  let resolution;
  try {
    resolution = await resolveMatchNotifyRecipients(auth.supabase, matchApiId);
  } catch (e) {
    console.error("[match-notify:preview] resolve failed", e);
    return Response.json({ error: "Could not load recipients" }, { status: 500 });
  }

  return Response.json(
    {
      recipient_count: resolution.recipients.length,
      no_phone_count: resolution.noPhoneCount,
      total_registered: resolution.totalRegistered,
      recipients: resolution.recipients.map((r) => ({
        user_id: r.userId,
        first_name: r.firstName,
        last_name: r.lastName,
        masked_phone: maskPhone(r.phoneE164),
      })),
    },
    { status: 200 },
  );
}

// ---------------- POST: send ----------------

type SendBody = { template_used?: unknown; message_body?: unknown };

export async function POST(req: Request, ctx: RouteCtx) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.isAdmin) {
    return Response.json({ error: "Admin access required" }, { status: 403 });
  }
  const { appUserId, supabase } = auth;

  const { chatId } = await ctx.params;
  const matchApiId = matchApiIdFrom(chatId);
  if (matchApiId == null) {
    return Response.json({ error: "Invalid match id" }, { status: 400 });
  }

  let parsed: SendBody;
  try {
    parsed = (await req.json()) as SendBody;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const templateUsed = parsed.template_used as NotifyTemplateId;
  const messageBody =
    typeof parsed.message_body === "string" ? parsed.message_body : "";

  if (!NOTIFY_TEMPLATE_IDS.includes(templateUsed)) {
    return Response.json({ error: "Unknown template" }, { status: 400 });
  }
  if (!messageBody.trim()) {
    return Response.json({ error: "Message is empty" }, { status: 400 });
  }
  if (messageBody.length > MAX_BODY_LEN) {
    return Response.json(
      { error: `Message exceeds ${MAX_BODY_LEN} characters` },
      { status: 400 },
    );
  }
  const leftover = unfilledTokens(messageBody);
  if (leftover.length > 0) {
    return Response.json(
      { error: `Fill in ${leftover.join(", ")} before sending` },
      { status: 400 },
    );
  }

  const apiKey = process.env.TELNYX_API_KEY;
  const fromNumber = process.env.TELNYX_FROM_NUMBER;
  if (!apiKey || !fromNumber) {
    return Response.json(
      { error: "Telnyx is not configured" },
      { status: 500 },
    );
  }

  let resolution;
  try {
    resolution = await resolveMatchNotifyRecipients(supabase, matchApiId);
  } catch (e) {
    console.error("[match-notify:send] resolve failed", e);
    return Response.json({ error: "Could not load recipients" }, { status: 500 });
  }
  const recipients = resolution.recipients;
  if (recipients.length === 0) {
    return Response.json(
      { error: "No players with a valid phone to notify" },
      { status: 422 },
    );
  }

  console.log(
    `[match-notify:send] start match=${matchApiId} user=${appUserId ?? "?"} template=${templateUsed} recipients=${recipients.length}`,
  );

  const telnyx = new Telnyx({ apiKey });
  const settled = await Promise.allSettled(
    recipients.map((r) =>
      telnyx.messages.send({
        from: fromNumber,
        to: r.phoneE164,
        text: personalize(messageBody, r.firstName),
      }),
    ),
  );

  const results = settled.map((outcome, i) => {
    const r = recipients[i];
    if (outcome.status === "fulfilled") {
      const id = outcome.value?.data?.id;
      return {
        user_id: r.userId,
        phone: r.phoneE164,
        send_status: "sent" as const,
        telnyx_message_id: typeof id === "string" ? id : null,
        error_message: null as string | null,
      };
    }
    const reason = outcome.reason;
    const msg = reason instanceof Error ? reason.message : String(reason);
    return {
      user_id: r.userId,
      phone: r.phoneE164,
      send_status: "failed" as const,
      telnyx_message_id: null,
      error_message: msg.slice(0, 300),
    };
  });

  const successCount = results.filter((r) => r.send_status === "sent").length;
  const failureCount = results.length - successCount;

  // Audit row. message_body is stored with the {first_name} token (the
  // canonical message); per-recipient text differs only by first name.
  const logInsert = await supabase
    .from("match_notify_log")
    .insert({
      match_api_id: matchApiId,
      sent_by_user_id: appUserId,
      template_used: templateUsed,
      message_body: messageBody,
      recipient_count: recipients.length,
      success_count: successCount,
      failure_count: failureCount,
      recipients: results,
    })
    .select("id")
    .single();
  if (logInsert.error) {
    // The SMS already went out; surface the audit failure but don't
    // pretend the send failed. Operator still gets the per-recipient
    // summary below.
    console.error("[match-notify:send] audit insert failed", logInsert.error);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[match-notify:send] done match=${matchApiId} sent=${successCount}/${recipients.length} failed=${failureCount} elapsed=${elapsed}ms`,
  );

  return Response.json(
    {
      log_id: logInsert.data?.id ?? null,
      recipient_count: recipients.length,
      success_count: successCount,
      failure_count: failureCount,
      failures: results
        .filter((r) => r.send_status === "failed")
        .map((r) => ({ masked_phone: maskPhone(r.phone), error: r.error_message })),
    },
    { status: 200 },
  );
}
