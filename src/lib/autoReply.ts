// Out-of-hours auto-reply — decision logic + the reply copy.
//
// When a customer messages WhatsApp outside business hours, we send one
// free session reply (their inbound opened the 24-hour window, so no
// template is needed) letting them know our hours and that we'll follow
// up. This module owns two things, both pure and testable:
//   1. OUT_OF_HOURS_AUTO_REPLY_TEXT — the copy, a config constant.
//   2. shouldAutoReply() — whether THIS inbound should trigger a send,
//      including the once-per-closed-gap debounce.
//
// The actual Meta send + message write live in the webhook; this file has
// no I/O so the rule stays covered by unit tests.

import {
  currentClosedPeriodStartMs,
  type BusinessHoursConfig,
  DEFAULT_BUSINESS_HOURS,
} from "./businessHours";

// The reply copy. Kept as a constant (not inlined at the send site) so
// wording changes are a one-line edit and the tests can assert against
// it. Mentions the same 9am–9pm Central window the metrics use, and sets
// the expectation that a human follows up — it is an acknowledgment, not
// an answer.
export const OUT_OF_HOURS_AUTO_REPLY_TEXT =
  "Thanks for reaching out! 👋 Our support team is available 9am–9pm " +
  "Central Time. We've got your message and someone will follow up during " +
  "those hours.";

export type AutoReplyDecision = {
  // Whether to send the auto-reply for this inbound.
  send: boolean;
  // The current closed-period boundary (the debounce key) when out of
  // hours, else null. Returned so the caller can log/inspect; the send
  // decision already folds it in.
  closedPeriodStartMs: number | null;
};

// Decide whether an inbound arriving at `nowMs` should get an
// out-of-hours auto-reply.
//
// Sends only when BOTH hold:
//   • nowMs is outside business hours, AND
//   • we have not already auto-replied during THIS closed gap — i.e. the
//     thread's last auto-reply (autoReplySentAtMs) is null or predates
//     the current closed period's start.
//
// That second clause is the "once per conversation per out-of-hours gap"
// debounce: a burst of five late-night messages yields one greeting, and
// a customer who writes at 10pm and again at 6am (same gap) is not
// greeted twice — but a fresh out-of-hours gap on another night greets
// again.
export function shouldAutoReply(args: {
  nowMs: number;
  autoReplySentAtMs: number | null;
  cfg?: BusinessHoursConfig;
}): AutoReplyDecision {
  const cfg = args.cfg ?? DEFAULT_BUSINESS_HOURS;
  const closedPeriodStartMs = currentClosedPeriodStartMs(args.nowMs, cfg);

  // Within business hours → never auto-reply.
  if (closedPeriodStartMs == null) {
    return { send: false, closedPeriodStartMs: null };
  }

  // Already greeted during this closed gap → stay quiet.
  if (
    args.autoReplySentAtMs != null &&
    Number.isFinite(args.autoReplySentAtMs) &&
    args.autoReplySentAtMs >= closedPeriodStartMs
  ) {
    return { send: false, closedPeriodStartMs };
  }

  return { send: true, closedPeriodStartMs };
}
