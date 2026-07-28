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

import {
  businessMinutesBetween,
  type BusinessHoursConfig,
  DEFAULT_BUSINESS_HOURS,
  FIRST_RESPONSE_SLA_MINUTES,
} from "./businessHours";

// < CLOSING → fresh (reply normally). At/after CLOSING and before
// CLOSED → the free-reply window is closing soon. At/after CLOSED →
// the window has shut; a template is required to reply.
export const AWAITING_WINDOW_CLOSING_HOURS = 12;
export const AWAITING_WINDOW_CLOSED_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

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

// ============================================================
// First-response cue — the single escalation ladder on the inbox row
// ============================================================
// Reworks the old awaitingReplyState edge/chip into ONE ladder carrying
// two signals: the first-response SLA (business minutes) AND the WhatsApp
// free-reply window (real hours). Severity = the MAX of the two axes, so
// it never decreases as time passes, and the chip ALWAYS carries a text
// label so color is never the sole carrier of meaning.
//
//   neutral  — unanswered, elapsed < 50% SLA, window healthy → no edge,
//              muted chip, elapsed business time ("4m").
//   warm     — elapsed >= 50% and < 100% SLA, window healthy → amber.
//   breached — elapsed >= 100% SLA, window healthy → red, solid chip.
//   breached (reason 'window-closing'/'window-closed') — the free-reply
//              window is closing/closed. Always red-level regardless of
//              SLA (a closing window means the SLA is long gone). The chip
//              text switches to the WINDOW fact ("4h window" / "template")
//              so Meta's billable-template constraint stays legible.
//
// The two axes deliberately use DIFFERENT anchors:
//   • SLA elapsed is measured from `waitingSince` — the FIRST inbound of
//     the current unanswered run — because that is the customer's
//     continuous wait, and they must not be able to reset it by following
//     up. (waitingSinceMs computes it; the SERVER supplies it per row.)
//   • the window is measured from `lastInboundAt` (== last_message_at),
//     because Meta's 24h window genuinely REOPENS on each inbound.
// A future reader: this asymmetry is intentional — do not "fix" it.

export type FirstResponseTier = "neutral" | "warm" | "breached";
export type FirstResponseReason = "sla" | "window-closing" | "window-closed";

export type FirstResponseCue = {
  tier: FirstResponseTier;
  // Business minutes waited for the first response (from waitingSince).
  // Always reported even when the WINDOW axis drives the tier, so callers
  // can still surface the real wait.
  elapsedBusinessMinutes: number;
  // The chip text: elapsed ("4m", "1h 12m") for an SLA-driven cue, or the
  // window fact ("4h window", "template") for a window-driven one.
  label: string;
  reason: FirstResponseReason;
};

