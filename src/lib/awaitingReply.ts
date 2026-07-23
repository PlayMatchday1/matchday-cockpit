// "Awaiting reply" = the customer sent the last message and we haven't
// answered. This module owns the escalation math: how the age of that
// unanswered inbound maps to a visual tier, keyed to the WhatsApp
// 24-hour customer-service window.
//
// The tiers exist because replying to a WhatsApp thread is FREE only
// within 24h of the customer's last message; past that, an operator
// must send a (billable, Marketing-category) support_followup template
// to re-engage. So the escalation isn't cosmetic — red means "answering
// now costs money and needs the template flow."
//
// Thresholds are tunable constants, deliberately not magic numbers at
// the call site.

// < CLOSING → fresh (reply normally). At/after CLOSING and before
// CLOSED → the free-reply window is closing soon. At/after CLOSED →
// the window has shut; a template is required to reply.
export const AWAITING_WINDOW_CLOSING_HOURS = 12;
export const AWAITING_WINDOW_CLOSED_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

export type AwaitingTier = "fresh" | "closing" | "closed";

export type AwaitingState = {
  tier: AwaitingTier;
  // Whole-hours since the customer's last message. Handy for tests and
  // any caller that wants the raw age without re-parsing.
  ageHours: number;
  // Compact age for the row chip: "45m", "18h", "2d".
  ageLabel: string;
  // Short qualifier shown after the age on amber/red chips. Empty for
  // fresh (the age alone reads fine).
  note: string;
};

// Compact, human age. Minutes under an hour, hours up to two days (so a
// 27-hour-old thread still reads "27h", matching the mock's intent that
// the closed-window hours stay legible), then days.
export function awaitingAgeLabel(fromIso: string, nowMs: number): string {
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return "";
  const diffMs = Math.max(0, nowMs - then);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(diffMs / HOUR_MS);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(diffMs / (24 * HOUR_MS))}d`;
}

// A thread is awaiting OUR reply when it is open and the customer sent
// the last message. This is the single source of truth for the
// grouping, the row indicator, and the awaiting count — used by both
// the render and the realtime reconciliation so they can never drift.
export function isAwaitingReply(t: {
  status: "open" | "closed";
  last_message_direction: "inbound" | "outbound" | null;
}): boolean {
  return t.status === "open" && t.last_message_direction === "inbound";
}

// Guard against stale / out-of-order realtime crm_threads events
// reverting a newer state. Returns true only when the incoming row is
// at least as recent as the copy we already hold. A missing/unparseable
// incoming timestamp is treated as "apply" (never block on bad data).
export function isFreshThreadUpdate(
  existingLastAt: string,
  incomingLastAt: string | null | undefined,
): boolean {
  if (!incomingLastAt) return true;
  const a = Date.parse(existingLastAt);
  const b = Date.parse(incomingLastAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return true;
  return b >= a;
}

// Escalation tier for an unanswered inbound of the given age. Boundaries
// are inclusive at the top: exactly 12h is already "closing", exactly
// 24h is already "closed" — erring toward surfacing urgency sooner.
export function awaitingReplyState(
  lastInboundIso: string,
  nowMs: number,
): AwaitingState {
  const then = Date.parse(lastInboundIso);
  const ageMs = Number.isNaN(then) ? 0 : Math.max(0, nowMs - then);
  const ageHours = ageMs / HOUR_MS;
  const ageLabel = awaitingAgeLabel(lastInboundIso, nowMs);

  if (ageHours >= AWAITING_WINDOW_CLOSED_HOURS) {
    return {
      tier: "closed",
      ageHours,
      ageLabel,
      note: "window closed — template required",
    };
  }
  if (ageHours >= AWAITING_WINDOW_CLOSING_HOURS) {
    return { tier: "closing", ageHours, ageLabel, note: "window closing" };
  }
  return { tier: "fresh", ageHours, ageLabel, note: "" };
}
