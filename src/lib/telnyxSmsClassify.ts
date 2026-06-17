// Source-type classifier for outbound Telnyx SMS bodies, refined
// against a real 7-day sample (242 outbound seen, 126 bodies) on
// 2026-06-17.
//
// This module handles the BODY-pattern rules (2-8). The definitive
// rule 1, match_notify, is applied upstream in the ingest by
// cross-referencing telnyx_message_id against
// match_notify_log.recipients[] — a body pattern cannot tell a
// match-notify "free_form" send apart from an ops broadcast, so the id
// cross-ref must win first. The ingest calls classifySmsBody() only
// for messages that are NOT in the match_notify id set.
//
// Match order (the ingest enforces match_notify first, then this):
//   1. match_notify          (id cross-ref — NOT here)
//   2. player_match_reminder
//   3. manager_match_reminder
//   4. match_cancellation
//   5. welcome_intro
//   6. ops_broadcast
//   7. booking_confirmation  (0 seen in sample; future coverage)
//   8. other                 (fallback)
//
// Matching is done on a normalized body (lowercased, curly apostrophes
// folded to straight) so minor case/encoding drift in upstream
// templates does not slip a message into 'other'.

export type SmsSourceType =
  | "match_notify"
  | "player_match_reminder"
  | "manager_match_reminder"
  | "match_cancellation"
  | "welcome_intro"
  | "ops_broadcast"
  | "booking_confirmation"
  | "other";

// All body-pattern source types this module can return, in match
// order. match_notify is intentionally excluded (applied by id
// cross-ref upstream); 'other' is the implicit fallback.
export const SMS_BODY_SOURCE_TYPES: readonly SmsSourceType[] = [
  "player_match_reminder",
  "manager_match_reminder",
  "match_cancellation",
  "welcome_intro",
  "ops_broadcast",
  "booking_confirmation",
] as const;

function normalize(body: string): string {
  return body
    .replace(/[‘’]/g, "'") // curly → straight apostrophe
    .toLowerCase()
    .trim();
}

// Classify an outbound SMS body using rules 2-8. Returns 'other' for
// anything unmatched (including empty/unknown bodies). The caller
// applies the definitive match_notify id cross-ref before this.
export function classifySmsBody(rawBody: string | null | undefined): SmsSourceType {
  const body = (rawBody ?? "").trim();
  if (!body) return "other";
  const b = normalize(body);

  // 2. player_match_reminder
  if (b.startsWith("your match at") && b.includes("starts in")) {
    return "player_match_reminder";
  }

  // 3. manager_match_reminder
  if (b.startsWith("the match you're managing") && b.includes("kicks off in")) {
    return "manager_match_reminder";
  }

  // 4. match_cancellation
  if (
    b.startsWith("matchday:") &&
    b.includes("is cancelled") &&
    b.includes("match credit has been added")
  ) {
    return "match_cancellation";
  }

  // 5. welcome_intro (two template variants in the sample)
  if (
    (b.includes("matchday sc: welcome") || b.includes("welcome!")) &&
    (b.includes("$1") ||
      b.includes("intro period") ||
      b.includes("enjoy unlimited matches"))
  ) {
    return "welcome_intro";
  }

  // 6. ops_broadcast (manual ad-hoc operational messages)
  if (b.includes("hi this is matchday") || b.includes("hi, this is matchday")) {
    return "ops_broadcast";
  }

  // 7. booking_confirmation (0 seen in sample; kept for future coverage)
  if (
    b.includes("booking confirmed") ||
    b.includes("you're in") ||
    b.includes("spot confirmed")
  ) {
    return "booking_confirmation";
  }

  // 8. other
  return "other";
}
