// MATCH OPS › PUSH NOTIFICATIONS, the pure half (Figma 20834:76 the list, 20828:72 the editor, 20829:156 the results
// card). Client-safe: the page, the routes and the guard all use it.
//
// THE BACKEND IS NOT ON STAGING YET (2026-11-06; see src/lib/audienceModel.ts). Every field and route named here is
// the Clubhouse's proposal, marked UNKNOWN in docs/matchday-api-facts.md, and lives behind src/lib/pushesServer.ts so
// the day the backend lands, that file is the only one that has to move. What IS real today: the pushes that go
// with an offer (backend docs/offer-push.md), which this list shows too, as "With offer".
//
// TIME: sendLocal is CITY WALL CLOCK ("2026-11-08 09:00"), like an offer push. sentAt and queuedAt are true instants
// (ISO, UTC), shown in America/Chicago. Never build a Date from a wall-clock string in local time.

import { audienceBodyOf, emptySpec, rowsOf, specProblem, specText, type AudienceBody, type AudienceSpec, type FilterBody } from "./audienceModel";
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, FIRST_NAME, MATCH_TOKEN, fillPush, type CampaignPush } from "./offersPush";
import { audienceText, chicagoLabel, dealText, matchTitle, wallLabel, wallMs, type Campaign, type City, type FieldOpt, type MatchOpt } from "./offersModel";

export type TapTarget = "MATCH" | "HOME" | "FIND_MATCH" | "FIELD";
// status is what the backend stores; state is what the list files it under (Live, Scheduled, Drafts, Ended).
export type PushStatus = "DRAFT" | "SCHEDULED" | "SENT" | "NOT_SENT" | "ENDED";
export type PushState = "DRAFT" | "SCHEDULED" | "LIVE" | "ENDED";
export type PushResultsData = { targeted: number; sent: number; opened: number; bookedWithin3Days: number; heldBack: number; heldBackBooked: number };
export type PushCampaign = {
  id: number; name: string; title: string; body: string;
  tapTarget: TapTarget; tapMatchId: number | null; tapFieldId: number | null;
  audienceMode: "FILTERS" | "PLAYERS"; filters: FilterBody[]; playerIds: number[]; holdoutPercent: number;
  // null sends now (at the press of Send push); a wall-clock time sends at that time in each player's city.
  sendLocal: string | null;
  status: PushStatus; state?: PushState;
  queuedAt: string | null; sentAt: string | null; sentByStaffEmail: string | null; sentByStaffName?: string | null;
  createdByStaffEmail: string | null; updatedAt?: string;
  // How many the audience held when it was last counted or sent; absent on a draft never counted.
  audienceSize?: number | null;
  results: PushResultsData | null;
};

export const TAP_LABEL: Record<TapTarget, string> = { MATCH: "A match", HOME: "Home", FIND_MATCH: "Find a match", FIELD: "A field" };
// The next app update carries the Find a match and field pages; until then those two are drawn disabled.
export const TAP_NEEDS_APP: TapTarget[] = ["FIND_MATCH", "FIELD"];
export const TAP_NOTE = "Find a match and field pages need the next app update. Players on older versions open Home.";
export const WEEKLY_CAP_DEFAULT = 2;
export const BOOKING_WINDOW_DAYS = 3;
export const HOLDOUT_MIN_TO_COMPARE = 30;

