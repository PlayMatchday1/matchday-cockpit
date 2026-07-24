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
  // Full qualifier — used in tooltips and wider surfaces.
  //   closing → "window closing"
  //   closed  → "window closed — template required"
  //   fresh   → "" (age alone reads fine)
  note: string;
  // One-line qualifier for the narrow list chip, so the combined
  // "age · note" never wraps and crushes the name.
  //   closing → "closing"
  //   closed  → "template required"
  //   fresh   → ""
  shortNote: string;
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

// ============================================================
// Acknowledgment detection ("no reply needed")
// ============================================================
// The awaiting queue used to flag ANY inbound-last thread, which
// over-counts: a closing courtesy — "Thank you", "Okay thanks", 👍 — is
// inbound-last but needs no reply. These are suppressed so they don't sit
// in the red Awaiting group next to a genuine cancellation request.
//
// The detection is deliberately STRICT. The dangerous failure is
// suppressing a real question ("thanks, but when does it start?"); the
// safe failure is leaving a genuine ack in the queue. So we suppress ONLY
// when the WHOLE trimmed message is a known short acknowledgment, is
// under ACK_MAX_LEN characters, and contains no question mark. Anything
// with extra substance stays awaiting.
//
// Both sets are tunable. Add sparingly — every phrase is a chance to
// over-suppress.

export const ACK_MAX_LEN = 20;

// Exact whole-message matches (after lowercasing + stripping trailing
// punctuation and surrounding quotes). NOT substring matches.
export const ACK_PHRASES: ReadonlySet<string> = new Set([
  "thanks", "thank you", "thankyou", "thank u", "thanks so much",
  "thank you so much", "thanks a lot", "thanks a ton", "thx", "thnx",
  "tks", "ty", "tysm", "tyvm", "ok", "okay", "okey", "k", "kk",
  "ok thanks", "okay thanks", "ok thank you", "okay thank you", "ok ty",
  "okay ty", "ok great", "okay great", "great thanks", "thanks great",
  "perfect thanks", "thanks perfect", "got it", "gotcha", "great",
  "perfect", "awesome", "excellent", "cool", "nice", "sounds good",
  "sounds great", "will do", "understood", "noted", "cheers",
  "appreciate it", "appreciated", "much appreciated", "all good",
  "all set", "good to know", "no worries", "no problem", "np", "yep",
  "yes thanks", "no thanks", "alright", "roger", "roger that",
]);

// Single-codepoint ack emojis, matched after stripping variation
// selectors, skin-tone modifiers, ZWJ, and whitespace. A message that is
// ENTIRELY these (e.g. "👍", "🙏🙏") is an acknowledgment; anything with
// words mixed in is not.
export const ACK_EMOJI: ReadonlySet<string> = new Set([
  "👍", "🙏", "❤", "👌", "✅", "🙌", "👏", "😊", "💪", "🤝", "🔥", "💯",
  "🎉", "😁", "🥳", "👊", "💚", "💙",
]);

// Codepoints to ignore when testing "emoji-only": variation selectors,
// Fitzpatrick skin-tone modifiers, and the zero-width joiner.
function isEmojiModifier(cp: number): boolean {
  return (
    cp === 0xfe0f || // variation selector-16 (emoji presentation)
    cp === 0xfe0e || // variation selector-15 (text presentation)
    cp === 0x200d || // zero-width joiner
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // skin-tone modifiers
  );
}

// True when the message is composed solely of acknowledgment emojis
// (plus modifiers / whitespace). "👍" and "🙏 🙏" pass; "👍 thanks" and
// "😡" do not.
function isAckEmojiOnly(trimmed: string): boolean {
  let sawEmoji = false;
  for (const ch of trimmed) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (isEmojiModifier(cp)) continue;
    if (ACK_EMOJI.has(ch)) {
      sawEmoji = true;
      continue;
    }
    return false; // a non-ack, non-modifier character → not emoji-only
  }
  return sawEmoji;
}

