// POST /api/crm/send-template — send a pre-approved WhatsApp template
// from a CRM thread. This is the ONLY outbound path allowed outside
// the 24-hour service window, so it is deliberately NOT window-gated.
//
// Body: { thread_id: string, template_name: string,
//         variables: { [key]: string } }
//
// Flow:
//   1. Auth (dual-mode bearer via crmAuth).
//   2. Load thread; must be a WhatsApp thread.
//   3. Resolve the template from the code registry; validate every
//      required variable is present + non-empty (Meta rejects empty
//      body params, so we block them before the API call).
//   4. Send via sendWhatsAppTemplate (type: "template" payload).
//   5. Insert the outbound crm_messages row with the rendered body
//      text + template_name (for cost reconciliation), sent or failed.
//   6. Update thread last_message_at / preview. If the thread was
//      closed, reopen it (a template send is an explicit re-engage)
//      and log the reopen.
//   7. Return the new message row (surfaces any Meta error).
//
// Marketing note: support_followup is a Marketing-category template
// (Meta overrode the requested Utility). Each send is billable; Meta
// enforces marketing opt-outs and returns an error we surface + mark
// the row failed. No internal opt-in/opt-out ledger in v1.

import { authenticateCrm } from "@/lib/crmAuth";
import { sendWhatsAppTemplate, WhatsAppApiError } from "@/lib/whatsapp";
import { getTemplate, renderTemplateBody } from "@/lib/whatsappTemplates";
import { writeThreadStatusLog } from "@/lib/crmThreadStatus";

export const runtime = "nodejs";
export const maxDuration = 15;

const PREVIEW_LIMIT = 80;

type Body = {
  thread_id?: unknown;
  template_name?: unknown;
  variables?: unknown;
};

export async function POST(req: Request) {
  const startedAt = Date.now();
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { appUserId, supabase } = auth;

  let parsed: Body;
  try {
    parsed = (await req.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const threadId =
    typeof parsed.thread_id === "string" ? parsed.thread_id : "";
  const templateName =
    typeof parsed.template_name === "string" ? parsed.template_name : "";
  const rawVars =
    parsed.variables && typeof parsed.variables === "object"
      ? (parsed.variables as Record<string, unknown>)
      : {};
  if (!threadId) {
    return Response.json({ error: "thread_id required" }, { status: 400 });
  }

  const tpl = getTemplate(templateName);
  if (!tpl) {
    return Response.json(
      { error: `Unknown template: ${templateName}` },
      { status: 400 },
    );
  }

  // Validate + collect variables in the template's declared order.
  const vars: Record<string, string> = {};
  for (const v of tpl.variables) {
    const val = typeof rawVars[v.key] === "string" ? (rawVars[v.key] as string).trim() : "";
    if (v.required && !val) {
      return Response.json(
        { error: `${v.label} is required` },
        { status: 400 },
      );
    }
    vars[v.key] = val;
  }

  const thread = await supabase
    .from("crm_threads")
    .select("id, phone_number, channel, status")
    .eq("id", threadId)
    .maybeSingle();
  if (thread.error || !thread.data) {
    return Response.json({ error: "Thread not found" }, { status: 404 });
  }
  const toPhone = thread.data.phone_number as string;
  const channel = (thread.data.channel as string) ?? "sms";
  const wasClosed = ((thread.data.status as string | null) ?? "open") === "closed";
  if (channel !== "whatsapp") {
    return Response.json(
      { error: "Templates can only be sent on WhatsApp threads" },
      { status: 400 },
    );
  }

  const renderedBody = renderTemplateBody(tpl, vars);
  const bodyParams = tpl.variables.map((v) => ({
    name: v.key,
    text: vars[v.key],
  }));

  console.log(
    `[crm:send-template] start thread=${threadId} template=${templateName} user=${appUserId ?? "cron"}`,
  );

  // Send via Meta. On failure, still persist the outbound row so the
  // operator sees it didn't go out (with the Meta error surfaced).
  let wamid: string | null = null;
  let sendError: string | null = null;
  try {
    const result = await sendWhatsAppTemplate({
      toPhone,
      templateName: tpl.name,
      languageCode: tpl.languageCode,
      bodyParams,
    });
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
    console.error("[crm:send-template] whatsapp send failed", sendError);
  }

  const nowIso = new Date().toISOString();
  const preview = renderedBody.slice(0, PREVIEW_LIMIT);

  const inserted = await supabase
    .from("crm_messages")
    .insert({
      thread_id: threadId,
      direction: "outbound",
      channel: "whatsapp",
      body: renderedBody,
      sent_at: nowIso,
      sent_by_user_id: appUserId,
      external_message_id: wamid,
      template_name: tpl.name,
      delivery_status: sendError ? "failed" : "sent",
    })
    .select("*")
    .single();
  if (inserted.error || !inserted.data) {
    console.error("[crm:send-template] message insert failed", inserted.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }

  // Thread update. On a successful send, reopen a closed thread (the
  // operator is re-engaging) so it does not sit in Closed while an
  // outbound sits on it.
  const doReopen = !sendError && wasClosed;
  const patch: Record<string, unknown> = {
    last_message_at: nowIso,
    last_message_preview: preview,
  };
  if (doReopen) {
    patch.status = "open";
    patch.closed_at = null;
    patch.closed_by_user_id = null;
  }
  const upd = await supabase
    .from("crm_threads")
    .update(patch)
    .eq("id", threadId);
  if (upd.error) {
    console.error("[crm:send-template] thread update failed", upd.error);
  } else if (doReopen) {
    await writeThreadStatusLog(supabase, {
      threadId,
      action: "reopen",
      performedByUserId: appUserId,
      reason: "template_send",
    });
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `[crm:send-template] done thread=${threadId} template=${templateName} wamid=${wamid ?? "-"} reopened=${doReopen} elapsed=${elapsed}ms${sendError ? ` ERROR=${sendError}` : ""}`,
  );

  if (sendError) {
    return Response.json(
      { message: inserted.data, send_error: sendError },
      { status: 502 },
    );
  }
  return Response.json({ message: inserted.data }, { status: 200 });
}
