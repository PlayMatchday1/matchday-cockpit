// GROWTH › OFFERS, the pure half (backend feature/offers, docs/offers/M3-ENDPOINTS.md). Client-safe:
// the page, the routes and scripts/offers-model-test.ts all use it.
//
// TIME MODEL: CITY WALL CLOCK, NEVER AN INSTANT. A campaign's startsLocal / endsLocal are wall-clock
// times in each player's own city ("2026-11-02 23:59:00", no zone), and a match's startDate is the
// same model (wall clock despite its "Z"). Everything here works on those strings with UTC getters and
// never builds a Date from them in local time. "Now" is the one exception: a true instant, turned into
// America/Chicago wall clock by chicagoWallNow(). Promo UTC helpers are a different model; do not mix.
//
// MONEY: cents. dealAmount is a percent (PERCENT_OFF), cents (AMOUNT_OFF, SET_PRICE) or 0 (FREE_MATCH).

import { LOCAL_MDAPI_HOST } from "./localMode";

export type DealType = "PERCENT_OFF" | "AMOUNT_OFF" | "SET_PRICE" | "FREE_MATCH";
export type LastPlayed = "ANY" | "LAPSED" | "NEVER";
export type Membership = "ANYONE" | "MEMBERS" | "NON_MEMBERS";
export type ButtonTarget = "FIND_MATCH" | "MATCH" | "MEMBERSHIP";
export type CampaignStatus = "DRAFT" | "LAUNCHED" | "PAUSED" | "ENDED";
export type CampaignState = "DRAFT" | "SCHEDULED" | "LIVE" | "PAUSED" | "ENDED";
// FILTERS: the audience is the filters. PLAYERS: exactly playerIds; the filters don't apply and nobody is held back.
export type AudienceMode = "FILTERS" | "PLAYERS";

export type BookedGroup = { players: number; booked: number; rate: number | null };
export type Results = {
  granted: number; heldBack: number; saw: number; tapped: number; dismissed: number;
  used: number; discountGiven: number; cameBackAtFullPrice: number;
  // Uses held right now (what the total limit counts) and the limit itself; null for none.
  usesTaken?: number; maxRedemptions?: number | null;
  booked: { withOffer: BookedGroup; heldBack: BookedGroup };
};

export type Copy = {
  eyebrow: string | null; caption: string | null; headline: string; line: string | null; body: string | null;
  photoUrl: string | null; buttonLabel: string; dismissLabel: string | null;
};
export const COPY_KEYS = ["eyebrow", "caption", "headline", "line", "body", "photoUrl", "buttonLabel", "dismissLabel"] as const;
export type CopyKey = (typeof COPY_KEYS)[number];

export type Campaign = Copy & {
  id: number; name: string; dealType: DealType; dealAmount: number; usesPerPlayer: number;
  maxRedemptions: number | null; audienceMode: AudienceMode; playerIds: number[]; fieldIds: number[];
  cityIds: number[]; lastPlayed: LastPlayed; lastPlayedDays: number | null;
  minMatches: number; maxMatches: number | null; membership: Membership;
  // endsLocal null: runs until someone ends it. showTicket false: the popup draws no ticket. Absent is
  // shown, which is all a backend without the field can mean.
  matchScoped: boolean; matchIds: number[]; startsLocal: string; endsLocal: string | null; showTicket?: boolean; holdoutPercent: number;
  buttonTarget: ButtonTarget; buttonMatchId: number | null; status: CampaignStatus; state: CampaignState;
  createdByStaffEmail: string | null; launchedByStaffEmail: string | null; launchedAt: string | null;
  results: Results;
};

// timeZone is the city's IANA name (admin/cities: timeZone.name), used for when an offer's end has passed.
export type City = { id: number; name: string; timeZone?: string | null };
// A field as the photo picker and the Played at row need it. cover is the field's cover photo URL, or null.
export type FieldOpt = { id: number; title: string; cityId: number | null; cover: string | null };
// A match as the page needs it. Show it with matchDay, never by name: a stored name can say the wrong
// day ("Riverside Thursday" on a Monday). startLocal is WALL CLOCK ("YYYY-MM-DD HH:mm:ss"). players is what the
// source counts: playersIn from admin/offers/matches, _count.players from admin/matches/{id}. maxPlayers
// null is a match with no cap. fieldCover comes from the field; admin/offers/matches doesn't carry it.
export type MatchOpt = {
  id: number; name: string; startLocal: string; fieldId: number | null; fieldTitle: string | null; fieldCover: string | null;
  cityId: number | null; price: number; players: number; maxPlayers: number | null; minPlayers: number; upcoming: boolean;
};
// GET /admin/offers/matches, one row (backend docs/offers/M3-ENDPOINTS.md).
export type ApiOfferMatch = {
  id: number; name: string; startsLocal: string; fieldId: number | null; fieldName: string | null; cityId: number | null;
  price: number; playersIn: number; capacity: number | null; minimum: number;
};
export const offerMatchOpt = (m: ApiOfferMatch): MatchOpt => ({
  id: m.id, name: m.name, startLocal: m.startsLocal, fieldId: m.fieldId, fieldTitle: m.fieldName, fieldCover: null, cityId: m.cityId,
  price: m.price, players: m.playersIn, maxPlayers: m.capacity, minPlayers: m.minimum, upcoming: true,
});
// Fill in each match's cover from the field list, so the suggested photo is the same whichever read it came from.
export const withCovers = (matches: MatchOpt[], fields: FieldOpt[]) =>
  matches.map((m) => (m.fieldCover || m.fieldId === null ? m : { ...m, fieldCover: fields.find((x) => x.id === m.fieldId)?.cover ?? null }));
// Later lists win on the same id.
export function mergeMatches(...lists: MatchOpt[][]): MatchOpt[] {
  const byId = new Map<number, MatchOpt>();
  for (const l of lists) for (const m of l) byId.set(m.id, m);
  return [...byId.values()];
}
// What the page's load and the picker read: today and the 13 days after it, the picker's longest range.
export const PICKER_MAX_DAYS = 14;
export function pickerRange(nowWall: string): { from: string; to: string } {
  return { from: nowWall.slice(0, 10), to: wallText(wallMs(nowWall) + (PICKER_MAX_DAYS - 1) * 86_400_000).slice(0, 10) };
}

// Fields a launched or paused campaign may still change (the backend's EDITABLE_AFTER_LAUNCH).
export const EDITABLE_AFTER_LAUNCH = new Set<string>([
  "name", "eyebrow", "caption", "headline", "line", "body", "photoUrl", "showTicket", "buttonLabel", "buttonTarget", "buttonMatchId", "dismissLabel", "maxRedemptions",
]);
// Every key the Clubhouse may send on create or edit. The routes drop anything else.
export const BODY_KEYS = new Set<string>([
  ...EDITABLE_AFTER_LAUNCH, "dealType", "dealAmount", "usesPerPlayer", "cityIds", "lastPlayed", "lastPlayedDays",
  "minMatches", "maxMatches", "membership", "fieldIds", "audienceMode", "playerIds", "matchIds", "startsLocal", "endsLocal", "holdoutPercent",
]);

// ── WALL CLOCK ───────────────────────────────────────────────────────────────────────────────────
const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;
// Wall-clock text as a number we can compare and step by days (never shown as an instant).
export function wallMs(s: string): number {
  const m = WALL.exec(s);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}
