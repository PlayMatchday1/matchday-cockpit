// PLAYER CHATS HOUSE RULES ADDED 2026-11-02 — pure, so scripts/ai-draft-test.ts asserts them inside
// `npm run verify`. decideAutoSend (aiDraftModel) and runDraft (aiDraftRun) call these; nothing here
// reads a database, the network or the clock unless it is passed in.
//
//   1. NO STALLING. Oct 31 to Nov 2, about half the auto-sends were holding lines ("give me a sec to
//      find your account", "the team's still checking") that nothing followed up. An auto-send never
//      promises a step nobody will take, and a player who writes again after a holding line gets a
//      person.
//   2. THE MEMBERSHIP REFUND RULE (Ryan). Charges run on the 1st. A refund is eligible only when every
//      condition holds; otherwise the policy answer can go out on its own.
//   3. MATCHES CUT SHORT, marked by the city manager on Gameday Ops (match_cut_short).
//   4. THE THREAD'S CITY, in priority order account > field > inferred, never over a staff choice.

import type { DraftMsg } from "@/lib/aiDraftModel";

// ── 1. stalling ────────────────────────────────────────────────────────────────────────────────

// A reply that promises a step someone on our side will take later. Fine in a draft a person sends
// (they are that someone); never in an auto-send, because no one is. Seen on real auto-sends: "Give
// me a sec to find your account", "The team's still checking", "Still on it", "Let me check what
// happened and I'll get it sorted", "we'll update you as soon as we know", "The team will check and
// get back to you".
const STALL_RX = new RegExp([
  String.raw`\bgive me (?:a |one )?(?:sec(?:ond)?|min(?:ute)?|moment|bit)\b`,
  String.raw`\b(?:one|a|just a) (?:sec|second|moment|min(?:ute)?)\b`,
  String.raw`\bhang (?:on|tight)\b`,
  String.raw`\b(?:let me|lemme|i'?ll|i will|we'?ll|we will)\s+(?:quickly\s+|just\s+|have the team\s+|get the team to\s+)?(?:check|look|find|see|ask|dig|confirm|verify|investigate|sort|get back|update|follow up|let you know)\b`,
  String.raw`\b(?:the |our )?team(?:'s| is| are| will| 'll)?\s+(?:still\s+)?(?:check|look|find|review|investigat|get back|follow)\w*`,
  String.raw`\bstill (?:on it|checking|looking|working on)\b`,
  String.raw`\b(?:get|getting|be) back to you\b`,
  String.raw`\bas soon as (?:we|i) (?:know|hear|can)\b`,
  String.raw`\b(?:looking|checking) (?:into|on) (?:it|this|that)\b`,
].join("|"), "i");

/** The stall phrase in a reply, or null. */
export function stallPhrase(reply: string): string | null {
  return reply.match(STALL_RX)?.[0] ?? null;
}

/** A message we sent that only held the player: it matches a stall phrase. */
export const isHoldingReply = (m: Pick<DraftMsg, "direction" | "body" | "is_auto_reply">) =>
  m.direction === "outbound" && m.is_auto_reply !== true && !!stallPhrase(m.body ?? "");

export const WAITING_ON_LOOKUP = "Waiting on a lookup";

/** The last real message we sent was a holding line, and the player has written since. */
export function waitingOnLookup(msgs: readonly DraftMsg[]): boolean {
  const real = msgs.filter((m) => !(m.direction === "outbound" && m.is_auto_reply === true) && m.media_kind !== "reaction");
  let i = real.length - 1;
  while (i >= 0 && real[i].direction === "inbound") i--;
  if (i < 0 || i === real.length - 1) return false;
  return isHoldingReply(real[i]);
}

// ── 2. the membership refund rule ──────────────────────────────────────────────────────────────

/** The change_log reason a membership refund writes, and the one the eligibility check reads back. */
export const MEMBERSHIP_REFUND_REASON_PREFIX = "Membership refund:";
export const membershipRefundPath = (playerId: number) => `/clubhouse/membership-refund/${playerId}`;

// An earlier outbound that told this player the 25-day policy or the cancel cutoff. The words Ryan
// and the drafts use: "25-day", "cancel before the 5th", "on or after the 5th", "cancel by the 5th".
const POLICY_EXPLAINED_RX = /\b25[- ]?day\b|\bcancel\w*\b[^.!?\n]{0,40}\b(?:by|before|on or after|after) the 5th\b|\b(?:on or )?(?:before|after) the 5th\b[^.!?\n]{0,40}\b(?:charge|charged|bill|billed|cancel\w*)\b/i;

