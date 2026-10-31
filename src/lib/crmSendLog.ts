import "server-only"; // no-op under --conditions=react-server
// EVERY OUTBOUND PLAYER MESSAGE IS RECORDED HERE — text (/api/crm/send), media
// (/api/crm/send-media) and approved templates (/api/crm/send-template). Until 2026-10-20 only the
// text route recorded, so the change log was NOT the complete record of what we have said to
// players that docs/matchday-api-facts.md said it was. One helper now, called by all three, so a
// fourth send path inherits the same shape instead of forgetting it.
//
// METADATA ONLY. Thread id, recipient LAST-4 (a hint, not the full number — Phase 19 Step 3b),
// channel, actor, timestamp and message LENGTH. NEVER the body, the caption, the template variables
// or the full phone: all player PII, and the text already lives in crm_messages; copying it into an
// audit table with a different (is_admin) audience is a second store of the same PII. The helper
// takes a LENGTH, not the text, so the body structurally cannot reach the log.
//
// `write` is a no-op that reflects the provider outcome the caller already knows, so recordWrite
// classifies landed vs failed; the real send happened before this is called. Best-effort: it never
// throws over the send.

import { randomUUID } from "node:crypto";
import { recordWrite, supabaseLogStore, phoneLast4, type LogStore } from "@/lib/changeLog";

export type CrmSendKind = "text" | "media" | "template";

export type CrmSendLogArgs = {
  kind: CrmSendKind;
  path: "/api/crm/send" | "/api/crm/send-media" | "/api/crm/send-template";
  threadId: string;
  toPhone: string;
  channel: "sms" | "whatsapp";
  appUserId: string | null;
  actorEmail: string | null;
  bodyLength: number;
  sendError: string | null;
  nowIso: string;
  /** Non-PII labels only: which media kind, which approved template. */
  mediaKind?: string | null;
  templateName?: string | null;
  /** An auto-send: the draft it came from. Nobody typed it, so the actor reads auto-send. */
  draftId?: string | null;
};

export function crmSendLogBody(args: CrmSendLogArgs): Record<string, unknown> {
  return {
    thread_id: args.threadId,
    recipient_last4: phoneLast4(args.toPhone),
    channel: args.channel,
    kind: args.kind,
    message_length: args.bodyLength,
    ...(args.mediaKind ? { media_kind: args.mediaKind } : {}),
    ...(args.templateName ? { template_name: args.templateName } : {}),
    ...(args.draftId ? { draft_id: args.draftId } : {}),
  };
}

const describe = (a: CrmSendLogArgs) =>
  a.kind === "media" ? `${a.channel} ${a.mediaKind ?? "media"} · caption ${a.bodyLength} chars`
  : a.kind === "template" ? `${a.channel} template ${a.templateName ?? ""} · ${a.bodyLength} chars`.replace("  ", " ")
  : `${a.channel} message · ${a.bodyLength} chars`;

export async function logCrmSend(args: CrmSendLogArgs, store: LogStore = supabaseLogStore()): Promise<void> {
  try {
    await recordWrite(
      {
        env: "production", source: "crm-send",
        actorName: args.actorEmail ?? (args.appUserId ? args.appUserId : args.draftId ? "auto-send" : "cron"),
        actorEmail: args.actorEmail ?? null,
        saveId: randomUUID(),
        matchId: null, matchName: null,
        method: "POST", path: args.path,
        // metadata ONLY — no message text ever enters change_log.
        body: crmSendLogBody(args),
        keys: [], label: (k) => k,
        applied: () => !args.sendError,
        changes: [{ key: "message", field: "Message", before: "", after: describe(args) }],
      },
      {
        readResource: async () => ({}),
        write: async () => { if (args.sendError) throw new Error(args.sendError); return true; },
        now: () => args.nowIso,
      },
      store,
    );
  } catch (e) {
    console.error(`[crm:${args.kind}] change_log record failed (send already happened):`, e);
  }
}