export function wallText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
// A match's startDate ("2026-11-02T19:00:00.000Z", wall clock) as wall-clock text.
export const wallFromMatch = (startDate: string) => startDate.slice(0, 19).replace("T", " ");

export const chicagoWallNow = (now: Date = new Date()): string => wallNowIn("America/Chicago", now);
// A zone Intl doesn't know reads as UTC, the backend's own answer for a player with no city's zone.
export function wallNowIn(timeZone: string, now: Date = new Date()): string {
  let f: Intl.DateTimeFormat;
  const parts = (zone: string) => new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  try { f = parts(timeZone); } catch { f = parts("UTC"); }
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const DAY = 86_400_000;
const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(new Date(ms));
const dayStart = (ms: number) => Math.floor(ms / DAY) * DAY;
export const calendarDaysBetween = (from: string, to: string) => Math.round((dayStart(wallMs(to)) - dayStart(wallMs(from))) / DAY);

// "Sun, Nov 2 · 11:59 PM"
export function wallLabel(s: string): string {
  const ms = wallMs(s);
  if (!Number.isFinite(ms)) return s;
  return `${fmt(ms, { weekday: "short", month: "short", day: "numeric" })} · ${fmt(ms, { hour: "numeric", minute: "2-digit" })}`;
}
export const wallDate = (s: string) => fmt(wallMs(s), { weekday: "short", month: "short", day: "numeric" });
// "Today" when the wall-clock day is today in Chicago, else the full label.
export function startLabel(s: string, nowWall: string): string {
  return calendarDaysBetween(nowWall, s) === 0 ? `Today · ${fmt(wallMs(s), { hour: "numeric", minute: "2-digit" })}` : wallLabel(s);
}
// The popup's ticket, as the app writes it (OfferPopup.offerEndsLabel): within a week "Ends Sun 11:59 PM",
// after that "Ends Sun, Nov 9".
export function endsTicket(endsLocal: string | null, nowWall: string): string | null {
  if (endsLocal === null) return null;
  const ms = wallMs(endsLocal);
  if (!Number.isFinite(ms)) return null;
  const days = calendarDaysBetween(nowWall, endsLocal);
  return days >= 0 && days < 7
    ? `Ends ${fmt(ms, { weekday: "short" })} ${fmt(ms, { hour: "numeric", minute: "2-digit" })}`
    : `Ends ${fmt(ms, { weekday: "short", month: "short", day: "numeric" })}`;
}
// <input type="datetime-local"> speaks "YYYY-MM-DDTHH:mm"; the backend takes "YYYY-MM-DD HH:mm:ss".
export const toInput = (s: string) => s.slice(0, 16).replace(" ", "T");
export const fromInput = (s: string) => (s ? `${s.replace("T", " ").slice(0, 16)}:00` : "");

// A new offer runs from now (to the minute) to the coming Sunday at 11:59 PM, at least two days away.
export function defaultRun(nowWall: string): { startsLocal: string; endsLocal: string } {
  const now = wallMs(nowWall);
  const start = Math.floor(now / 60_000) * 60_000;
  const dow = new Date(now).getUTCDay(); // 0 = Sunday
  let toSunday = (7 - dow) % 7;
  if (toSunday < 2) toSunday += 7;
  return { startsLocal: wallText(start), endsLocal: wallText(dayStart(now) + toSunday * DAY + (23 * 60 + 59) * 60_000) };
}

// ── MONEY AND DEALS ──────────────────────────────────────────────────────────────────────────────
export function money(cents: number): string {
  const d = cents / 100;
  return Number.isInteger(d) ? `$${d.toLocaleString("en-US")}` : `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// The backend's applyOfferDeal (join-pricing.ts): the price a player pays with the deal. Under 50 cents is free.
export function priceWithDeal(listPrice: number, type: DealType, amount: number): number {
  let price = type === "FREE_MATCH" ? 0 : type === "SET_PRICE" ? amount : type === "AMOUNT_OFF" ? listPrice - amount : Math.round(listPrice - (listPrice * amount) / 100);
  price = price < 50 ? 0 : price;
  return Math.max(0, price);
}
export const discountOn = (listPrice: number, type: DealType, amount: number) => Math.max(0, listPrice - priceWithDeal(listPrice, type, amount));

// The stepper for each deal type: start, step, floor and ceiling (percent or cents).
export const STEPPER: Record<DealType, { start: number; step: number; min: number; max: number } | null> = {
  PERCENT_OFF: { start: 50, step: 5, min: 5, max: 100 },
  AMOUNT_OFF: { start: 500, step: 100, min: 100, max: 10_000 },
  SET_PRICE: { start: 500, step: 100, min: 100, max: 10_000 },
  FREE_MATCH: null,
};
export const amountText = (type: DealType, amount: number) => (type === "PERCENT_OFF" ? `${amount}%` : money(amount));

export function dealText(type: DealType, amount: number): string {
  if (type === "PERCENT_OFF") return `${amount}% off`;
  if (type === "AMOUNT_OFF") return `${money(amount)} off`;
  if (type === "SET_PRICE") return `${money(amount)} spot`;
  return "Free match";
}
export const usesText = (n: number) => (n === 1 ? "1 match" : `${n} matches`);

// USES PER PLAYER: a stepper from 1 to MAX_USES_PER_PLAYER (the backend's MAX_OFFER_USES_PER_PLAYER).
export const MAX_USES_PER_PLAYER = 20;
export const stepUses = (n: number, dir: 1 | -1) => Math.min(MAX_USES_PER_PLAYER, Math.max(1, n + dir));
export const usesLine = (n: number) => (n === 1 ? "Each player can use it on 1 match before it ends." : `Each player can use it on up to ${n} matches before it ends.`);
// TOTAL LIMIT (maxRedemptions): null is no limit; otherwise 1 and up.
export const stepLimit = (n: number | null, dir: 1 | -1) => Math.max(1, (n ?? 0) + dir);
export const limitLine = (n: number) => `The offer stops once ${n.toLocaleString("en-US")} ${n === 1 ? "use is" : "uses are"} taken across all players.`;

const spotsTaken = (m: Pick<MatchOpt, "players" | "maxPlayers">) => (m.maxPlayers === null ? `${m.players} ${m.players === 1 ? "spot" : "spots"} taken` : `${m.players} of ${m.maxPlayers} spots taken`);
export function matchShort(m: MatchOpt): string {
  return `${wallLabel(m.startLocal)}${m.fieldTitle ? ` · ${m.fieldTitle}` : ""}`;
}
// "Normally $9 · 11 of 16 spots taken · needs 3 more · offer ends at kickoff"
export function matchInfo(m: MatchOpt): string {
  const parts = [`Normally ${money(m.price)}`, spotsTaken(m)];
  const needs = m.minPlayers - m.players;
  if (needs > 0) parts.push(`needs ${needs} more`);
  parts.push("offer ends at kickoff");
  return parts.join(" · ");
}

// ── THE MATCH PICKER (Figma 20638:45) ────────────────────────────────────────────────────────────
export type PickerDays = 7 | 14;
export type PickerFilter = { search: string; days: PickerDays; needsPlayers: boolean; cityIds: number[] };
export const matchNeeds = (m: Pick<MatchOpt, "minPlayers" | "players">) => Math.max(0, m.minPlayers - m.players);
export const fillFraction = (m: Pick<MatchOpt, "players" | "maxPlayers">) => (m.maxPlayers !== null && m.maxPlayers > 0 ? Math.min(1, Math.max(0, m.players / m.maxPlayers)) : 0);
// "11/16 · needs 3"
export function fillText(m: Pick<MatchOpt, "minPlayers" | "players" | "maxPlayers">): string {
  const needs = matchNeeds(m);
  const of = m.maxPlayers === null ? `${m.players}` : `${m.players}/${m.maxPlayers}`;
  return `${of}${needs > 0 ? ` · needs ${needs}` : m.maxPlayers !== null && m.players >= m.maxPlayers ? " · full" : ""}`;
}
// "TODAY · FRI OCT 30", then "SAT OCT 31".
export function pickerDayLabel(startLocal: string, nowWall: string): string {
  const day = fmt(wallMs(startLocal), { weekday: "short", month: "short", day: "numeric" }).replace(",", "").toUpperCase();
  return calendarDaysBetween(nowWall, startLocal) === 0 ? `TODAY · ${day}` : day;
}
const pickerTime = (startLocal: string) => fmt(wallMs(startLocal), { hour: "numeric", minute: "2-digit" });
// Soonest first, grouped by day. total is every upcoming match in those cities and days; shown is what
// the search and Needs players leave of them. The next 7 days are today and the six after it.
export function pickerView(matches: MatchOpt[], f: PickerFilter, nowWall: string, cities: City[]) {
  const inWindow = matches.filter((m) => {
    const days = calendarDaysBetween(nowWall, m.startLocal);
    return m.upcoming && days >= 0 && days < f.days && (f.cityIds.length === 0 || (m.cityId !== null && f.cityIds.includes(m.cityId)));
  });
  const words = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kept = inWindow.filter((m) => {
    if (f.needsPlayers && matchNeeds(m) === 0) return false;
    const hay = `${m.fieldTitle ?? ""} ${pickerTime(m.startLocal)} ${pickerDayLabel(m.startLocal, nowWall)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => a.startLocal.localeCompare(b.startLocal) || a.id - b.id);
  const groups: { label: string; rows: { match: MatchOpt; time: string }[] }[] = [];
  for (const m of kept) {
    const label = pickerDayLabel(m.startLocal, nowWall);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, rows: [] });
    groups[groups.length - 1].rows.push({ match: m, time: pickerTime(m.startLocal) });
  }
  const where = f.cityIds.length ? `${andList(cityNames(f.cityIds, cities))} ` : "";
  const footer = `Showing ${kept.length} of ${inWindow.length} ${where}${inWindow.length === 1 ? "match" : "matches"} in the next ${f.days} days`;
  return { groups, shown: kept.length, total: inWindow.length, footer };
}