export const statesCancelPolicy = (body: string | null | undefined) => POLICY_EXPLAINED_RX.test(body ?? "");

/** Did any EARLIER outbound to this player, in any of their threads, state the policy? "Earlier" is
 *  before the player's current message: what we say in reply to it doesn't count against them. */
export function policyExplainedBefore(outbound: readonly { body: string | null; sent_at: string; is_auto_reply?: boolean | null; direction?: string }[], beforeIso: string): boolean {
  const before = Date.parse(beforeIso);
  return outbound.some((m) => (m.direction ?? "outbound") === "outbound" && m.is_auto_reply !== true && Date.parse(m.sent_at) < before && statesCancelPolicy(m.body));
}

export type RefundFacts = {
  /** When the player asked: the latest message in their burst. */
  askedAt: string;
  /** The membership charge being asked about, or null if there isn't one this month. */
  charge: { at: string; amountCents: number } | null;
  /** Matches the player played since the charge. null = couldn't be read. */
  matchesSinceCharge: number | null;
  /** A landed refund under MEMBERSHIP_REFUND_REASON_PREFIX on this account. null = couldn't be read. */
  priorRefund: boolean | null;
  /** An earlier outbound stated the 25-day policy. */
  policyExplained: boolean;
};

export type RefundEligibility = { eligible: true; amountCents: number } | { eligible: false; reason: string };

const chicagoYmd = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(ms).split("-").map(Number);

/** RYAN'S RULE. Every condition must hold; anything unknown is a no. */
export function membershipRefundEligibility(f: RefundFacts): RefundEligibility {
  const no = (reason: string): RefundEligibility => ({ eligible: false, reason });
  if (!f.charge || !(f.charge.amountCents > 0)) return no("No membership charge this month.");
  const asked = Date.parse(f.askedAt), charged = Date.parse(f.charge.at);
  if (!Number.isFinite(asked) || !Number.isFinite(charged)) return no("The dates couldn't be read.");
  // The charge is a CALENDAR day (the 1st, stored as midnight UTC): read its month in UTC. The ask is
  // an EVENT: read it in Central, where the player is.
  const c = new Date(charged), [ay, am, ad] = chicagoYmd(asked);
  if (ay !== c.getUTCFullYear() || am !== c.getUTCMonth() + 1) return no("Asked in a different month from the charge.");
  if (ad > 5) return no("Asked after the 5th.");
  if (f.matchesSinceCharge == null) return no("Matches since the charge couldn't be read.");
  if (f.matchesSinceCharge > 0) return no("Played a match since the charge.");
  if (f.priorRefund !== false) return no(f.priorRefund ? "Already had a membership refund." : "Refund history couldn't be read.");
  if (f.policyExplained) return no("We already explained the 25-day policy to them.");
  return { eligible: true, amountCents: f.charge.amountCents };
}

/** The charge to ask about: the 1st of the month the player asked in, if the membership was live then.
 *  The amount is the membership price (cents). */
export function membershipChargeFor(m: { since: string | null; price: number | null; status: string | null } | null, askedAt: string): RefundFacts["charge"] {
  if (!m || !(m.price != null && m.price > 0)) return null;
  const asked = Date.parse(askedAt);
  if (!Number.isFinite(asked)) return null;
  const [y, mo] = chicagoYmd(asked);
  const first = Date.UTC(y, mo - 1, 1);
  const since = m.since ? Date.parse(m.since) : NaN;
  // A membership that started this month paid its intro, not a renewal on the 1st.
  if (!Number.isFinite(since) || since >= first) return null;
  return { at: new Date(first).toISOString(), amountCents: m.price };
}

/** Played matches on or after the charge, from the context's matches. */
export function matchesPlayedSince(matches: readonly { state: string; startDateUtc: string | null }[], chargeAt: string): number {
  const at = Date.parse(chargeAt);
  return matches.filter((m) => m.state === "played" && m.startDateUtc && Date.parse(m.startDateUtc) >= at).length;
}

export type RefundLogRow = { outcome: string; changes: { key: string; before: unknown; after: unknown }[] | null };
export function priorMembershipRefundFromLog(rows: readonly RefundLogRow[]): boolean {
  return rows.some((r) => r.outcome === "landed" && (r.changes ?? []).some((c) => c.key === "reason" && typeof c.after === "string" && c.after.startsWith(MEMBERSHIP_REFUND_REASON_PREFIX)));
}

