// MATCH OPS › PUSH NOTIFICATIONS, the pure half (Figma 20834:76 the list, 20828:72 the editor, 20829:156 the results
// card). Client-safe: the page, the routes and the guard all use it.
//
// THE CONTRACT is backend docs/push-notifications.md (backend-offers 5b590b3 / d62a36d): message pushes under
// /admin/push-notifications, the shared audience under /admin/audiences. Every shape below is that document's.
//
// TIME: sendLocal is CITY WALL CLOCK ("2026-11-08 09:00"), like an offer push. launchedAt, queuedAt and sentAt are true
// instants (ISO, UTC), shown in America/Chicago. Never build a Date from a wall-clock string in local time.

import { audienceOf, canonicalAudience, emptySpec, specOfAudience, specProblem, type AudienceSpec, type ContractAudience, type ContractCount } from "./audienceModel";
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, FIRST_NAME, MATCH_TOKEN, fillPush } from "./offersPush";
import { chicagoLabel, dealText, matchTitle, wallLabel, wallMs, type City, type FieldOpt, type MatchOpt } from "./offersModel";

export type TapTarget = "MATCH" | "HOME" | "FIND_MATCH" | "FIELD";
export type PushStatus = "DRAFT" | "LAUNCHED" | "PAUSED" | "ENDED";
export type PushState = "DRAFT" | "SCHEDULED" | "SENDING" | "SENT" | "PAUSED" | "ENDED";
export type PushGroup = "LIVE" | "SCHEDULED" | "DRAFTS" | "ENDED";
export type Tap = { target: TapTarget; effectiveTarget?: TapTarget; matchId: number | null; fieldId: number | null; match?: { name: string; startLocal: string } | null };
// GET /admin/push-notifications/messages/:id (and every write's answer).
export type PushMessage = {
  kind: "MESSAGE"; id: number; name: string; audience: ContractAudience; audienceCount: number | null; holdoutPercent: number;
  title: string; body: string; tap: Tap; schedule: "ONCE"; sendLocal: string | null;
  status: PushStatus; state: PushState; group: PushGroup;
  queuedAt: string | null; createdByStaffEmail: string | null; launchedByStaffEmail: string | null; launchedAt: string | null; endedAt: string | null;
  createdAt?: string; updatedAt?: string;
};
// GET .../messages/:id/results.
export type PushResultsData = {
  targeted: number; sent: number; failed: number;
  skipped?: { notAllowed: number; noConsent: number; noDevice: number; oldApp: number; capped: number };
  opened: number; openRate: number | null; bookedWithin3Days: number; bookingRate: number | null;
  heldBack: number; heldBackBooked: number; heldBackBookingRate: number | null;
  devices?: number; sentAt: string | null; launchedAt: string | null; launchedByStaffEmail: string | null;
};
// GET .../messages/:id/reachable.
export type PushReachable = { mode?: string; reason?: string | null; audience: number; notAllowed: number; noConsent: number; noDevice: number; oldApp: number; capped: number; heldBack: number; reachable: number };
// GET /admin/push-notifications: one row per message push and per offer with a push.
export type ListItem = {
  kind: "MESSAGE" | "OFFER"; id: number; name: string; state: string; group: PushGroup;
  players: number | null; cityIds: number[]; tap: Tap | null;
  offer: { id: number; dealType: string; dealAmount: number; scope: string; pushStatus: string } | null;
  sendLocal: string | null;
  results: { sent: number; opened: number; bookedWithin3Days: number; used: number | null } | null;
  launchedAt: string | null; launchedByStaffEmail: string | null; createdAt: string | null;
};
export type ListPage = { counts: { live: number; scheduled: number; drafts: number; ended: number }; items: ListItem[] };

export const TAP_LABEL: Record<TapTarget, string> = { MATCH: "A match", HOME: "Home", FIND_MATCH: "Find a match", FIELD: "A field" };
// The next app update carries the Find a match and field pages; until then those two are drawn disabled.
export const TAP_NEEDS_APP: TapTarget[] = ["FIND_MATCH", "FIELD"];
export const TAP_NOTE = "Find a match and field pages need the next app update. Players on older versions open Home.";
// The backend's default since e9e90a7 (was 2); the page shows the stored value whenever it can read it.
export const WEEKLY_CAP_DEFAULT = 3;
export const HOLDOUT_MIN_TO_COMPARE = 30;
export const PLAYERS_HOLDOUT_MIN = 200;