// ── WHO GETS IT ──────────────────────────────────────────────────────────────────────────────────
export type Audience = Pick<Campaign, "audienceMode" | "playerIds" | "fieldIds" | "cityIds" | "lastPlayed" | "lastPlayedDays" | "minMatches" | "maxMatches" | "membership">;
const fieldNames = (ids: number[], fields: FieldOpt[]) => ids.map((id) => fields.find((x) => x.id === id)?.title ?? `Field ${id}`);

const cityNames = (ids: number[], cities: City[]) => ids.map((id) => cities.find((c) => c.id === id)?.name ?? `City ${id}`);
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function matchesText(min: number, max: number | null): string | null {
  if (max !== null && max === min) return `Played ${usesText(min)}`;
  if (max !== null && min > 0) return `${min} to ${max} matches`;
  if (max !== null) return `Up to ${usesText(max)}`;
  if (min > 0) return `${min}+ matches`;
  return null;
}

// The list's audience line: "Austin · Not played in 30+ days".
export function audienceText(a: Audience, cities: City[], fields: FieldOpt[]): string {
  if (a.audienceMode === "PLAYERS") return `${a.playerIds.length.toLocaleString("en-US")} chosen ${a.playerIds.length === 1 ? "player" : "players"}`;
  const parts = [a.cityIds.length ? cityNames(a.cityIds, cities).join(", ") : "All cities"];
  if (a.lastPlayed === "LAPSED") parts.push(`Not played in ${a.lastPlayedDays}+ days`);
  if (a.lastPlayed === "NEVER") parts.push("Never played");
  if (a.membership === "MEMBERS") parts.push("Members");
  if (a.membership === "NON_MEMBERS") parts.push("Not members");
  const mt = matchesText(a.minMatches, a.maxMatches);
  if (mt) parts.push(mt);
  if (a.fieldIds.length) parts.push(`Played at ${fieldNames(a.fieldIds, fields).join(" or ")}`);
  return parts.join(" · ");
}

// ── THE FORM ─────────────────────────────────────────────────────────────────────────────────────
export type Form = {
  name: string; dealType: DealType; dealAmount: number; usesPerPlayer: number;
  matchId: number | null; scope: "ANY" | "MATCH";
  audienceMode: AudienceMode;
  // Specific players: the box as typed, and the ids it holds that the lookup has not ruled out.
  playerIdsText: string; playerIds: number[];
  // Played at: players who ever played at any of these fields. Empty is no field filter.
  fieldIds: number[];
  cityIds: number[]; lastPlayed: LastPlayed; lastPlayedDays: number | null; membership: Membership;
  minMatches: number; maxMatches: number | null;
  startsLocal: string; endsLocal: string | null; holdoutPercent: number; maxRedemptions: number | null;
  showTicket: boolean;
  // Where the popup's button goes (Edit text › Button opens). Forced to the deal's match when the
  // offer is for a specific match; see buttonOf.
  buttonTarget: ButtonTarget; buttonMatchId: number | null;
  // Copy per key. Absent is the suggestion, and moves with the deal, audience and match. A string was
  // typed and stays; an emptied box stays empty rather than going back to the deal (see copyOf). null
  // is a removed section and never comes back on its own.
  copy: Partial<Record<CopyKey, string | null>>;
};

export function newForm(nowWall: string): Form {
  return {
    name: "", dealType: "PERCENT_OFF", dealAmount: 50, usesPerPlayer: 1, matchId: null, scope: "ANY",
    audienceMode: "FILTERS", playerIdsText: "", playerIds: [], fieldIds: [],
    cityIds: [], lastPlayed: "ANY", lastPlayedDays: null, membership: "ANYONE",
    minMatches: 0, maxMatches: null, ...defaultRun(nowWall), holdoutPercent: 10, maxRedemptions: null, showTicket: true,
    buttonTarget: "FIND_MATCH", buttonMatchId: null, copy: {},
  };
}

export function formOf(c: Campaign, matches: MatchOpt[], cities: City[]): Form {
  const f: Form = {
    name: c.name, dealType: c.dealType, dealAmount: c.dealAmount, usesPerPlayer: c.usesPerPlayer,
    matchId: c.matchIds[0] ?? null, scope: c.matchScoped ? "MATCH" : "ANY",
    cityIds: c.cityIds, lastPlayed: c.lastPlayed, lastPlayedDays: c.lastPlayedDays, membership: c.membership,
    audienceMode: c.audienceMode, playerIdsText: c.playerIds.join(", "), playerIds: c.playerIds, fieldIds: c.fieldIds,
    minMatches: c.minMatches, maxMatches: c.maxMatches,
    startsLocal: c.startsLocal, endsLocal: c.endsLocal, holdoutPercent: c.holdoutPercent, maxRedemptions: c.maxRedemptions, showTicket: c.showTicket ?? true,
    buttonTarget: c.buttonTarget, buttonMatchId: c.buttonMatchId, copy: {},
  };
  // Stored copy that differs from what the deal would write was typed by someone: keep it as typed.
  // A stored null on a section is removed even where nothing is suggested today: the backend can't tell
  // the two apart, and a removed section must not come back when the audience or the match changes.
  const auto = autoCopy(f, matches, cities);
  for (const k of COPY_KEYS) {
    const stored = c[k] ?? null;
    if (stored !== (auto[k] ?? null) || (stored === null && isRemovable(k))) f.copy[k] = stored;
  }
  // A specific match's button opens that match because of the match (buttonOf), so it isn't kept as
  // someone's pick: moving the offer to any match goes back to Find a match, not the old match.
  if (c.matchScoped && c.buttonTarget === "MATCH" && c.buttonMatchId === c.matchIds[0]) { f.buttonTarget = "FIND_MATCH"; f.buttonMatchId = null; }
  return f;
}