// "4m", "38m", "1h 12m" — business-minute elapsed, floored to the minute.
function formatElapsedMinutes(min: number): string {
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// A message reduced to what the wait math needs. isAutoReply excludes the
// out-of-hours system greeting from "we replied" — a courtesy greeting
// never stops the customer's first-response clock.
export type CueMessage = {
  direction: "inbound" | "outbound";
  sentAtMs: number;
  isAutoReply?: boolean;
};

// The sent_at (ms) of the FIRST inbound in the current episode that has no
// genuine operator outbound after it — the start of the customer's
// continuous wait. `episodeStartMs` scopes to the current episode (the
// latest reopen / auto_reopen, or thread creation), so a reopened thread's
// clock starts at the reopen, not the original contact. Returns null when
// there is no such inbound (we spoke last → not awaiting).
export function waitingSinceMs(
  messages: CueMessage[],
  episodeStartMs: number,
): number | null {
  // Latest genuine operator reply within the episode (auto-reply ignored).
  let lastOutMs = -Infinity;
  for (const m of messages) {
    if (
      m.sentAtMs >= episodeStartMs &&
      m.direction === "outbound" &&
      !m.isAutoReply &&
      m.sentAtMs > lastOutMs
    ) {
      lastOutMs = m.sentAtMs;
    }
  }
  const hadReply = lastOutMs > -Infinity;
  // First inbound after that reply (or from the episode start if we never
  // replied). A follow-up burst does NOT move this — the earliest inbound
  // after the last reply wins.
  let firstMs = Infinity;
  for (const m of messages) {
    if (m.direction !== "inbound") continue;
    if (m.sentAtMs < episodeStartMs) continue;
    if (hadReply && m.sentAtMs <= lastOutMs) continue;
    if (m.sentAtMs < firstMs) firstMs = m.sentAtMs;
  }
  return Number.isFinite(firstMs) ? firstMs : null;
}

// The escalation ladder for one awaiting row. See the block comment above
// for the tiers and the two-anchor rule. Returns null when there is no
// waiting instant (nothing to show).
export function firstResponseCue(
  waitingSince: string | number | null,
  lastInboundAt: string | number | null,
  nowMs: number,
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): FirstResponseCue | null {
  const waitingMs =
    typeof waitingSince === "number" ? waitingSince : waitingSince ? Date.parse(waitingSince) : NaN;
  if (!Number.isFinite(waitingMs)) return null;

  const elapsed = businessMinutesBetween(waitingMs, nowMs, cfg);

  // Window axis — REAL elapsed hours from the LAST inbound (Meta's window
  // reopens on each inbound; different anchor from the SLA on purpose).
  const lastMs =
    typeof lastInboundAt === "number"
      ? lastInboundAt
      : lastInboundAt
        ? Date.parse(lastInboundAt)
        : NaN;
  const windowHours = Number.isFinite(lastMs)
    ? Math.max(0, (nowMs - lastMs) / HOUR_MS)
    : 0;

  // Window overrides — always red-level, meaning carried by the text.
  if (windowHours >= AWAITING_WINDOW_CLOSED_HOURS) {
    return { tier: "breached", elapsedBusinessMinutes: elapsed, label: "template", reason: "window-closed" };
  }
  if (windowHours >= AWAITING_WINDOW_CLOSING_HOURS) {
    const remaining = Math.max(1, Math.ceil(AWAITING_WINDOW_CLOSED_HOURS - windowHours));
    return {
      tier: "breached",
      elapsedBusinessMinutes: elapsed,
      label: `${remaining}h window`,
      reason: "window-closing",
    };
  }

  // SLA axis — thresholds derived from the shared constant, never hardcoded.
  const label = formatElapsedMinutes(elapsed);
  if (elapsed >= FIRST_RESPONSE_SLA_MINUTES) {
    return { tier: "breached", elapsedBusinessMinutes: elapsed, label, reason: "sla" };
  }
  if (elapsed >= FIRST_RESPONSE_SLA_MINUTES * 0.5) {
    return { tier: "warm", elapsedBusinessMinutes: elapsed, label, reason: "sla" };
  }
  return { tier: "neutral", elapsedBusinessMinutes: elapsed, label, reason: "sla" };
}

// Full-sentence description of a cue for a row's aria-label — the same
// information the color + chip convey, in words, so color is never the
// only signal.
export function firstResponseCueDescription(cue: FirstResponseCue): string {
  const waited = `Waiting ${formatElapsedMinutes(cue.elapsedBusinessMinutes)} of business hours for a first reply`;
  if (cue.reason === "window-closed") {
    return `${waited}. WhatsApp free-reply window closed — a template is required to reply.`;
  }
  if (cue.reason === "window-closing") {
    return `${waited}. WhatsApp free-reply window closing (${cue.label}).`;
  }
  if (cue.tier === "breached") return `${waited} — over the response target.`;
  if (cue.tier === "warm") return `${waited} — approaching the response target.`;
  return waited + ".";
}

// Client-side maintenance of waiting_since across a realtime crm_messages
// INSERT — owned on the client (like last_message_direction) so a new message
// never needs a refetch. Pure + unit-tested because this is the ONE place
// Decision 2 can be silently reverted: anchoring on the newest message instead
// of holding the FIRST unanswered inbound. Given the thread's PRIOR state and
// the incoming message, returns the next waiting_since.
export function nextWaitingSince(
  prev: {
    status: "open" | "closed";
    last_message_direction: "inbound" | "outbound" | null;
    waiting_since: string | null;
  },
  incoming: {
    direction: "inbound" | "outbound";
    sentAt: string;
    isAutoReply?: boolean;
  },
): string | null {
  // The out-of-hours auto-reply is invisible to awaiting state (it doesn't
  // touch last_message_* either) — it must never stop the customer's clock.
  if (incoming.isAutoReply) return prev.waiting_since;
  // A genuine operator reply answers the thread → the wait is over.
  if (incoming.direction === "outbound") return null;
  // An inbound. If we were ALREADY awaiting on an open thread this is a
  // follow-up — keep the original anchor (a customer can't reset their own
  // clock). Otherwise (answered, or a reopen on a closed thread, or no anchor
  // yet) this inbound STARTS the wait.
  const alreadyWaiting =
    prev.status === "open" &&
    prev.last_message_direction === "inbound" &&
    prev.waiting_since != null;
  return alreadyWaiting ? prev.waiting_since : incoming.sentAt;
}