// ── THE FORM ─────────────────────────────────────────────────────────────────────────────────────
export type PushForm = {
  name: string; audience: AudienceSpec; title: string; body: string;
  tapTarget: TapTarget; tapMatchId: number | null; tapFieldId: number | null;
  at: boolean; sendLocal: string; holdoutPercent: number;
};
export const DEFAULT_HOLDOUT = 10;
export function defaultSendLocal(nowWall: string): string {
  // Tomorrow 9:00 AM, wall clock, as a first value for "At a time".
  const d = new Date(wallMs(nowWall) + 24 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} 09:00`;
}
export const newPushForm = (nowWall: string): PushForm => ({
  name: "", audience: emptySpec(), title: "", body: "", tapTarget: "HOME", tapMatchId: null, tapFieldId: null, at: false, sendLocal: defaultSendLocal(nowWall), holdoutPercent: DEFAULT_HOLDOUT,
});
// unknown: stored filters this page can't draw (a newer backend). The editor then refuses to save the audience.
export function pushFormOf(c: PushMessage, nowWall: string): { form: PushForm; unknown: number } {
  const { spec, unknown } = specOfAudience(c.audience);
  return {
    unknown,
    form: {
      name: c.name, audience: spec, title: c.title, body: c.body, tapTarget: c.tap.target, tapMatchId: c.tap.matchId, tapFieldId: c.tap.fieldId,
      at: c.sendLocal !== null, sendLocal: c.sendLocal ?? defaultSendLocal(nowWall),
      holdoutPercent: c.audience.mode === "PLAYERS" && c.audience.playerIds.length < PLAYERS_HOLDOUT_MIN ? DEFAULT_HOLDOUT : c.holdoutPercent,
    },
  };
}
// What the backend stores for the holdout: none for an exact list under 200 players (audienceHoldout).
export const holdoutOf = (f: PushForm, playerIds: number[]) => (f.audience.mode === "PLAYERS" && playerIds.length < PLAYERS_HOLDOUT_MIN ? 0 : f.holdoutPercent);

// Everything the create takes, from the form.
export function fullBody(f: PushForm, playerIds: number[]): Record<string, unknown> {
  return {
    name: f.name.trim(), audience: audienceOf(f.audience, playerIds), holdoutPercent: holdoutOf(f, playerIds),
    title: f.title.trim(), body: f.body.trim(),
    tapTarget: f.tapTarget, tapMatchId: f.tapTarget === "MATCH" ? f.tapMatchId : null, tapFieldId: f.tapTarget === "FIELD" ? f.tapFieldId : null,
    sendLocal: f.at ? f.sendLocal : null,
  };
}
// Each body key as the push stores it, from a push response (the tap comes back as one object).
export function storedOf(c: PushMessage): Record<string, unknown> {
  return {
    name: c.name, audience: c.audience, holdoutPercent: c.holdoutPercent, title: c.title, body: c.body,
    tapTarget: c.tap.target, tapMatchId: c.tap.matchId, tapFieldId: c.tap.fieldId, sendLocal: c.sendLocal,
  };
}
export const sameValue = (k: string, a: unknown, b: unknown) => (k === "audience" ? canonicalAudience(a) === canonicalAudience(b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null));
// WHAT MAY CHANGE (PATCH): a draft anything; sent but nobody sent it yet (scheduled) every field but the send time;
// after that, or ended, the name only. Anything else is 400 PUSH_CAMPAIGN_LOCKED.
export const ALL_KEYS = ["name", "audience", "holdoutPercent", "title", "body", "tapTarget", "tapMatchId", "tapFieldId", "sendLocal"];
export function editableKeys(c: Pick<PushMessage, "status" | "state"> | null): Set<string> {
  if (!c || c.status === "DRAFT") return new Set(ALL_KEYS);
  if (c.status !== "ENDED" && c.state === "SCHEDULED") return new Set(ALL_KEYS.filter((k) => k !== "sendLocal"));
  return new Set(["name"]);
}
// THE DIFF IS THE REQUEST BODY: only what changed, and only what may change.
export function patchBody(c: PushMessage, f: PushForm, playerIds: number[]): Record<string, unknown> {
  const full = fullBody(f, playerIds);
  const stored = storedOf(c);
  const may = editableKeys(c);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(full)) if (may.has(k) && !sameValue(k, full[k], stored[k])) out[k] = full[k];
  return out;
}
// What a landed write must show: each key sent, read back from the push it answered with.
export const pushMismatches = (sent: Record<string, unknown>, after: PushMessage | null): string[] =>
  !after ? Object.keys(sent) : Object.keys(sent).filter((k) => !sameValue(k, sent[k], storedOf(after)[k]));

// Why it can't be sent as it stands, in plain words, or null. The audience's own problems come first.
export function formProblem(f: PushForm, playerIds: number[], matches: MatchOpt[], nowWall: string): string | null {
  if (!f.name.trim()) return "Give it a name (only staff see it).";
  const aud = specProblem(f.audience);
  if (aud) return aud;
  if (f.audience.mode === "PLAYERS" && playerIds.length === 0) return "Paste at least one player, or switch to Filters.";
  if (!f.title.trim()) return "Write a title.";
  if (f.title.trim().length > PUSH_TITLE_MAX) return `The title is over ${PUSH_TITLE_MAX} characters.`;
  if (!f.body.trim()) return "Write the message.";
  if (f.body.trim().length > PUSH_BODY_MAX) return `The message is over ${PUSH_BODY_MAX} characters.`;
  if (f.tapTarget === "MATCH" && (f.tapMatchId === null || !matches.some((m) => m.id === f.tapMatchId))) return "Pick the match the tap opens.";
  if (f.tapTarget !== "MATCH" && (f.title.includes(MATCH_TOKEN) || f.body.includes(MATCH_TOKEN))) return `${MATCH_TOKEN} only fills in when the tap opens a match.`;
  if (f.at && wallMs(`${f.sendLocal}:00`) < wallMs(nowWall)) return "That send time has passed. Pick a later one, or send now.";
  return null;
}
export const PUSH_HELP = `${FIRST_NAME} becomes the player's first name. ${MATCH_TOKEN} becomes the match name, day and time.`;
export const previewText = (f: PushForm, m: MatchOpt | null) => ({ title: fillPush(f.title || "Title", m), body: fillPush(f.body || "Message", m) });

// "↳ Tapping opens the match: NEMP · Sat 7:00 PM"
export function tapOpensText(target: TapTarget, m: MatchOpt | null): string {
  if (target === "MATCH") return m ? `the match: ${matchTitle(m)} · ${wallLabel(m.startLocal)}` : "the match you pick";
  return target === "HOME" ? "Home" : `${TAP_LABEL[target]} (Home until the next app update)`;
}

// ── THE SUMMARY BAR (20828:279) ───────────────────────────────────────────────────────────────
// "Sends now to about 304 players (338 who allow pushes, minus 10% held back to measure). Players already at 2
// pushes this week are skipped." willSend is the backend's own allowPushes - heldBack.
export function summaryLine(f: PushForm, count: ContractCount | null, weeklyCap: number): string {
  const when = f.at ? `Sends ${wallLabel(`${f.sendLocal}:00`)} in each player's city` : "Sends now";
  const capN = count?.weeklyCap ?? weeklyCap;
  const cap = `Players already at ${capN} ${capN === 1 ? "push" : "pushes"} this week are skipped.`;
  if (!count) return `${when} to the players who match. ${cap}`;
  const minus = [
    count.atCap ? `${n(count.atCap)} at the weekly limit` : null,
    count.heldBack > 0 ? `${count.holdoutPercent}% held back to measure` : null,
  ].filter(Boolean);
  const tail = minus.length ? `, minus ${minus.join(" and ")}` : f.audience.mode === "PLAYERS" ? "; nobody is held back" : "";
  return `${when} to about ${n(count.willSend)} ${count.willSend === 1 ? "player" : "players"} (${n(count.allowPushes)} who allow pushes${tail}). ${cap}`;
}

// ── THE LIST (20834:76) ──────────────────────────────────────────────────────────────────────────
export type Tab = "live" | "scheduled" | "drafts" | "ended";
export const TABS: { key: Tab; label: string; group: PushGroup }[] = [
  { key: "live", label: "Live", group: "LIVE" }, { key: "scheduled", label: "Scheduled", group: "SCHEDULED" }, { key: "drafts", label: "Drafts", group: "DRAFTS" }, { key: "ended", label: "Ended", group: "ENDED" },
];
// The chip on a row: the group, except a paused push says Paused.
export type Chip = "Live" | "Scheduled" | "Paused" | "Draft" | "Ended";
export const chipOf = (i: Pick<ListItem, "group" | "state">): Chip =>
  i.state === "PAUSED" ? "Paused" : i.group === "LIVE" ? "Live" : i.group === "SCHEDULED" ? "Scheduled" : i.group === "DRAFTS" ? "Draft" : "Ended";
export type Row = { key: string; kind: "MESSAGE" | "WITH_OFFER"; id: number; offerId: number | null; name: string; who: string; what: string; results: string; chip: Chip; group: PushGroup };
const n = (x: number) => x.toLocaleString("en-US");
const playersN = (x: number) => `${n(x)} ${x === 1 ? "player" : "players"}`;
const cityLine = (ids: number[], cities: City[]) => ids.map((id) => cities.find((c) => c.id === id)?.name ?? `City ${id}`).join(", ");
// A list match's startLocal is "YYYY-MM-DD HH:mm"; wallLabel wants seconds.
const withSeconds = (s: string) => (s.length === 16 ? `${s}:00` : s);
export function rowOf(i: ListItem, cities: City[], fields: FieldOpt[]): Row {
  const where = cityLine(i.cityIds, cities);
  const who = [i.players !== null ? playersN(i.players) : null, where || null].filter(Boolean).join(" · ") || (i.kind === "OFFER" ? "Not sent yet" : "Not counted yet");
  const t = i.tap;
  const opens = !t ? "the app" : t.target === "MATCH" ? (t.match ? `${t.match.name} · ${wallLabel(withSeconds(t.match.startLocal))}` : `match ${t.matchId ?? "?"}`)
    : t.target === "FIELD" ? fields.find((x) => x.id === t.fieldId)?.title ?? "a field" : TAP_LABEL[t.target];
  const what = `Opens ${opens}${i.offer ? ` · ${dealText(i.offer.dealType as Parameters<typeof dealText>[0], i.offer.dealAmount)}` : ""}`;
  const r = i.results;
  const results = i.group === "DRAFTS" ? "Draft"
    : i.group === "SCHEDULED" && !r?.sent ? (i.state === "PAUSED" ? "Paused" : i.sendLocal ? `Sends ${wallLabel(withSeconds(i.sendLocal))}` : "Sends soon")
    : r ? `${n(r.sent)} sent · ${n(r.opened)} opened · ${i.kind === "OFFER" && r.used !== null ? `${n(r.used)} used` : `${n(r.bookedWithin3Days)} booked`}` : "Not sent";
  return { key: `${i.kind}-${i.id}`, kind: i.kind === "OFFER" ? "WITH_OFFER" : "MESSAGE", id: i.id, offerId: i.offer?.id ?? null, name: i.name || "Untitled push", who, what, results, chip: chipOf(i), group: i.group };
}
export const FOOTER = "Every push players get, including pushes sent with an offer. Ended stays here, nothing is deleted.";

// ── THE RESULTS CARD (20829:156) ─────────────────────────────────────────────────────────────────
export const pct = (rate: number | null) => (rate === null ? "—" : `${(Math.round(rate * 1000) / 10).toLocaleString("en-US")}%`);
export const sentByLine = (r: Pick<PushResultsData, "sentAt" | "launchedAt" | "launchedByStaffEmail">) => {
  const at = r.sentAt ?? r.launchedAt;
  return at ? `Sent ${chicagoLabel(at)}${r.launchedByStaffEmail ? ` by ${r.launchedByStaffEmail}` : ""}` : "Not sent yet";
};
// The extra-bookings line: the booking rate of the players who got it against the held-back group, once
// HOLDOUT_MIN_TO_COMPARE or more were held back (the Clubhouse's rule; the backend gives both rates).
export function extraBookingsLine(r: PushResultsData): string {
  if (r.heldBack < HOLDOUT_MIN_TO_COMPARE || r.bookingRate === null || r.heldBackBookingRate === null) return `Extra bookings from the push: booking rate of players who got it minus the held-back group. Shown once ${HOLDOUT_MIN_TO_COMPARE}+ players are held back.`;
  const extra = Math.round((r.bookingRate - r.heldBackBookingRate) * r.sent);
  const rates = `${pct(r.bookingRate)} of players who got it booked, against ${pct(r.heldBackBookingRate)} of the ${n(r.heldBack)} held back`;
  return extra > 0 ? `Extra bookings from the push: about ${n(extra)} (${rates}).` : `Extra bookings from the push: none so far. ${rates[0].toUpperCase()}${rates.slice(1)}.`;
}
// Why some targeted players weren't sent it: "Not sent to 1: 1 at the weekly limit." null when nobody was skipped.
export function skippedLine(r: Pick<PushResultsData, "skipped">, cap: number): string | null {
  const s = r.skipped;
  if (!s) return null;
  const parts: [number, string][] = [[s.capped, `at the weekly limit of ${cap}`], [s.noConsent, "pushes off"], [s.noDevice, "no phone signed in"], [s.oldApp, "app too old"], [s.notAllowed, "not on the test list (staging sends only to allowlisted staff)"]];
  const shown = parts.filter(([k]) => k > 0);
  const total = shown.reduce((t, [k]) => t + k, 0);
  return total ? `Not sent to ${n(total)}: ${shown.map(([k, why]) => `${n(k)} ${why}`).join(", ")}.` : null;
}
// What a create or an edit may carry; the routes drop anything else.
export const PUSH_BODY_KEYS = new Set(ALL_KEYS);