// The matches an offer names: the page's list may not hold them (a past match, or one outside its days).
export const namedMatchIds = (c: Pick<Campaign, "matchIds" | "buttonMatchId">) =>
  [...new Set([...c.matchIds, ...(c.buttonMatchId ? [c.buttonMatchId] : [])])];

// Picking a specific match prefills Played at with its field (kept if already there).
export const prefillField = (fieldIds: number[], m: Pick<MatchOpt, "fieldId">) =>
  m.fieldId === null || fieldIds.includes(m.fieldId) ? fieldIds : [...fieldIds, m.fieldId];

export const pickedMatch = (f: Pick<Form, "scope" | "matchId">, matches: MatchOpt[]) =>
  f.scope === "MATCH" && f.matchId !== null ? matches.find((m) => m.id === f.matchId) ?? null : null;

// ── WHERE THE BUTTON GOES ─────────────────────────────────────────────────────────────────────────
// An offer for a specific match always opens that match (locked). Otherwise it is the person's pick:
// Find a match, or one match of their choosing (the offer still works on any match). A stored
// MEMBERSHIP target is kept as it is; this page does not offer it.
export type ButtonDest = { target: ButtonTarget; matchId: number | null; locked: boolean };
export function buttonOf(f: Form, matches: MatchOpt[]): ButtonDest {
  const m = pickedMatch(f, matches);
  if (m) return { target: "MATCH", matchId: m.id, locked: true };
  if (f.buttonTarget === "MATCH") return { target: "MATCH", matchId: f.buttonMatchId, locked: false };
  return { target: f.buttonTarget, matchId: null, locked: false };
}
// "Thu 7:00 PM · Mueller Park"
export const matchDay = (m: MatchOpt) =>
  `${fmt(wallMs(m.startLocal), { weekday: "short" })} ${fmt(wallMs(m.startLocal), { hour: "numeric", minute: "2-digit" })}${m.fieldTitle ? ` · ${m.fieldTitle}` : ""}`;
// The line under the preview: "↳ Opens Find a match" / "↳ Opens Thu 7:00 PM · Mueller Park".
export function opensText(f: Form, matches: MatchOpt[]): string {
  const b = buttonOf(f, matches);
  if (b.target === "MEMBERSHIP") return "↳ Opens Membership";
  if (b.target === "FIND_MATCH") return "↳ Opens Find a match";
  const bm = matches.find((x) => x.id === b.matchId);
  return bm ? `↳ Opens ${matchDay(bm)}` : "↳ Opens a match (pick one)";
}
// The mint note under the button's own match: "Normally $9 · 11 of 16 spots taken. The offer still works on any match."
export const buttonMatchNote = (m: MatchOpt) => `Normally ${money(m.price)} · ${spotsTaken(m)}. The offer still works on any match.`;

// ── THE POPUP TEXT, written from the deal ─────────────────────────────────────────────────────────
// The app (OfferPopup.tsx) renders exactly these fields. {firstName} in any of them is filled in by
// the backend for each player (GET /offers/popup); with no first name it drops the token and the
// comma or space left hanging. The preview shows it as PREVIEW_FIRST_NAME.
export const FIRST_NAME_TOKEN = "{firstName}";
export const PREVIEW_FIRST_NAME = "Luis";
export const withPreviewName = <T extends string | null>(text: T): T =>
  (text === null ? text : text.split(FIRST_NAME_TOKEN).join(PREVIEW_FIRST_NAME)) as T;
export function autoCopy(f: Form, matches: MatchOpt[], cities: City[] = []): Copy {
  const m = pickedMatch(f, matches);
  const n = f.usesPerPlayer;
  const headline = f.dealType === "PERCENT_OFF" ? `${f.dealAmount}% OFF`
    : f.dealType === "AMOUNT_OFF" ? `${money(f.dealAmount)} OFF`
    : f.dealType === "SET_PRICE" ? `${money(f.dealAmount)} SPOT` : "FREE MATCH";
  const line = m ? `${fmt(wallMs(m.startLocal), { weekday: "short" })} ${fmt(wallMs(m.startLocal), { hour: "numeric", minute: "2-digit" })}${m.fieldTitle ? ` · ${m.fieldTitle}` : ""}`.toUpperCase()
    : n === 1 ? "YOUR NEXT MATCH" : `YOUR NEXT ${n} MATCHES`;
  const where = f.cityIds.length ? ` in ${andList(cityNames(f.cityIds, cities))}` : "";
  const body = m
    ? `${matchDay(m)}, normally ${money(m.price)}. The discount is already on your account.`
    : `${n === 1 ? "Any match" : `Any ${n} matches`}${where}. The discount is already on your account.`;
  const eyebrow = f.lastPlayed === "LAPSED" ? `WE MISS YOU, ${FIRST_NAME_TOKEN}` : f.lastPlayed === "NEVER" ? "YOUR FIRST MATCH" : m && m.fieldId !== null && f.fieldIds.includes(m.fieldId) ? "YOUR FIELD" : "JUST FOR YOU";
  const caption = m ? `Your spot at ${m.fieldTitle ?? "the field"} is waiting.` : f.lastPlayed === "LAPSED" ? "Your spot at the field is waiting." : null;
  // The photo: a specific match's own field cover, else null (the app's default MatchDay photo).
  return { eyebrow, caption, headline, line, body, photoUrl: m?.fieldCover ?? null, buttonLabel: m ? "Join this match" : "Find a match", dismissLabel: "Not now" };
}
export function copyOf(f: Form, matches: MatchOpt[], cities: City[]): Copy {
  const auto = autoCopy(f, matches, cities);
  const out = { ...auto };
  for (const k of COPY_KEYS) {
    const typed = f.copy[k];
    if (typed === undefined) continue;
    const blank = typed !== null && typed.trim() === "";
    const o = out as Record<CopyKey, string | null>;
    if (isRemovable(k)) o[k] = typed === null || blank ? null : typed;
    // Required: left blank so formProblem stops the save. Nothing else can make these null.
    else if (k === "headline" || k === "buttonLabel") { if (typed !== null) o[k] = typed; }
    // The dismiss link has no empty state (the column is NOT NULL and the app always draws one).
    else if (!blank) o[k] = typed;
  }
  return out;
}

