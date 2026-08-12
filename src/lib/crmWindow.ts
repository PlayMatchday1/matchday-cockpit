// The WhatsApp 24-hour session-window rule — pure, shared, tested. Extracted from
// CrmClient's inline computeWhatsAppExpired in Phase 19 Step 0 (characterize-before-split):
// the composer's disabled state depends on this rule, and in Step 2 the whole conversation
// surface moves into a persistent provider where a dock left open must KEEP re-evaluating it
// over time (a WhatsApp thread can go stale while docked). Pulling the rule into a pure
// function makes it a seam the refactor must keep green, rather than logic buried in a
// 2,364-line component that could silently change shape during the split.
//
// The rule (verbatim from computeWhatsAppExpired):
//   • SMS (or any non-whatsapp channel) has NO window — never expires.
//   • WhatsApp with no inbound message → expired (the 24h window never opened).
//   • WhatsApp with an unparseable inbound timestamp → expired (fail closed).
//   • otherwise expired iff more than 24h have passed since the latest inbound.
// `now` is injected so the rule is deterministic under test and re-evaluable on a timer.

export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

export type CrmChannel = "sms" | "whatsapp";

export function whatsappWindowExpired(
  channel: CrmChannel | string | null | undefined,
  latestInboundAtIso: string | null | undefined,
  nowMs: number,
): boolean {
  if ((channel ?? "sms") !== "whatsapp") return false; // SMS never expires
  if (!latestInboundAtIso) return true; // no inbound → window never opened
  const t = Date.parse(latestInboundAtIso);
  if (Number.isNaN(t)) return true; // fail closed on a bad timestamp
  return nowMs - t > WHATSAPP_WINDOW_MS;
}

// Milliseconds left before the WhatsApp 24h window closes — for the composer's "closing soon"
// warning (Phase 19 Step 3b). null when there is NO window (SMS / non-whatsapp). Once expired the
// value is <= 0. Same model + inputs as whatsappWindowExpired, so the two never drift.
export function whatsappWindowRemainingMs(
  channel: CrmChannel | string | null | undefined,
  latestInboundAtIso: string | null | undefined,
  nowMs: number,
): number | null {
  if ((channel ?? "sms") !== "whatsapp") return null; // SMS: no window
  if (!latestInboundAtIso) return 0; // never opened → treat as closed
  const t = Date.parse(latestInboundAtIso);
  if (Number.isNaN(t)) return 0; // fail closed
  return WHATSAPP_WINDOW_MS - (nowMs - t);
}