// ── THE FORM ─────────────────────────────────────────────────────────────────────────────────────
export type PushForm = {
  name: string; audience: AudienceSpec; title: string; body: string;
  tapTarget: TapTarget; tapMatchId: number | null; tapFieldId: number | null;
  at: boolean; sendLocal: string; holdoutPercent: number;
};
export const DEFAULT_HOLDOUT = 10;
export function defaultSendLocal(nowWall: string): string {
  // Tomorrow 9:00 AM, wall clock, as a first value for "At a time".
  const ms = wallMs(nowWall) + 24 * 3600 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} 09:00`;
}
export const newPushForm = (nowWall: string): PushForm => ({
  name: "", audience: emptySpec(), title: "", body: "", tapTarget: "HOME", tapMatchId: null, tapFieldId: null, at: false, sendLocal: defaultSendLocal(nowWall), holdoutPercent: DEFAULT_HOLDOUT,
});
export const pushFormOf = (c: PushCampaign, nowWall: string): PushForm => ({
  name: c.name, audience: { mode: c.audienceMode, filters: rowsOf(c.filters), playersText: c.playerIds.join(", ") },
  title: c.title, body: c.body, tapTarget: c.tapTarget, tapMatchId: c.tapMatchId, tapFieldId: c.tapFieldId,
  at: c.sendLocal !== null, sendLocal: c.sendLocal ?? defaultSendLocal(nowWall), holdoutPercent: c.holdoutPercent,
});

// Everything the backend stores, from the form. createBody sends it all; patchBody only what differs from the
// campaign (THE DIFF IS THE REQUEST BODY).
export function fullBody(f: PushForm, playerIds: number[]): Record<string, unknown> {
  const aud: AudienceBody = audienceBodyOf(f.audience, playerIds);
  return {
    name: f.name.trim(), title: f.title.trim(), body: f.body.trim(),
    tapTarget: f.tapTarget, tapMatchId: f.tapTarget === "MATCH" ? f.tapMatchId : null, tapFieldId: f.tapTarget === "FIELD" ? f.tapFieldId : null,
    audienceMode: aud.audienceMode, filters: aud.audienceMode === "FILTERS" ? aud.filters : [], playerIds: aud.audienceMode === "PLAYERS" ? aud.playerIds : [],
    holdoutPercent: f.audience.mode === "PLAYERS" ? 0 : f.holdoutPercent,
    sendLocal: f.at ? f.sendLocal : null,
  };
}
export const createBody = fullBody;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export function patchBody(c: PushCampaign, f: PushForm, playerIds: number[]): Record<string, unknown> {
  const full = fullBody(f, playerIds);
  const stored: Record<string, unknown> = { ...c, playerIds: [...c.playerIds].sort((x, y) => x - y) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(full)) if (!same(full[k], stored[k])) out[k] = full[k];
  return out;
}

// Why it can't be sent as it stands, in plain words, or null. The audience's own problems come first.
export function formProblem(f: PushForm, playerIds: number[], matches: MatchOpt[], nowWall: string): string | null {
  if (!f.name.trim()) return "Give it a name (only staff see it).";
  const aud = specProblem(f.audience);
  if (aud) return aud;
  if (f.audience.mode === "PLAYERS" && playerIds.length === 0) return "Paste at least one player, or switch to Filters.";
  if (!f.title.trim()) return "Write a title.";
  if (f.title.length > PUSH_TITLE_MAX) return `The title is over ${PUSH_TITLE_MAX} characters.`;
  if (!f.body.trim()) return "Write the message.";
  if (f.body.length > PUSH_BODY_MAX) return `The message is over ${PUSH_BODY_MAX} characters.`;
  if (f.tapTarget === "MATCH" && (f.tapMatchId === null || !matches.some((m) => m.id === f.tapMatchId))) return "Pick the match the tap opens.";
  if (f.tapTarget === "FIELD" && f.tapFieldId === null) return "Pick the field the tap opens.";
  if (f.tapTarget !== "MATCH" && (f.title.includes(MATCH_TOKEN) || f.body.includes(MATCH_TOKEN))) return `${MATCH_TOKEN} only fills in when the tap opens a match.`;
  if (f.at && wallMs(`${f.sendLocal}:00`) < wallMs(nowWall)) return "That send time has passed. Pick a later one, or send now.";
  return null;
}
export const PUSH_HELP = `${FIRST_NAME} becomes the player's first name. ${MATCH_TOKEN} becomes the match name, day and time.`;
// The push as the phone will show it, for the preview.
export const previewText = (f: PushForm, m: MatchOpt | null) => ({ title: fillPush(f.title || "Title", m), body: fillPush(f.body || "Message", m) });

// "↳ Tapping opens the match: NEMP · Sat 7:00 PM"
export function tapOpensText(target: TapTarget, m: MatchOpt | null, field: FieldOpt | null): string {
  switch (target) {
    case "MATCH": return m ? `the match: ${matchTitle(m)} · ${wallLabel(m.startLocal)}` : "the match you pick";
    case "HOME": return "Home";
    case "FIND_MATCH": return "Find a match";
    case "FIELD": return field ? `the field: ${field.title}` : "the field you pick";
  }
}
// The list's WHAT column: "Opens NEMP · Sat 7:00 PM".
export function whatText(c: Pick<PushCampaign, "tapTarget" | "tapMatchId" | "tapFieldId">, matches: MatchOpt[], fields: FieldOpt[]): string {
  const m = c.tapMatchId !== null ? matches.find((x) => x.id === c.tapMatchId) ?? null : null;
  const f = c.tapFieldId !== null ? fields.find((x) => x.id === c.tapFieldId) ?? null : null;
  if (c.tapTarget === "MATCH") return m ? `Opens ${matchTitle(m)} · ${wallLabel(m.startLocal)}` : `Opens match ${c.tapMatchId ?? "?"}`;
  if (c.tapTarget === "FIELD") return f ? `Opens ${f.title}` : `Opens field ${c.tapFieldId ?? "?"}`;
  return `Opens ${TAP_LABEL[c.tapTarget]}`;
}

