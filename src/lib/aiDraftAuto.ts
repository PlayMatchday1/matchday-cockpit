// AUTO-SEND: WHAT HAPPENS WHEN A HOLD ENDS — the sequence, with every outside dependency injected so
// scripts/ai-draft-test.ts can assert it without a network call. src/lib/aiDraftAutoRun.ts wires it up.
//
// Order: anything that should stop this send stops it before money moves. Claim the row. Apply the
// action. Send. One attempt at each: a write that fails sends nothing and routes to a person, and a send
// that fails is not retried, because a duplicate message is visible to a player.

import { isAutoSendLive, isStaffReply, type AutoSendConfig, type DraftMsg } from "@/lib/aiDraftModel";
import { whatsappWindowExpired } from "@/lib/crmWindow";
import type { ActionResult } from "@/lib/aiDraftAction";
import type { StoredAction } from "@/lib/aiDraftRun";

export type HoldRow = {
  id: string; thread_id: string; based_on_message_id: string; created_at: string; hold_until: string | null;
  draft_text: string | null; decision: string | null; action: StoredAction | null;
};

export type HoldIO = {
  now: () => number;
  config: () => Promise<AutoSendConfig>;
  thread: (threadId: string) => Promise<{ channel: string; msgs: DraftMsg[] }>;
  /** Moves the hold from one status to another. False if another run already moved it. */
  moveHold: (id: string, from: string, to: string, note: string | null) => Promise<boolean>;
  routeToHuman: (id: string, reason: string) => Promise<void>;
  applyAction: (d: HoldRow) => Promise<ActionResult>;
  send: (d: HoldRow, text: string) => Promise<{ ok: boolean; error?: string }>;
};

export type HoldOutcome = "sent" | "cancelled" | "failed" | "skipped";

// Why this hold shouldn't go out now, or null. A person replying, or the player writing again, makes the
// draft out of date. The player's new message gets its own draft.
export function holdStopReason(d: HoldRow, msgs: readonly DraftMsg[], channel: string, config: AutoSendConfig, now: number): string | null {
  if (!isAutoSendLive(config)) return "Auto-send is off.";
  const made = Date.parse(d.created_at);
  if (msgs.some((m) => isStaffReply(m) && Date.parse(m.sent_at) >= made)) return "A staff member replied.";
  const based = msgs.find((m) => m.id === d.based_on_message_id);
  const basedAt = based ? Date.parse(based.sent_at) : made;
  if (msgs.some((m) => m.direction === "inbound" && m.media_kind !== "reaction" && m.id !== d.based_on_message_id && Date.parse(m.sent_at) > basedAt)) return "The player wrote again.";
  const lastInbound = [...msgs].reverse().find((m) => m.direction === "inbound");
  if (whatsappWindowExpired(channel, lastInbound?.sent_at ?? null, now)) return "The WhatsApp window closed.";
  return null;
}

export async function processHold(d: HoldRow, io: HoldIO): Promise<HoldOutcome> {
  const [config, thread] = await Promise.all([io.config(), io.thread(d.thread_id)]);
  const stop = holdStopReason(d, thread.msgs, thread.channel, config, io.now());
  if (stop) {
    await io.moveHold(d.id, "holding", "cancelled", stop);
    return "cancelled";
  }
  if (!(await io.moveHold(d.id, "holding", "sending", null))) return "skipped";

  let text = d.draft_text ?? "";
  if (d.action) {
    const r = await io.applyAction(d);
    if (!r.ok) {
      const note = `Auto-send stopped, nothing was sent: ${r.error}`;
      await io.moveHold(d.id, "sending", "failed", note);
      await io.routeToHuman(d.id, note);
      return "failed";
    }
    text = r.text;
  }
  const sent = await io.send(d, text).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  if (!sent.ok) {
    const note = `${d.action ? "The action landed but the" : "The"} reply may not have gone out, check the thread before sending: ${sent.error ?? "no answer"}`;
    await io.moveHold(d.id, "sending", "failed", note);
    await io.routeToHuman(d.id, note);
    return "failed";
  }
  await io.moveHold(d.id, "sending", "sent", null);
  return "sent";
}