// ── OPTIONAL SECTIONS ────────────────────────────────────────────────────────────────────────────
// The four parts of the popup staff can cut. Removed is stored as null and the app draws nothing for
// null (OfferPopup.tsx). The headline and the button label are required; the dismiss link and the photo
// are not sections.
export const REMOVABLE_KEYS = ["eyebrow", "caption", "line", "body"] as const;
export type RemovableKey = (typeof REMOVABLE_KEYS)[number];
export function isRemovable(k: CopyKey): k is RemovableKey { return (REMOVABLE_KEYS as readonly CopyKey[]).includes(k); }
export const SECTION_ADD: Record<RemovableKey, string> = { eyebrow: "+ Add tag", caption: "+ Add photo line", line: "+ Add line", body: "+ Add body" };
// Collapsed: removed, or following a deal that suggests nothing (only the photo line can do that).
export const sectionCollapsed = (copy: Form["copy"], k: RemovableKey, suggested: string | null) =>
  copy[k] === null || (copy[k] === undefined && suggested === null);
export const removeSection = (copy: Form["copy"], k: RemovableKey): Form["copy"] => ({ ...copy, [k]: null });
// Back to what it held before Remove (typedBefore) if anything was typed, else the deal's text. With
// no suggestion there is nothing to show, so an empty box opens; left empty it still saves as null.
export function addSection(copy: Form["copy"], k: RemovableKey, typedBefore: string | undefined, suggested: string | null): Form["copy"] {
  if (typedBefore !== undefined) return { ...copy, [k]: typedBefore };
  return suggested === null ? { ...copy, [k]: "" } : resetCopy(copy, k);
}
// Typing the suggestion itself is the same as not having touched it, so it keeps following.
export function copyAfterType(copy: Form["copy"], k: CopyKey, text: string, suggested: string | null): Form["copy"] {
  return text === suggested ? resetCopy(copy, k) : { ...copy, [k]: text };
}
export function resetCopy(copy: Form["copy"], k: CopyKey): Form["copy"] {
  const next = { ...copy };
  delete next[k];
  return next;
}
// Only when it would change something: with no suggestion, or the suggestion already there, it is not offered.
export function canReset(copy: Form["copy"], k: CopyKey, suggested: string | null): boolean {
  const typed = copy[k];
  return typeof typed === "string" && suggested !== null && typed !== suggested;
}

// ── WRITTEN FOR THE OLD DEAL ─────────────────────────────────────────────────────────────────────
// Typed text doesn't follow the deal, so it can end up promising the wrong one. writtenFor holds what
// the deal suggested for each typed section when it was typed. The backend stores none of this, so the
// page keeps it per offer in the browser; text saved elsewhere counts as written for the deal it loads with.
export type WrittenFor = Partial<Record<CopyKey, string | null>>;
export const SECTION_NAME: Record<CopyKey, string> = {
  eyebrow: "Tag on the photo", caption: "Line on the photo", headline: "Headline", line: "Line", body: "Body", photoUrl: "Photo", buttonLabel: "Button label", dismissLabel: "Dismiss link",
};
export function writtenForOnLoad(f: Form, kept: WrittenFor, matches: MatchOpt[], cities: City[]): WrittenFor {
  const auto = autoCopy(f, matches, cities);
  const out: WrittenFor = {};
  for (const k of COPY_KEYS) if (k !== "photoUrl" && typeof f.copy[k] === "string") out[k] = k in kept ? kept[k] : auto[k];
  return out;
}
// Only before launch: after it the deal, audience and match are locked, so nothing can go stale.
export function staleSections(f: Form, writtenFor: WrittenFor, status: CampaignStatus | null, matches: MatchOpt[], cities: City[]): CopyKey[] {
  if (status !== null && status !== "DRAFT") return [];
  const auto = autoCopy(f, matches, cities);
  return COPY_KEYS.filter((k) => {
    const typed = f.copy[k];
    return k !== "photoUrl" && typeof typed === "string" && typed.trim() !== "" && k in writtenFor && (writtenFor[k] ?? null) !== (auto[k] ?? null) && typed !== auto[k];
  });
}
// What the Launch confirm lists. Empty: the confirm says nothing about old text.
export const staleLines = (stale: CopyKey[], f: Form) => stale.map((k) => `${SECTION_NAME[k]}: ${f.copy[k]}`);

// ── THE PHOTO ────────────────────────────────────────────────────────────────────────────────────
// photoUrl must be https. The one exception is the local backend's own files (seeded covers and local
// uploads), judged on the PARSED host, so http://localhost:3070.evil.com does not pass. The backend
// refuses that address outside local mode anyway.
export function photoUrlOk(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && u.host === LOCAL_MDAPI_HOST && u.pathname.startsWith("/dev/uploads/");
}

// UPLOADS (backend f34bb7a): 1. POST photo-uploads { contentType, sizeBytes } gives a 15-minute link.
// 2. The BROWSER PUTs the raw file there with the returned headers (locally the API, later S3).
// 3. POST photo-uploads/register { fileKey } gives the url to save as photoUrl. Each key registers once.
export const MAX_PHOTO_BYTES = 5_242_880; // 5 MB, the backend's limit
export type PhotoContentType = "image/jpeg" | "image/png" | "image/webp";
const PHOTO_TYPES: PhotoContentType[] = ["image/jpeg", "image/png", "image/webp"];
export function photoContentType(file: { type: string; name: string }): PhotoContentType | null {
  if ((PHOTO_TYPES as string[]).includes(file.type)) return file.type as PhotoContentType;
  if (file.type) return null;
  return /\.jpe?g$/i.test(file.name) ? "image/jpeg" : /\.png$/i.test(file.name) ? "image/png" : /\.webp$/i.test(file.name) ? "image/webp" : null;
}
export function photoFileProblem(file: { type: string; name: string; size: number }): string | null {
  if (!photoContentType(file)) return "Only JPG, PNG or WebP images can be uploaded.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > MAX_PHOTO_BYTES) return "That image is over 5 MB, the most that can be uploaded.";
  return null;
}
// Headers a page may not set; the browser sends its own correct values for these.
const FORBIDDEN_HEADERS = new Set(["content-length", "host", "connection", "transfer-encoding"]);
// Null: the link came without its headers, and a PUT without them would be refused or stored wrongly.
export const settableHeaders = (h: Record<string, string> | null | undefined) =>
  (h && typeof h === "object" ? Object.entries(h).filter(([k]) => !FORBIDDEN_HEADERS.has(k.toLowerCase())) : null);
// The tiles after the field covers: this offer's uploads, then the saved photo if it is neither a
// cover shown here nor one of those uploads (so a stored photo can always be switched back to).
export type UploadedPhoto = { url: string; name: string };
export function uploadTiles(uploaded: UploadedPhoto[], stored: string | null, coverUrls: string[]): UploadedPhoto[] {
  const out = uploaded.filter((p, i) => !coverUrls.includes(p.url) && uploaded.findIndex((x) => x.url === p.url) === i);
  if (stored && !coverUrls.includes(stored) && !out.some((p) => p.url === stored)) out.push({ url: stored, name: "Saved photo" });
  return out;
}

// HIDING AN UPLOAD (the × on its tile): off this offer's tiles in this browser, nothing more. The file
// stays on the server. The photo the offer is saved with has no ×: the offer is still using it. A
// hidden photo that was selected but not saved stops being selected and the offer goes back to its
// SAVED photo, or to its default if it was never saved, so hiding alone never creates a change to save.
export const canHidePhoto = (url: string, stored: string | null) => url !== stored;
export const hideUpload = (uploaded: UploadedPhoto[], url: string) => uploaded.filter((p) => p.url !== url);
// `saved` is the campaign's stored photoUrl (undefined: a new offer, nothing saved). `deflt` is what the
// deal would pick right now. When those agree the key is dropped, so the offer keeps following the
// deal as it did before the pick, rather than being pinned to today's answer.
export function copyAfterHide(copy: Form["copy"], url: string, saved: string | null | undefined, deflt: string | null): Form["copy"] {
  if (copy.photoUrl !== url) return copy;
  const { photoUrl: _gone, ...rest } = copy;
  return saved === undefined || saved === deflt ? rest : { ...rest, photoUrl: saved };
}