// ── THE SUMMARY BAR (20828:279) ───────────────────────────────────────────────────────────────
// "Sends now to about 304 players (338 who allow pushes, minus 10% held back to measure). Players already at 2
// pushes this week are skipped."
export type PushCount = { count: number; allowPush: number; holdoutPercent: number; heldBack: number };
export function summaryLine(f: PushForm, count: PushCount | null, weeklyCap: number, playersCount: number): string {
  const when = f.at ? `Sends ${wallLabel(`${f.sendLocal}:00`)} in each player's city` : "Sends now";
  const cap = `Players already at ${weeklyCap} ${weeklyCap === 1 ? "push" : "pushes"} this week are skipped.`;
  if (f.audience.mode === "PLAYERS") {
    const n = count ? count.allowPush : playersCount;
    return `${when} to ${n.toLocaleString("en-US")} ${n === 1 ? "player" : "players"}${count ? ` (${count.allowPush.toLocaleString("en-US")} of ${playersCount.toLocaleString("en-US")} allow pushes; nobody is held back)` : ""}. ${cap}`;
  }
  if (!count) return `${when} to the players who match. ${cap}`;
  const about = Math.max(0, count.allowPush - Math.round((count.allowPush * count.holdoutPercent) / 100));
  const minus = count.holdoutPercent > 0 ? `, minus ${count.holdoutPercent}% held back to measure` : "";
  return `${when} to about ${about.toLocaleString("en-US")} ${about === 1 ? "player" : "players"} (${count.allowPush.toLocaleString("en-US")} who allow pushes${minus}). ${cap}`;
}

// ── THE LIST (20834:76) ──────────────────────────────────────────────────────────────────────────
export type Tab = "live" | "scheduled" | "drafts" | "ended";
export const TABS: { key: Tab; label: string }[] = [{ key: "live", label: "Live" }, { key: "scheduled", label: "Scheduled" }, { key: "drafts", label: "Drafts" }, { key: "ended", label: "Ended" }];
export const tabOf = (state: PushState): Tab => (state === "LIVE" ? "live" : state === "SCHEDULED" ? "scheduled" : state === "DRAFT" ? "drafts" : "ended");
export const STATE_LABEL: Record<PushState, string> = { LIVE: "Live", SCHEDULED: "Scheduled", DRAFT: "Draft", ENDED: "Ended" };
// Live is a sent push still inside its booking window; after that it is ended. The backend may say so itself.
export function stateOf(c: Pick<PushCampaign, "status" | "state" | "sentAt">, nowMs: number): PushState {
  if (c.state) return c.state;
  if (c.status === "DRAFT") return "DRAFT";
  if (c.status === "SCHEDULED") return "SCHEDULED";
  if (c.status === "SENT" && c.sentAt && nowMs - Date.parse(c.sentAt) < BOOKING_WINDOW_DAYS * 86400_000) return "LIVE";
  return "ENDED";
}
export type Row = {
  key: string; kind: "MESSAGE" | "WITH_OFFER"; id: number; offerId: number | null; name: string; who: string; what: string; results: string; state: PushState;
  // For sorting: the most recent activity first.
  sortMs: number;
};
const n = (x: number) => x.toLocaleString("en-US");
const playersN = (x: number) => `${n(x)} ${x === 1 ? "player" : "players"}`;
export function resultsText(c: PushCampaign): string {
  const r = c.results;
  if (c.status === "DRAFT") return "Draft";
  if (c.status === "SCHEDULED") return c.sendLocal ? `Sends ${wallLabel(`${c.sendLocal}:00`)}` : "Sends soon";
  if (c.status === "NOT_SENT") return "Not sent: nobody to reach";
  if (!r) return "Sent";
  return `${n(r.sent)} sent · ${n(r.opened)} opened · ${n(r.bookedWithin3Days)} booked`;
}
export function rowOf(c: PushCampaign, cities: City[], fields: FieldOpt[], matches: MatchOpt[], nowMs: number): Row {
  const size = c.audienceSize ?? c.results?.targeted ?? null;
  const aud = specText({ mode: c.audienceMode, filters: rowsOf(c.filters), playersText: "" }, cities, fields, c.playerIds.length);
  const who = c.audienceMode === "PLAYERS" || size === null ? aud : `${playersN(size)} · ${aud}`;
  return {
    key: `p${c.id}`, kind: "MESSAGE", id: c.id, offerId: null, name: c.name || "Untitled push", who, what: whatText(c, matches, fields), results: resultsText(c),
    state: stateOf(c, nowMs), sortMs: Date.parse(c.sentAt ?? c.queuedAt ?? c.updatedAt ?? "") || 0,
  };
}
// An offer's push, as the same kind of row (backend docs/offer-push.md; the offer itself is in Offers).
export function rowOfOffer(c: Campaign, cities: City[], fields: FieldOpt[], matches: MatchOpt[], nowMs: number): Row | null {
  const p: CampaignPush | undefined = c.push;
  if (!p || !p.enabled || p.status === "OFF") return null;
  const state: PushState = p.status === "SENT" ? (p.queuedAt && nowMs - Date.parse(p.queuedAt) < BOOKING_WINDOW_DAYS * 86400_000 ? "LIVE" : "ENDED")
    : p.status === "NOT_SENT" ? "ENDED" : c.status === "DRAFT" ? "DRAFT" : "SCHEDULED";
  const m = c.matchIds[0] ? matches.find((x) => x.id === c.matchIds[0]) ?? null : null;
  const opens = c.matchScoped ? (m ? `${matchTitle(m)} · ${wallLabel(m.startLocal)}` : `match ${c.matchIds[0]}`) : c.appliesFieldIds?.length === 1 ? fields.find((f) => f.id === c.appliesFieldIds![0])?.title ?? "the field" : "Find a match";
  // An offer's push opens are its own read (push/results, paced), so the list shows what the campaign already carries:
  // how many it went to, and how many used the offer.
  const results = p.status === "SENT" ? `${n(p.sent ?? 0)} sent · ${n(c.results.used)} used`
    : p.status === "NOT_SENT" ? "Not sent: nobody to reach" : p.status === "SCHEDULED" && p.sendLocal ? `Sends ${wallLabel(`${p.sendLocal}:00`)}` : c.status === "DRAFT" ? "Draft" : "Sends when the offer launches";
  const size = c.results.granted + c.results.heldBack;
  return {
    key: `o${c.id}`, kind: "WITH_OFFER", id: c.id, offerId: c.id, name: c.name || "Untitled offer",
    who: c.audienceMode === "PLAYERS" || !size ? audienceText(c, cities, fields) : `${playersN(size)} · ${audienceText(c, cities, fields)}`, what: `Opens ${opens} · ${dealText(c.dealType, c.dealAmount)}`, results, state,
    sortMs: Date.parse(p.queuedAt ?? c.launchedAt ?? c.updatedAt ?? "") || 0,
  };
}
export const rowsByTab = (rows: Row[]) => {
  const out: Record<Tab, Row[]> = { live: [], scheduled: [], drafts: [], ended: [] };
  for (const r of [...rows].sort((a, b) => b.sortMs - a.sortMs)) out[tabOf(r.state)].push(r);
  return out;
};
export const FOOTER = "Every push players get, including pushes sent with an offer. Ended stays here, nothing is deleted.";

