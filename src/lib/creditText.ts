// "TEXT THE PLAYERS" ON CREDIT EVERYONE WHO PAID — the message, its placeholders and its checks
// (Ryan, 2026-11-07: wording approved). Pure, shared by the route, the match editor and the Gameday
// Ops panel, and asserted in scripts/credit-text-test.ts.
//
//   • The box opens with DEFAULT_CREDIT_TEXT. Staff edit it freely.
//   • Placeholders, filled per player: {first name}, {amount}, {field}, {day}, {time}. {amount} is a
//     number with two decimals and no dollar sign (9.00), so "${amount}" reads $9.00.
//   • An unknown placeholder or an empty message BLOCKS the send, with a plain sentence saying why.
//   • {day} and {time} are the match's start, which MatchDay stores as the LOCAL WALL CLOCK at the
//     field despite its Z: read off the string, never through new Date(), so they are already in the
//     field's city time.

import { smsSegments, type SegmentInfo } from "@/lib/matchNotify";

export const DEFAULT_CREDIT_TEXT =
  "MatchDay: Hi {first name}, we added ${amount} credit to your account for {field} on {day} at {time}. It's ready to use on your next booking.";

export const CREDIT_TEXT_PLACEHOLDERS = ["first name", "amount", "field", "day", "time"] as const;
export const CREDIT_TEXT_MAX = 1600;

/** Every {token} in the text that is not one of the five, as written (deduped, in order). */
export function unknownPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{([^{}]*)\}/g)) {
    const t = m[1].trim().toLowerCase().replace(/\s+/g, " ");
    if (!(CREDIT_TEXT_PLACEHOLDERS as readonly string[]).includes(t) && !out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** Why this message cannot be sent, or null. */
export function creditTextProblem(text: string): string | null {
  if (!text.trim()) return "The message is empty. Write something before sending.";
  const unknown = unknownPlaceholders(text);
  if (unknown.length) {
    return `${unknown.join(", ")} ${unknown.length === 1 ? "isn't a placeholder" : "aren't placeholders"} this message can fill. Use {first name}, {amount}, {field}, {day} or {time}.`;
  }
  if (text.length > CREDIT_TEXT_MAX) return `The message is ${text.length} characters; the limit is ${CREDIT_TEXT_MAX}.`;
  return null;
}

export const amountText = (cents: number) => (Math.max(0, Math.round(cents)) / 100).toFixed(2);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** WALL CLOCK → { day: "Sat, Nov 7", time: "7:00 PM" }, read off the string. */
export function wallClockParts(startDate: string | null | undefined): { day: string; time: string } {
  const x = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startDate ?? "");
  if (!x) return { day: "the match day", time: "the match time" };
  const [, y, mo, d, hh, mi] = x;
  const h = +hh;
  return {
    day: `${WEEKDAYS[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()]}, ${MONTHS[+mo - 1]} ${+d}`,
    time: `${h % 12 === 0 ? 12 : h % 12}:${mi} ${h >= 12 ? "PM" : "AM"}`,
  };
}

export type CreditTextValues = { firstName: string | null; cents: number; field: string | null; startDate: string | null };
/** One player's text. Call only on a message creditTextProblem() passed. */
export function fillCreditText(text: string, v: CreditTextValues): string {
  const { day, time } = wallClockParts(v.startDate);
  const map: Record<string, string> = {
    "first name": (v.firstName ?? "").trim() || "there",
    amount: amountText(v.cents),
    field: (v.field ?? "").trim() || "your match",
    day, time,
  };
  return text.replace(/\{([^{}]*)\}/g, (all, k: string) => map[k.trim().toLowerCase().replace(/\s+/g, " ")] ?? all);
}

/** The counter: characters and SMS segments of the filled text. Past one segment is a warning. */
export function creditTextCounter(filled: string): SegmentInfo & { warn: boolean } {
  const s = smsSegments(filled);
  return { ...s, warn: s.segments > 1 };
}

// ── WHO GETS IT ─────────────────────────────────────────────────────────────────────────────────
export type TextCandidate = { userId: number; cents: number; firstName: string | null; phoneE164: string | null; optedOut: boolean };
export type TextPlan = {
  send: TextCandidate[];
  skipped: { userId: number; reason: "no phone" | "opted out" | "same phone as another player" }[];
};
/** Only players whose credit LANDED are candidates (the route passes those alone). No phone, a
 *  STOP-type reply, or a phone already being texted in this run → skipped and counted. */
export function planCreditTexts(cands: readonly TextCandidate[]): TextPlan {
  const send: TextCandidate[] = [], skipped: TextPlan["skipped"] = [];
  const phones = new Set<string>();
  for (const c of cands) {
    if (!c.phoneE164) { skipped.push({ userId: c.userId, reason: "no phone" }); continue; }
    if (c.optedOut) { skipped.push({ userId: c.userId, reason: "opted out" }); continue; }
    if (phones.has(c.phoneE164)) { skipped.push({ userId: c.userId, reason: "same phone as another player" }); continue; }
    phones.add(c.phoneE164);
    send.push(c);
  }
  return { send, skipped };
}

/** A send error with every run of 7+ digits removed, so a phone number never reaches the log. */
export const scrubDigits = (s: string) => s.replace(/\+?\d[\d\s().-]{6,}\d/g, "[number]").slice(0, 200);