// Whether the last inbound message is ENTIRELY a short closing
// acknowledgment that needs no reply. Conservative by design — see the
// section header. A missing/empty preview is NOT an acknowledgment (we
// never suppress on absence of content).
export function isAcknowledgment(preview: string | null | undefined): boolean {
  if (!preview) return false;
  const trimmed = preview.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > ACK_MAX_LEN) return false;
  // Any question mark (ASCII or full-width) means they're asking us
  // something — always keep it awaiting.
  if (trimmed.includes("?") || trimmed.includes("？")) return false;

  // Emoji-only acknowledgment (checked on the raw trimmed text so casing
  // / punctuation stripping can't disturb the codepoints).
  if (isAckEmojiOnly(trimmed)) return true;

  // Text acknowledgment: lowercase, strip trailing sentence punctuation
  // and surrounding quotes, then require a whole-message set match.
  const normalized = trimmed
    .toLowerCase()
    .replace(/^["'“”‘’\s]+/, "")
    .replace(/["'“”‘’.!,…\s]+$/, "")
    .trim();
  return ACK_PHRASES.has(normalized);
}

// Whether an operator has manually dismissed the thread ("Done · no reply
// needed") and that dismissal still stands. It stands only while it is at
// least as recent as the last message — a newer inbound supersedes it, so
// a fresh customer message re-enters the queue automatically.
function isManuallyDismissed(t: {
  last_message_at?: string | null;
  no_reply_needed_at?: string | null;
}): boolean {
  if (!t.no_reply_needed_at) return false;
  const dismissedMs = Date.parse(t.no_reply_needed_at);
  if (!Number.isFinite(dismissedMs)) return false;
  if (!t.last_message_at) return true; // dismissed, no message time to beat
  const lastMs = Date.parse(t.last_message_at);
  if (!Number.isFinite(lastMs)) return true;
  return dismissedMs >= lastMs;
}

// The thread is inbound-last but needs no reply — either the message is a
// detected acknowledgment or an operator dismissed it. Drives the muted
// "Wrapping up" group; excluded from the Awaiting count + red group.
export function isNoReplyNeeded(t: {
  last_message_preview?: string | null;
  last_message_at?: string | null;
  no_reply_needed_at?: string | null;
}): boolean {
  return isManuallyDismissed(t) || isAcknowledgment(t.last_message_preview);
}

// Fields the refined awaiting logic reads. The last three are optional so
// existing callers that only know direction/status keep the original
// behavior (no suppression) — the suppression only kicks in where the
// caller supplies the message text / dismissal timestamp.
export type AwaitingInput = {
  status: "open" | "closed";
  last_message_direction: "inbound" | "outbound" | null;
  last_message_preview?: string | null;
  last_message_at?: string | null;
  no_reply_needed_at?: string | null;
};

// A thread is awaiting OUR reply when it is open, the customer sent the
// last message, AND that message actually needs a reply (not a bare
// acknowledgment, not operator-dismissed). Single source of truth for the
// grouping, the row indicator, and the awaiting count — used by both the
// render and the realtime reconciliation so they can never drift.
export function isAwaitingReply(t: AwaitingInput): boolean {
  return (
    t.status === "open" &&
    t.last_message_direction === "inbound" &&
    !isNoReplyNeeded(t)
  );
}

// Inbound-last but no reply needed → the muted "Wrapping up · no reply
// needed" group. Complement of isAwaitingReply within the inbound-last,
// open set.
export function isWrappingUp(t: AwaitingInput): boolean {
  return (
    t.status === "open" &&
    t.last_message_direction === "inbound" &&
    isNoReplyNeeded(t)
  );
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
      shortNote: "template required",
    };
  }
  if (ageHours >= AWAITING_WINDOW_CLOSING_HOURS) {
    return {
      tier: "closing",
      ageHours,
      ageLabel,
      note: "window closing",
      shortNote: "closing",
    };
  }
  return { tier: "fresh", ageHours, ageLabel, note: "", shortNote: "" };
}