// ── 3. matches cut short ───────────────────────────────────────────────────────────────────────

export type CutShortReason = "lights" | "weather" | "injury" | "other";
export const CUT_SHORT_REASONS: readonly CutShortReason[] = ["lights", "weather", "injury", "other"];
export const CUT_SHORT_LABEL: Record<CutShortReason, string> = { lights: "Lights", weather: "Weather", injury: "Injury", other: "Other" };
export type CutShort = { reason: CutShortReason; minutes_played: number; note?: string | null };

export function cutShortProblem(reason: unknown, minutes: unknown, note: unknown): string | null {
  if (typeof reason !== "string" || !(CUT_SHORT_REASONS as readonly string[]).includes(reason)) return "Pick a reason: lights, weather, injury or other.";
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 240) return "Minutes played must be a whole number from 0 to 240.";
  if (reason === "other" && !(typeof note === "string" && note.trim())) return "Say what happened when the reason is other.";
  return null;
}

// A player saying the match stopped: the lights, the weather, a storm, or it ending early.
const CUT_SHORT_COMPLAINT_RX = /\blights?\b[^.!?\n]{0,25}\b(?:went|go|going|turn\w*|were|was|are)?\s*(?:out|off|down|died|cut)\b|\b(?:no|without) lights?\b|\bpower (?:outage|went|cut)\b|\b(?:rain|weather|storm|lightning|thunder|flood\w*)\b[^.!?\n]{0,40}\b(?:stop\w*|end\w*|cut|call\w*|cancel\w*|shut|over)\b|\b(?:cut|ended|stopped|called) (?:short|early|off)\b|\bonly played\b|\bdidn'?t (?:get to )?(?:finish|play the whole)\b/i;
export const complainsCutShort = (text: string) => CUT_SHORT_COMPLAINT_RX.test(text);
export const NOT_MARKED_CUT_SHORT = "Check with city manager, match not marked cut short";

// ── 4. the thread's city ───────────────────────────────────────────────────────────────────────

export type CitySource = "account" | "field" | "inferred" | "staff";
const RANK: Record<CitySource, number> = { inferred: 1, field: 2, account: 3, staff: 4 };

/** What to store, or null to leave the thread alone. A staff choice is never overwritten; otherwise a
 *  higher source replaces a lower one, and the same source refreshes its value. */
export function nextThreadCity(
  current: { code: string | null; source: CitySource | null },
  found: { account?: string | null; field?: string | null; inferred?: string | null },
  known: (code: string) => boolean,
): { code: string; source: CitySource } | null {
  if (current.source === "staff") return null;
  const pick = ([["account", found.account], ["field", found.field], ["inferred", found.inferred]] as const)
    .find(([, c]) => typeof c === "string" && known(c));
  if (!pick) return null;
  const [source, code] = pick as [CitySource, string];
  if (current.source && RANK[current.source] > RANK[source]) return null;
  if (current.code === code && current.source === source) return null;
  return { code, source };
}

/** Who gets the Needs a human push, and when. A thread in a city that has confined chat staff goes to
 *  them first; admins join after ESCALATE_AFTER_MS with no staff reply. Elsewhere it is today's rule:
 *  the assignee, or every unconfined chat staff member. */
export const ESCALATE_AFTER_MS = 20 * 60e3;
type Staff = { id: string; is_admin?: boolean | null; can_access_chats?: boolean | null; is_service_account?: boolean | null; city_identifier?: string | null };
const confinedTo = (u: Staff) => (typeof u.city_identifier === "string" ? u.city_identifier.trim() : "");
export function cityPushRecipients(staff: readonly Staff[], t: { assigneeId: string | null; cityCode: string | null }, stage: "first" | "escalate"): string[] {
  const live = staff.filter((u) => u.is_service_account !== true);
  if (t.assigneeId) return stage === "first" && live.some((u) => u.id === t.assigneeId) ? [t.assigneeId] : [];
  const unconfined = live.filter((u) => (u.is_admin === true || u.can_access_chats === true) && !confinedTo(u));
  const cityStaff = t.cityCode ? live.filter((u) => u.can_access_chats === true && confinedTo(u) === t.cityCode) : [];
  if (cityStaff.length === 0) return stage === "first" ? unconfined.map((u) => u.id) : [];
  return stage === "first" ? cityStaff.map((u) => u.id) : live.filter((u) => u.is_admin === true && !confinedTo(u)).map((u) => u.id);
}
