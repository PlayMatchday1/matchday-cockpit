// STAFF SIGN-IN CODES BY TEXT. One module for the three places that must agree: the Send SMS hook
// that writes the message, the Telnyx ingest that must not store the code, and the gate that
// decides whether a code may be sent at all. Pure: no fetching, no env, so the suite runs offline.

/** The exact text sent. Changing it changes the redaction pattern with it. */
export const signInCodeText = (otp: string): string => `Your MatchDay Clubhouse sign-in code is ${otp}. Do not share it.`;

/** Matches signInCodeText exactly, and nothing looser: a player message mentioning a code is kept. */
export const SIGN_IN_CODE_RX = /^Your MatchDay Clubhouse sign-in code is \d{6}\. Do not share it\.$/;
export const SIGN_IN_CODE_REDACTED = "[sign-in code]";

export const isSignInCodeText = (body: string | null | undefined): boolean => typeof body === "string" && SIGN_IN_CODE_RX.test(body);

/**
 * WHAT telnyx_sms_log MAY STORE for one outbound message. A sign-in code is replaced in BOTH places
 * the ingest writes text: message_body, and the raw Telnyx message kept in `raw`. In the raw message
 * EVERY string field holding the template is replaced, not only `text`: Telnyx also returns the
 * same words as `original_text` (seen 2026-10-30). Anything else is returned untouched.
 */
export function redactForLog<M extends { text?: string | null }>(body: string | null, msg: M): { body: string | null; msg: M } {
  const hits = Object.keys(msg).filter((k) => isSignInCodeText((msg as Record<string, unknown>)[k] as string));
  if (!isSignInCodeText(body) && hits.length === 0) return { body, msg };
  const out: Record<string, unknown> = { ...msg };
  for (const k of hits) out[k] = SIGN_IN_CODE_REDACTED;
  return { body: SIGN_IN_CODE_REDACTED, msg: out as M };
}

/* ── THE GATE ─────────────────────────────────────────────────────────────────────────────────
 * Ryan, 2026-10-29: the Send SMS hook is the ONLY gate. It sends only to a number on an app_users
 * row, at most 5 codes per number per hour, and never within 30 seconds of the last request. Every
 * request is recorded, sent or not, so a number being hammered stays limited. */
export const CODES_PER_HOUR = 5;
export const RESEND_COOLDOWN_SECONDS = 30;

export type GateDecision =
  | { send: true }
  | { send: false; reason: "not_staff" | "cooldown" | "hourly_limit"; httpCode: number; message: string };

/** `recent` are the earlier request times for this number in the last hour, newest first or any order. */
export function smsGate(isStaffNumber: boolean, recent: readonly Date[], now: Date): GateDecision {
  if (!isStaffNumber) return { send: false, reason: "not_staff", httpCode: 403, message: "Not a staff number." };
  const hourAgo = now.getTime() - 60 * 60_000;
  const inHour = recent.filter((d) => d.getTime() > hourAgo);
  const newest = inHour.reduce((m, d) => Math.max(m, d.getTime()), 0);
  if (newest && now.getTime() - newest < RESEND_COOLDOWN_SECONDS * 1000) {
    return { send: false, reason: "cooldown", httpCode: 429, message: `Wait ${RESEND_COOLDOWN_SECONDS} seconds before asking for another code.` };
  }
  if (inHour.length >= CODES_PER_HOUR) {
    return { send: false, reason: "hourly_limit", httpCode: 429, message: `No more than ${CODES_PER_HOUR} codes an hour.` };
  }
  return { send: true };
}

/** The one reply the app shows after asking for a code, staff number or not. */
/* FICTIONAL TEST NUMBERS (Ryan, 2026-10-30). +1 NXX 555 0100 to 0199 are reserved for fiction and
 * never reach a real phone. Supabase answers a configured test number with its own fixed code and
 * still calls the Send SMS hook, without a real code in the payload; the hook lets such a number
 * through WITHOUT texting anything, but only when it is on a staff row like any other number. */
export const isFictionalTestNumber = (e164: string | null | undefined): boolean =>
  typeof e164 === "string" && /^\+1[2-9]\d{2}55501\d{2}$/.test(e164);

export const PHONE_START_REPLY = "If this number is on a MatchDay staff account, a code is on its way.";