// ── REQUEST BODIES ───────────────────────────────────────────────────────────────────────────────
// Everything the campaign would hold, as the backend's field names.
export function fullBody(f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  const m = pickedMatch(f, matches);
  const copy = copyOf(f, matches, cities);
  // Specific players: the filters are stored as their defaults and nobody is held back (the
  // backend does this too); sending the defaults keeps the read-back equal to what was sent.
  const players = f.audienceMode === "PLAYERS";
  return {
    name: f.name.trim(), dealType: f.dealType, dealAmount: f.dealType === "FREE_MATCH" ? 0 : f.dealAmount,
    usesPerPlayer: m ? 1 : f.usesPerPlayer,
    // Sorted: the backend stores the list in id order, so this is what reads back.
    audienceMode: f.audienceMode, playerIds: players ? [...f.playerIds].sort((x, y) => x - y) : [],
    cityIds: players ? [] : f.cityIds, fieldIds: players ? [] : f.fieldIds,
    lastPlayed: players ? "ANY" : f.lastPlayed, lastPlayedDays: !players && f.lastPlayed === "LAPSED" ? f.lastPlayedDays : null,
    minMatches: players ? 0 : f.minMatches, maxMatches: players ? null : f.maxMatches, membership: players ? "ANYONE" : f.membership,
    matchIds: m ? [m.id] : [],
    startsLocal: f.startsLocal, endsLocal: f.endsLocal, holdoutPercent: players ? 0 : f.holdoutPercent, maxRedemptions: f.maxRedemptions,
    showTicket: f.showTicket,
    ...copy, buttonTarget: buttonOf(f, matches).target, buttonMatchId: buttonOf(f, matches).matchId,
  };
}

// CREATE: the full body with nulls left out (the backend's defaults stand in for them), except a
// removed section and no end date, which are sent as null like any other save. A shown ticket is the
// default, so it's left out as well.
export function createBody(f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fullBody(f, matches, cities)).filter(([k, v]) => (k === "showTicket" ? v === false : v !== null || k === "endsLocal" || isRemovable(k as CopyKey))));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// EDIT: only what changed against the campaign as the backend holds it. After launch only the
// fields the backend still accepts are compared at all, so a locked field can never be sent.
export function patchBody(c: Campaign, f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  const full = fullBody(f, matches, cities);
  const locked = c.status !== "DRAFT";
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    if (locked && !EDITABLE_AFTER_LAUNCH.has(k)) continue;
    const stored = k === "showTicket" ? (c.showTicket ?? true) : (c as unknown as Record<string, unknown>)[k];
    if (!same(v, stored)) out[k] = v;
  }
  return out;
}

// The live count's body: who gets it and the deal, never the copy.
export function audienceBody(f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  const full = fullBody(f, matches, cities);
  const keys = ["audienceMode", "playerIds", "cityIds", "fieldIds", "lastPlayed", "lastPlayedDays", "minMatches", "maxMatches", "membership", "matchIds", "dealType", "dealAmount", "usesPerPlayer", "maxRedemptions", "holdoutPercent"];
  return Object.fromEntries(keys.filter((k) => full[k] !== null && full[k] !== undefined).map((k) => [k, full[k]]));
}

// What stops a launch or a save, in plain words. Null: nothing.
// status: a launched offer's deal is locked, so a deal rule can't stop it saving its name or text.
export function formProblem(f: Form, matches: MatchOpt[], status: CampaignStatus | null = null): string | null {
  if (!f.name.trim()) return "Give the offer a name.";
  if (status === null || status === "DRAFT") { const deal = setPriceProblem(f, pickedMatch(f, matches)); if (deal) return deal; }
  if (f.scope === "MATCH" && !pickedMatch(f, matches)) return "Pick the match.";
  if (f.endsLocal === null && f.scope === "MATCH") return "A specific match always ends at kickoff.";
  if (!Number.isFinite(wallMs(f.startsLocal)) || (f.endsLocal !== null && !Number.isFinite(wallMs(f.endsLocal)))) return "Set when it starts and ends.";
  if (f.endsLocal !== null && wallMs(f.endsLocal) <= wallMs(f.startsLocal)) return "It has to end after it starts.";
  const b = buttonOf(f, matches);
  if (b.target === "MATCH" && !matches.some((x) => x.id === b.matchId)) return "Pick the match the button opens.";
  if (f.maxRedemptions !== null && (!Number.isInteger(f.maxRedemptions) || f.maxRedemptions < 1)) return "The total limit must be 1 or more.";
  if (f.audienceMode === "PLAYERS" && f.playerIds.length === 0) return "Add at least one player ID.";
  if (f.copy.headline?.trim() === "") return "The popup needs a headline.";
  if (f.copy.buttonLabel?.trim() === "") return "The popup needs a button label.";
  const photo = copyOf(f, matches, [])["photoUrl"];
  if (photo !== null && !photoUrlOk(photo)) return "The photo must be an https link.";
  return null;
}

// SET PRICE: at least $1, whatever the deal is on. Above the normal price of the one match it is for is
// refused; on any match the normal price differs match to match, so it is only a warning.
export const MIN_SET_PRICE = 100;
export function setPriceProblem(f: Pick<Form, "dealType" | "dealAmount">, m: Pick<MatchOpt, "price"> | null): string | null {
  if (f.dealType !== "SET_PRICE") return null;
  if (!Number.isInteger(f.dealAmount) || f.dealAmount < MIN_SET_PRICE) return `A set price must be at least ${money(MIN_SET_PRICE)}.`;
  if (m && f.dealAmount > m.price) return `That is above this match's normal ${money(m.price)}. Set it at or below that.`;
  return null;
}
export function setPriceAnyWarning(f: Form, matches: MatchOpt[]): string | null {
  if (f.dealType !== "SET_PRICE" || f.scope !== "ANY") return null;
  const anyCity = f.audienceMode === "PLAYERS" || f.cityIds.length === 0;
  const prices = matches.filter((m) => m.upcoming && (anyCity || (m.cityId !== null && f.cityIds.includes(m.cityId)))).map((m) => m.price);
  if (prices.length === 0) return null;
  const low = Math.min(...prices);
  // The backend's join-pricing.ts: on a match already cheaper, the player pays that lower price and the offer isn't used.
  return f.dealAmount > low ? `${money(f.dealAmount)} is above the normal price of some matches here (as low as ${money(low)}). On those, players pay the normal price and the offer isn't used.` : null;
}

