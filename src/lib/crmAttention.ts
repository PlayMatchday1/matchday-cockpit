// WHICH SECTION A THREAD BELONGS IN — pure, shared by the inbox list, the nav badge and the tick, so the
// three can't disagree. NEEDS A HUMAN is the default: a player who is waiting is never in neither section.
// A thread only leaves it because a hold is running, or because someone replied.

export const STRIKE_DISPUTE_NOTE = "Strike dispute: check with the match manager";

export type AttentionDraft = {
  id: string; thread_id: string; based_on_message_id: string; created_at: string; outcome: string; error: string | null;
  decision: string | null; decision_reason: string | null; decision_shadow: boolean | null;
  hold_status: string | null; hold_note: string | null; hold_until: string | null; action_status: string | null;
  staff_notes: string | null; action: { kind: string; amount_cents: number | null } | null;
};

export type Attention = { section: "human" | "auto_sending"; reason: string | null; hold_until: string | null };
export const NO_DRAFT_YET = "No draft yet";
const usd = (c: number | null) => `$${((c ?? 0) / 100).toFixed(2)}`;
const FAILED_ACTION = new Set(["failed", "not_applied", "unknown"]);

// The strike holding reply answered the player and resolved nothing, so the thread stays with a person
// until one of them replies.
export const isStrikeHolding = (d: AttentionDraft | null) =>
  d?.hold_status === "sent" && /^\[flags: [^\]]*\bstrike_dispute\b/.test(d.staff_notes ?? "");

export function attentionFor(a: { awaiting: boolean; draft: AttentionDraft | null; humanRepliedSinceDraft: boolean }): Attention | null {
  const d = a.draft;
  const human = (reason: string): Attention => ({ section: "human", reason, hold_until: null });
  if (isStrikeHolding(d) && !a.humanRepliedSinceDraft) return human(STRIKE_DISPUTE_NOTE);
  if (!a.awaiting) return null;
  if (!d) return human(NO_DRAFT_YET);
  if (d.hold_status === "holding" || d.hold_status === "sending") return { section: "auto_sending", reason: null, hold_until: d.hold_until };
  if (d.outcome === "failed") return human(d.error ?? "The draft failed.");
  if (FAILED_ACTION.has(d.action_status ?? "")) return human(d.hold_note ?? "The action failed.");
  if (d.hold_status === "cancelled" || d.hold_status === "failed") return human(d.hold_note ?? "The auto-send was cancelled.");
  if (d.outcome === "discarded") return human("Draft discarded");
  if (d.decision === "human") return human(d.decision_reason ?? "Needs a person");
  if (d.decision && d.decision_shadow) {
    return human(d.action?.kind === "credit" ? `Would credit ${usd(d.action.amount_cents)}, auto-send is off`
      : d.action ? "Would issue a guest code, auto-send is off" : "Would auto-send, auto-send is off");
  }
  if (d.decision) return human("Auto-send didn't start");
  return human("Draft ready");
}

// The list row carries the section it was given and the message it was worked out for. A newer message
// makes that out of date until the next load, and a player is waiting, so it reads "No draft yet".
export type RowAttention = Attention & { as_of: string };
export function rowAttention(t: { awaiting: boolean; last_message_at: string; attention?: RowAttention | null }): Attention | null {
  if (t.attention && t.attention.as_of === t.last_message_at) return t.attention;
  return t.awaiting ? { section: "human", reason: NO_DRAFT_YET, hold_until: null } : null;
}

// One push, once a thread has waited 10 minutes. The 2 hours keeps a deploy or an outage from paging
// everyone about yesterday's threads.
export const HUMAN_PUSH_AFTER_MS = 10 * 60e3;
export const HUMAN_PUSH_WITHIN_MS = 2 * 3600e3;
export const humanPushDue = (enteredAtMs: number, now: number) => now - enteredAtMs >= HUMAN_PUSH_AFTER_MS && now - enteredAtMs <= HUMAN_PUSH_WITHIN_MS;
export const humanPushPath = (inboundMessageId: string) => `/crm/human-push/${inboundMessageId}`;