// ── THE RESULTS CARD (20829:156) ─────────────────────────────────────────────────────────────────
export const pct = (part: number, whole: number) => (whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toLocaleString("en-US")}%` : "—");
export const sentByLine = (c: Pick<PushCampaign, "sentAt" | "sentByStaffEmail" | "sentByStaffName">) =>
  c.sentAt ? `Sent ${chicagoLabel(c.sentAt)}${c.sentByStaffName || c.sentByStaffEmail ? ` by ${c.sentByStaffName || c.sentByStaffEmail}` : ""}` : "Not sent yet";
// The one comparison line: the booking rate of the players who got it against the held-back group, as extra
// bookings, once HOLDOUT_MIN_TO_COMPARE or more were held back. Fewer, and the line says what it would show.
export function extraBookingsLine(r: PushResultsData): string {
  if (r.heldBack < HOLDOUT_MIN_TO_COMPARE || r.sent === 0) return `Extra bookings from the push: booking rate of players who got it minus the held-back group. Shown once ${HOLDOUT_MIN_TO_COMPARE}+ players are held back.`;
  const got = r.bookedWithin3Days / r.sent;
  const held = r.heldBackBooked / r.heldBack;
  const extra = Math.round((got - held) * r.sent);
  const rates = `${pct(r.bookedWithin3Days, r.sent)} of players who got it booked, against ${pct(r.heldBackBooked, r.heldBack)} of the ${n(r.heldBack)} held back`;
  return extra > 0 ? `Extra bookings from the push: about ${n(extra)} (${rates}).` : `Extra bookings from the push: none so far. ${rates[0].toUpperCase()}${rates.slice(1)}.`;
}

// The write's own read-back check: what a landed save must show (src/lib/pushesServer.ts compares the body sent).
export const PUSH_ID_SETS = new Set(["playerIds"]);
// What a create or an edit may carry; anything else in a request is dropped by the route.
export const PUSH_BODY_KEYS = new Set(["name", "title", "body", "tapTarget", "tapMatchId", "tapFieldId", "audienceMode", "filters", "playerIds", "holdoutPercent", "sendLocal"]);