// ── WHAT STOPS A LAUNCH, on top of formProblem ───────────────────────────────────────────────────
// WHEN THE END HAS PASSED. The backend stops each player's offer at endsLocal in that player's own city
// (prisma-offers.store.ts isLiveInZone), so it falls at a different instant per city. An offer is past
// its end from the moment that's true in ANY of its cities: its own, plus a specific match's city.
// With no city (all cities, or specific players) that's every city there is. No zone known reads as UTC.
export function offerZones(a: Pick<Campaign, "cityIds" | "audienceMode">, matchCityId: number | null, cities: City[]): string[] {
  const own = a.audienceMode === "PLAYERS" ? [] : a.cityIds;
  const ids = [...own, ...(matchCityId !== null ? [matchCityId] : [])];
  const from = ids.length ? cities.filter((c) => ids.includes(c.id)) : cities;
  const zones = [...new Set(from.map((c) => c.timeZone).filter((z): z is string => !!z))];
  return zones.length ? zones : ["UTC"];
}
// The wall clock furthest ahead among those zones: the end reaches it first.
export const offerWallNow = (zones: string[], now: Date = new Date()) => zones.map((z) => wallNowIn(z, now)).sort().at(-1)!;
export const endHasPassed = (endsLocal: string | null, nowWall: string) => endsLocal !== null && wallMs(endsLocal) <= wallMs(nowWall);
export const launchProblem = (x: { endsLocal: string | null }, nowWall: string): string | null =>
  endHasPassed(x.endsLocal, nowWall) ? "The end time has already passed. Pick a later end." : null;

// THE LIVE COUNT'S STATE. asked is the body as the form stands; answered is the body the last answer
// was for. A count for an older audience is loading, not ready, from the moment the form changes.
export const COUNT_DEBOUNCE_MS = 800;
// Only while the audience can still change. Opening a launched or ended offer reads nothing for it.
export const countWanted = (status: CampaignStatus | null) => status === null || status === "DRAFT";
export type CountState = "loading" | "ready" | "error";
export const countState = (asked: string, answered: string | null, failed: boolean): CountState =>
  asked !== answered ? "loading" : failed ? "error" : "ready";
export const COUNT_BLOCK: Record<CountState, string | null> = {
  loading: "Still counting the players.", error: "Couldn't count the players, so it can't launch yet. Retry the count.", ready: null,
};

// WHAT GOES IN change_log: how many players, never which. A list of player ids is a second copy of who
// was targeted, with different access rules. The request itself still carries the ids.
export function offersLogBody(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...body };
  for (const [k, to] of [["playerIds", "playerCount"], ["userIds", "userCount"]] as const) {
    if (k in out) { out[to] = Array.isArray(out[k]) ? (out[k] as unknown[]).length : 0; delete out[k]; }
  }
  return out;
}

// ── THE SUMMARY ──────────────────────────────────────────────────────────────────────────────────
export type Count = { count: number; heldBack: number; players: number; mostItCanCost: number | null };

// When the backend cannot know the discount per use (% off, set price or free on any match), the most
// it can cost is worked out at the highest normal price now listed in those cities, and says so.
export function costCeiling(f: Form, count: Count, matches: MatchOpt[]): { cents: number; basis: string | null } | null {
  if (count.mostItCanCost !== null) return { cents: count.mostItCanCost, basis: null };
  const anyCity = f.audienceMode === "PLAYERS" || f.cityIds.length === 0;
  const pool = matches.filter((m) => m.upcoming && (anyCity || (m.cityId !== null && f.cityIds.includes(m.cityId))));
  if (pool.length === 0) return null;
  const top = Math.max(...pool.map((m) => m.price));
  let uses = count.players * f.usesPerPlayer;
  if (f.maxRedemptions) uses = Math.min(uses, f.maxRedemptions);
  return { cents: discountOn(top, f.dealType, f.dealAmount) * uses, basis: `at today's top price of ${money(top)}` };
}

function dealAndUntil(f: Form, m: MatchOpt | null, nowWall: string): { deal: string; until: string } {
  const n = m ? 1 : f.usesPerPlayer;
  const one = n === 1 ? "one match" : `${n} matches`;
  const deal = m
    ? (f.dealType === "FREE_MATCH" ? `${matchDay(m)} free` : f.dealType === "SET_PRICE" ? `a ${money(f.dealAmount)} spot in ${matchDay(m)}` : `${dealText(f.dealType, f.dealAmount)} ${matchDay(m)}`)
    : (f.dealType === "FREE_MATCH" ? (n === 1 ? "one free match" : `${n} free matches`) : f.dealType === "SET_PRICE" ? `a ${money(f.dealAmount)} spot in ${one}` : `${dealText(f.dealType, f.dealAmount)} ${one}`);
  const until = f.endsLocal === null ? "until you end it"
    : endHasPassed(f.endsLocal, nowWall) ? `until ${wallLabel(f.endsLocal)}, which has already passed`
    : m && f.endsLocal === m.startLocal ? "until kickoff"
    : calendarDaysBetween(nowWall, f.endsLocal) < 7 ? `until ${fmt(wallMs(f.endsLocal), { weekday: "short" })} ${fmt(wallMs(f.endsLocal), { hour: "numeric", minute: "2-digit" })}`
    : `until ${wallDate(f.endsLocal)}`;
  return { deal, until };
}
// PAUSE AND END, what they do to players already holding it. Held offers stay usable until their own
// expiry, so with no end date the backend stops them the moment the offer is ended.
export const pauseNote = (endsLocal: string | null) => (endsLocal === null
  ? "No new players get it; players who have it can still use it until you end it. You can resume it."
  : "Nobody new gets it and no popup shows. Players who already have it can still use it until it expires. You can resume it.");
export const endNote = (endsLocal: string | null) => (endsLocal === null
  ? "Players lose this offer immediately. It can't be launched again."
  : "Nobody new gets it and no popup shows. Players who already have it can still use it until it expires. It can't be launched again.");

// A launched or ended offer has no live count, so it says who by its filters, not how many.
export function lockedSummary(f: Form, matches: MatchOpt[], cities: City[], nowWall: string, fields: FieldOpt[] = []): string {
  const { deal, until } = dealAndUntil(f, pickedMatch(f, matches), nowWall);
  return `${audienceText(f, cities, fields)}: ${deal} ${until}.`;
}

export function summary(f: Form, count: Count | null, matches: MatchOpt[], cities: City[], nowWall: string, fields: FieldOpt[] = []): string {
  if (!count) return "Counting players…";
  const m = pickedMatch(f, matches);
  const n = m ? 1 : f.usesPerPlayer;
  const players = f.audienceMode === "PLAYERS";
  const where = !players && f.cityIds.length ? `${andList(cityNames(f.cityIds, cities))} ` : "";
  const one1 = count.players === 1;
  const who: string[] = [];
  if (players) { /* the chosen players, nothing else */ } else {
  if (f.lastPlayed === "LAPSED") who.push(`${one1 ? "hasn't" : "haven't"} played in ${f.lastPlayedDays}+ days`);
  if (f.lastPlayed === "NEVER") who.push(`${one1 ? "has" : "have"} never played`);
  if (f.membership === "MEMBERS") who.push(one1 ? "is a member" : "are members");
  if (f.membership === "NON_MEMBERS") who.push(one1 ? "isn't a member" : "aren't members");
  if (f.fieldIds.length) who.push(`${one1 ? "has" : "have"} played at ${fieldNames(f.fieldIds, fields).join(" or ")}`);
  }
  const { deal, until } = dealAndUntil(f, m, nowWall);
  const people = `${count.players.toLocaleString("en-US")} ${players ? "chosen " : ""}${where}${count.players === 1 ? "player" : "players"}`;
  const held = count.heldBack > 0 ? ` (${count.heldBack.toLocaleString("en-US")} more held back to measure)` : "";
  const ceiling = costCeiling(f, count, matches);
  const cost = ceiling ? `Most it can cost: ${money(ceiling.cents)}${ceiling.basis ? ` ${ceiling.basis}` : ""}.` : "Most it can cost: not known until matches are listed.";
  return `${people}${who.length ? ` who ${andList(who)}` : ""} ${one1 ? "gets" : "get"} ${deal} ${until}${held}. ${cost}`;
}

// AFTER A WRITE the list takes the write's own read-back, so nothing else is read. Newest first, as the
// backend lists them. GET /:id carries no results: a campaign in the list keeps the ones it has until the
// next Refresh, and a new one has none yet.
const NO_GROUP: BookedGroup = { players: 0, booked: 0, rate: null };
const NO_RESULTS: Results = { granted: 0, heldBack: 0, saw: 0, tapped: 0, dismissed: 0, used: 0, discountGiven: 0, cameBackAtFullPrice: 0, booked: { withOffer: NO_GROUP, heldBack: NO_GROUP } };
export type ListChange = { kind: "saved"; campaign: Campaign } | { kind: "gone"; id: number };
export function campaignsAfter(list: Campaign[], change: ListChange): Campaign[] {
  if (change.kind === "gone") return list.filter((c) => c.id !== change.id);
  return list.some((c) => c.id === change.campaign.id)
    ? list.map((c) => (c.id === change.campaign.id ? { ...c, ...change.campaign } : c))
    : [{ ...change.campaign, results: change.campaign.results ?? NO_RESULTS }, ...list];
}

// ── THE LIST AND THE RESULTS ─────────────────────────────────────────────────────────────────────
export const STATE_LABEL: Record<CampaignState, string> = { DRAFT: "Draft", SCHEDULED: "Scheduled", LIVE: "Live", PAUSED: "Paused", ENDED: "Ended" };

export function resultsLines(c: Campaign): [string, string] {
  if (c.state === "DRAFT") return ["Not launched", ""];
  if (c.state === "SCHEDULED") return [`Starts ${wallDate(c.startsLocal)}`, ""];
  const r = c.results;
  const usedPart = typeof r.usesTaken === "number" && typeof r.maxRedemptions === "number" ? usedOfLimit(r)! : `${r.used.toLocaleString("en-US")} used`;
  return [`${r.saw.toLocaleString("en-US")} saw · ${usedPart}`, `${money(r.discountGiven)} off · ${r.cameBackAtFullPrice.toLocaleString("en-US")} came back`];
}

// "10 of 10 used" from usesTaken and the limit, when a limit is set (null otherwise).
export function usedOfLimit(r: Results): string | null {
  if (typeof r.usesTaken !== "number" || typeof r.maxRedemptions !== "number") return null;
  return `${r.usesTaken.toLocaleString("en-US")} of ${r.maxRedemptions.toLocaleString("en-US")} used`;
}

// The line under the comparison: "About 6 extra bookings · $9 in discounts per extra booking".
// N = players with the offer x (their booking rate - the held-back rate), to a whole number.
// $X = discount given / N, to the dollar. Rounding comes first: an N that rounds to 0 is no extra
// bookings, so X can never divide by zero. Null (no line) under MIN_HELD_BACK_TO_COMPARE held back,
// and for Specific players, where nobody is held back and the rates compare nothing.
export function extraBookingsLine(r: Results, mode: AudienceMode): string | null {
  const w = r.booked.withOffer, h = r.booked.heldBack;
  if (mode === "PLAYERS" || h.players < MIN_HELD_BACK_TO_COMPARE || w.rate === null || h.rate === null) return null;
  const n = Math.round(w.players * (w.rate - h.rate));
  if (n <= 0) return "No extra bookings so far";
  const x = Math.round(r.discountGiven / 100 / n);
  return `About ${n.toLocaleString("en-US")} extra ${n === 1 ? "booking" : "bookings"} · $${x.toLocaleString("en-US")} in discounts per extra booking`;
}

// ── PLAYER IDS (Specific players and Send test) ──────────────────────────────────────────────────
// Commas, spaces or one per line. Whole positive numbers only, first appearance kept, in order.
export function parsePlayerIds(text: string, max = 2000): { ids: number[]; bad: string[]; tooMany: boolean } {
  const ids: number[] = [], bad: string[] = [];
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    if (!/^\d+$/.test(tok) || Number(tok) <= 0) { bad.push(tok); continue; }
    const n = Number(tok);
    if (!ids.includes(n)) ids.push(n);
  }
  return { ids: ids.slice(0, max), bad, tooMany: ids.length > max };
}
export const MAX_TEST_IDS = 20;
export type Lookup = { players: { id: number; name: string | null; city: string | null; matchesPlayed: number }[]; notFound: number[] };
// "Luis Ortega · Austin · 3 matches"
export const playerLine = (p: Lookup["players"][number]) => `${p.name ?? `Player ${p.id}`}${p.city ? ` · ${p.city}` : ""} · ${usesText(p.matchesPlayed)}`;
export const notFoundLine = (ids: number[]) => `${ids.length} ID${ids.length === 1 ? "" : "s"} not found: ${ids.join(", ")}. ${ids.length === 1 ? "It" : "They"} will be skipped.`;

// "Day 4 of 7", "Paused · day 4 of 7", "Ended Sun, Nov 2", "Starts Mon, Nov 3".
export function progressText(c: Campaign, nowWall: string): string {
  if (c.state === "SCHEDULED") return `Starts ${wallDate(c.startsLocal)}`;
  if (c.state === "DRAFT") return "Not launched";
  if (c.endsLocal === null) {
    if (c.state === "ENDED") return "Ended";
    return `${c.state === "PAUSED" ? "Paused · day" : "Day"} ${Math.max(1, calendarDaysBetween(c.startsLocal, nowWall) + 1)}`;
  }
  const total = calendarDaysBetween(c.startsLocal, c.endsLocal) + 1;
  const day = Math.min(total, calendarDaysBetween(c.startsLocal, nowWall) + 1);
  if (c.state === "ENDED") return wallMs(nowWall) >= wallMs(c.endsLocal) ? `Ended ${wallDate(c.endsLocal)}` : "Ended early";
  return `${c.state === "PAUSED" ? "Paused · day" : "Day"} ${Math.max(1, day)} of ${total}`;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
// Below this many held-back players the comparison line shows no rates (Ryan, 2026-10-29).
export const MIN_HELD_BACK_TO_COMPARE = 30;
export function usedPct(r: Results): string | null {
  return r.saw > 0 ? pct(r.used / r.saw) : null;
}
// "With the offer, 9% booked. The 46 players held back with no offer: 3% booked."
export function comparisonLine(r: Results): string {
  const w = r.booked.withOffer, h = r.booked.heldBack;
  if (w.players === 0) return "Nobody has been given the offer yet, so there is nothing to compare.";
  if (h.players === 0 || h.rate === null) return `With the offer, ${pct(w.rate ?? 0)} booked. Nobody was held back, so there is nothing to compare it with.`;
  // A handful of held-back players is noise, not a result: no rates until there are enough.
  if (h.players < MIN_HELD_BACK_TO_COMPARE) return `Too few players held back to compare yet (${h.players.toLocaleString("en-US")} so far)`;
  return `With the offer, ${pct(w.rate ?? 0)} booked. The ${h.players.toLocaleString("en-US")} ${h.players === 1 ? "player" : "players"} held back with no offer: ${pct(h.rate)} booked.`;
}
