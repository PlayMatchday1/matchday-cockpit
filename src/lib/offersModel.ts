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

export type DealType = "PERCENT_OFF" | "AMOUNT_OFF" | "SET_PRICE" | "FREE_MATCH";
export type LastPlayed = "ANY" | "LAPSED" | "NEVER";
export type Membership = "ANYONE" | "MEMBERS" | "NON_MEMBERS";
export type ButtonTarget = "FIND_MATCH" | "MATCH" | "MEMBERSHIP";
export type CampaignStatus = "DRAFT" | "LAUNCHED" | "PAUSED" | "ENDED";
export type CampaignState = "DRAFT" | "SCHEDULED" | "LIVE" | "PAUSED" | "ENDED";

export type BookedGroup = { players: number; booked: number; rate: number | null };
export type Results = {
  granted: number; heldBack: number; saw: number; tapped: number; dismissed: number;
  used: number; discountGiven: number; cameBackAtFullPrice: number;
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
  maxRedemptions: number | null; cityIds: number[]; lastPlayed: LastPlayed; lastPlayedDays: number | null;
  minMatches: number; maxMatches: number | null; membership: Membership; playedAtMatchField: boolean;
  matchScoped: boolean; matchIds: number[]; startsLocal: string; endsLocal: string; holdoutPercent: number;
  buttonTarget: ButtonTarget; buttonMatchId: number | null; status: CampaignStatus; state: CampaignState;
  createdByStaffEmail: string | null; launchedByStaffEmail: string | null; launchedAt: string | null;
  results: Results;
};

export type City = { id: number; name: string };
// A match as the page needs it. startLocal is WALL CLOCK ("YYYY-MM-DD HH:mm:ss"). players is
// _count.players, the authoritative roster count.
export type MatchOpt = {
  id: number; name: string; startLocal: string; fieldId: number | null; fieldTitle: string | null;
  cityId: number | null; price: number; players: number; maxPlayers: number; minPlayers: number; upcoming: boolean;
};

// Fields a launched or paused campaign may still change (the backend's EDITABLE_AFTER_LAUNCH).
export const EDITABLE_AFTER_LAUNCH = new Set<string>([
  "name", "eyebrow", "caption", "headline", "line", "body", "photoUrl", "buttonLabel", "buttonTarget", "buttonMatchId", "dismissLabel", "maxRedemptions",
]);
// Every key the Clubhouse may send on create or edit. The routes drop anything else.
export const BODY_KEYS = new Set<string>([
  ...EDITABLE_AFTER_LAUNCH, "dealType", "dealAmount", "usesPerPlayer", "cityIds", "lastPlayed", "lastPlayedDays",
  "minMatches", "maxMatches", "membership", "playedAtMatchField", "matchIds", "startsLocal", "endsLocal", "holdoutPercent",
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

export function chicagoWallNow(now: Date = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((x) => [x.type, x.value]));
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
export function endsTicket(endsLocal: string, nowWall: string): string | null {
  const ms = wallMs(endsLocal);
  if (!Number.isFinite(ms)) return null;
  return calendarDaysBetween(nowWall, endsLocal) < 7
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

export function matchShort(m: MatchOpt): string {
  return `${wallLabel(m.startLocal)}${m.fieldTitle ? ` · ${m.fieldTitle}` : ""}`;
}
// "Normally $9 · 11 of 16 spots taken · needs 3 more · offer ends at kickoff"
export function matchInfo(m: MatchOpt): string {
  const parts = [`Normally ${money(m.price)}`, `${m.players} of ${m.maxPlayers} spots taken`];
  const needs = m.minPlayers - m.players;
  if (needs > 0) parts.push(`needs ${needs} more`);
  parts.push("offer ends at kickoff");
  return parts.join(" · ");
}

// ── WHO GETS IT ──────────────────────────────────────────────────────────────────────────────────
export type Audience = Pick<Campaign, "cityIds" | "lastPlayed" | "lastPlayedDays" | "minMatches" | "maxMatches" | "membership" | "playedAtMatchField">;

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
export function audienceText(a: Audience, cities: City[], field: string | null): string {
  const parts = [a.cityIds.length ? cityNames(a.cityIds, cities).join(", ") : "All cities"];
  if (a.lastPlayed === "LAPSED") parts.push(`Not played in ${a.lastPlayedDays}+ days`);
  if (a.lastPlayed === "NEVER") parts.push("Never played");
  if (a.membership === "MEMBERS") parts.push("Members");
  if (a.membership === "NON_MEMBERS") parts.push("Not members");
  const mt = matchesText(a.minMatches, a.maxMatches);
  if (mt) parts.push(mt);
  if (a.playedAtMatchField) parts.push(`Played at ${field ?? "this field"} before`);
  return parts.join(" · ");
}

// ── THE FORM ─────────────────────────────────────────────────────────────────────────────────────
export type Form = {
  name: string; dealType: DealType; dealAmount: number; usesPerPlayer: number;
  matchId: number | null; scope: "ANY" | "MATCH";
  cityIds: number[]; lastPlayed: LastPlayed; lastPlayedDays: number | null; membership: Membership; playedAtMatchField: boolean;
  minMatches: number; maxMatches: number | null;
  startsLocal: string; endsLocal: string; holdoutPercent: number; maxRedemptions: number | null;
  // Copy the person typed. A key that is absent (or cleared back to empty) follows the deal. null is
  // "none" for an optional line, kept from a stored campaign so loading it never invents a change.
  copy: Partial<Record<CopyKey, string | null>>;
};

export function newForm(nowWall: string): Form {
  return {
    name: "", dealType: "PERCENT_OFF", dealAmount: 50, usesPerPlayer: 1, matchId: null, scope: "ANY",
    cityIds: [], lastPlayed: "ANY", lastPlayedDays: null, membership: "ANYONE", playedAtMatchField: false,
    minMatches: 0, maxMatches: null, ...defaultRun(nowWall), holdoutPercent: 10, maxRedemptions: null, copy: {},
  };
}

export function formOf(c: Campaign, matches: MatchOpt[], cities: City[]): Form {
  const f: Form = {
    name: c.name, dealType: c.dealType, dealAmount: c.dealAmount, usesPerPlayer: c.usesPerPlayer,
    matchId: c.matchIds[0] ?? null, scope: c.matchScoped ? "MATCH" : "ANY",
    cityIds: c.cityIds, lastPlayed: c.lastPlayed, lastPlayedDays: c.lastPlayedDays, membership: c.membership, playedAtMatchField: c.playedAtMatchField,
    minMatches: c.minMatches, maxMatches: c.maxMatches,
    startsLocal: c.startsLocal, endsLocal: c.endsLocal, holdoutPercent: c.holdoutPercent, maxRedemptions: c.maxRedemptions, copy: {},
  };
  // Stored copy that differs from what the deal would write was typed by someone: keep it as typed.
  const auto = autoCopy(f, matches, cities);
  for (const k of COPY_KEYS) if ((c[k] ?? null) !== (auto[k] ?? null)) f.copy[k] = c[k] ?? null;
  return f;
}

export const pickedMatch = (f: Pick<Form, "scope" | "matchId">, matches: MatchOpt[]) =>
  f.scope === "MATCH" && f.matchId !== null ? matches.find((m) => m.id === f.matchId) ?? null : null;

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
    ? `${m.name}, normally ${money(m.price)}. The discount is already on your account.`
    : `${n === 1 ? "Any match" : `Any ${n} matches`}${where}. The discount is already on your account.`;
  const eyebrow = f.lastPlayed === "LAPSED" ? `WE MISS YOU, ${FIRST_NAME_TOKEN}` : f.lastPlayed === "NEVER" ? "YOUR FIRST MATCH" : m && f.playedAtMatchField ? "YOUR FIELD" : "JUST FOR YOU";
  const caption = m ? `Your spot at ${m.fieldTitle ?? "the field"} is waiting.` : f.lastPlayed === "LAPSED" ? "Your spot at the field is waiting." : null;
  return { eyebrow, caption, headline, line, body, photoUrl: null, buttonLabel: m ? "Join this match" : "Find a match", dismissLabel: "Not now" };
}
export function copyOf(f: Form, matches: MatchOpt[], cities: City[]): Copy {
  const auto = autoCopy(f, matches, cities);
  const out = { ...auto };
  for (const k of COPY_KEYS) {
    const typed = f.copy[k];
    const optional = k !== "headline" && k !== "buttonLabel";
    if (typed === null ? optional : typed !== undefined && typed.trim() !== "") (out as Record<CopyKey, string | null>)[k] = typed ?? null;
  }
  return out;
}

// ── REQUEST BODIES ───────────────────────────────────────────────────────────────────────────────
// Everything the campaign would hold, as the backend's field names.
export function fullBody(f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  const m = pickedMatch(f, matches);
  const copy = copyOf(f, matches, cities);
  return {
    name: f.name.trim(), dealType: f.dealType, dealAmount: f.dealType === "FREE_MATCH" ? 0 : f.dealAmount,
    usesPerPlayer: m ? 1 : f.usesPerPlayer,
    cityIds: f.cityIds, lastPlayed: f.lastPlayed, lastPlayedDays: f.lastPlayed === "LAPSED" ? f.lastPlayedDays : null,
    minMatches: f.minMatches, maxMatches: f.maxMatches, membership: f.membership,
    playedAtMatchField: m ? f.playedAtMatchField : false, matchIds: m ? [m.id] : [],
    startsLocal: f.startsLocal, endsLocal: f.endsLocal, holdoutPercent: f.holdoutPercent, maxRedemptions: f.maxRedemptions,
    ...copy, buttonTarget: m ? "MATCH" : "FIND_MATCH", buttonMatchId: m ? m.id : null,
  };
}

// CREATE: the full body with nulls left out (the backend's defaults stand in for them).
export function createBody(f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fullBody(f, matches, cities)).filter(([, v]) => v !== null));
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
    if (!same(v, (c as unknown as Record<string, unknown>)[k])) out[k] = v;
  }
  return out;
}

// The live count's body: who gets it and the deal, never the copy.
export function audienceBody(f: Form, matches: MatchOpt[], cities: City[]): Record<string, unknown> {
  const full = fullBody(f, matches, cities);
  const keys = ["cityIds", "lastPlayed", "lastPlayedDays", "minMatches", "maxMatches", "membership", "playedAtMatchField", "matchIds", "dealType", "dealAmount", "usesPerPlayer", "maxRedemptions", "holdoutPercent"];
  return Object.fromEntries(keys.filter((k) => full[k] !== null && full[k] !== undefined).map((k) => [k, full[k]]));
}

// What stops a launch or a save, in plain words. Null: nothing.
export function formProblem(f: Form, matches: MatchOpt[]): string | null {
  if (!f.name.trim()) return "Give the offer a name.";
  if (f.scope === "MATCH" && !pickedMatch(f, matches)) return "Pick the match.";
  if (!Number.isFinite(wallMs(f.startsLocal)) || !Number.isFinite(wallMs(f.endsLocal))) return "Set when it starts and ends.";
  if (wallMs(f.endsLocal) <= wallMs(f.startsLocal)) return "It has to end after it starts.";
  if (f.maxRedemptions !== null && (!Number.isInteger(f.maxRedemptions) || f.maxRedemptions < 1)) return "The use cap must be 1 or more, or empty for no cap.";
  return null;
}

// ── THE SUMMARY ──────────────────────────────────────────────────────────────────────────────────
export type Count = { count: number; heldBack: number; players: number; mostItCanCost: number | null };

// When the backend cannot know the discount per use (% off, set price or free on any match), the most
// it can cost is worked out at the highest normal price now listed in those cities, and says so.
export function costCeiling(f: Form, count: Count, matches: MatchOpt[]): { cents: number; basis: string | null } | null {
  if (count.mostItCanCost !== null) return { cents: count.mostItCanCost, basis: null };
  const pool = matches.filter((m) => m.upcoming && (f.cityIds.length === 0 || (m.cityId !== null && f.cityIds.includes(m.cityId))));
  if (pool.length === 0) return null;
  const top = Math.max(...pool.map((m) => m.price));
  let uses = count.players * f.usesPerPlayer;
  if (f.maxRedemptions) uses = Math.min(uses, f.maxRedemptions);
  return { cents: discountOn(top, f.dealType, f.dealAmount) * uses, basis: `at today's top price of ${money(top)}` };
}

export function summary(f: Form, count: Count | null, matches: MatchOpt[], cities: City[], nowWall: string): string {
  if (!count) return "Counting players…";
  const m = pickedMatch(f, matches);
  const n = m ? 1 : f.usesPerPlayer;
  const where = f.cityIds.length ? `${andList(cityNames(f.cityIds, cities))} ` : "";
  const one1 = count.players === 1;
  const who: string[] = [];
  if (f.lastPlayed === "LAPSED") who.push(`${one1 ? "hasn't" : "haven't"} played in ${f.lastPlayedDays}+ days`);
  if (f.lastPlayed === "NEVER") who.push(`${one1 ? "has" : "have"} never played`);
  if (f.membership === "MEMBERS") who.push(one1 ? "is a member" : "are members");
  if (f.membership === "NON_MEMBERS") who.push(one1 ? "isn't a member" : "aren't members");
  if (m && f.playedAtMatchField) who.push(`${one1 ? "has" : "have"} played at ${m.fieldTitle ?? "this field"}`);
  const one = n === 1 ? "one match" : `${n} matches`;
  const deal = m
    ? (f.dealType === "FREE_MATCH" ? `${m.name} free` : f.dealType === "SET_PRICE" ? `a ${money(f.dealAmount)} spot in ${m.name}` : `${dealText(f.dealType, f.dealAmount)} ${m.name}`)
    : (f.dealType === "FREE_MATCH" ? (n === 1 ? "one free match" : `${n} free matches`) : f.dealType === "SET_PRICE" ? `a ${money(f.dealAmount)} spot in ${one}` : `${dealText(f.dealType, f.dealAmount)} ${one}`);
  const until = m && f.endsLocal === m.startLocal ? "until kickoff"
    : calendarDaysBetween(nowWall, f.endsLocal) < 7 ? `until ${fmt(wallMs(f.endsLocal), { weekday: "short" })} ${fmt(wallMs(f.endsLocal), { hour: "numeric", minute: "2-digit" })}`
    : `until ${wallDate(f.endsLocal)}`;
  const people = `${count.players.toLocaleString("en-US")} ${where}${count.players === 1 ? "player" : "players"}`;
  const held = count.heldBack > 0 ? ` (${count.heldBack.toLocaleString("en-US")} more held back to measure)` : "";
  const ceiling = costCeiling(f, count, matches);
  const cost = ceiling ? `Most it can cost: ${money(ceiling.cents)}${ceiling.basis ? ` ${ceiling.basis}` : ""}.` : "Most it can cost: not known until matches are listed.";
  return `${people}${who.length ? ` who ${andList(who)}` : ""} ${one1 ? "gets" : "get"} ${deal} ${until}${held}. ${cost}`;
}

// ── THE LIST AND THE RESULTS ─────────────────────────────────────────────────────────────────────
export const STATE_LABEL: Record<CampaignState, string> = { DRAFT: "Draft", SCHEDULED: "Scheduled", LIVE: "Live", PAUSED: "Paused", ENDED: "Ended" };

export function resultsLines(c: Campaign): [string, string] {
  if (c.state === "DRAFT") return ["Not launched", ""];
  if (c.state === "SCHEDULED") return [`Starts ${wallDate(c.startsLocal)}`, ""];
  const r = c.results;
  return [`${r.saw.toLocaleString("en-US")} saw · ${r.used.toLocaleString("en-US")} used`, `${money(r.discountGiven)} off · ${r.cameBackAtFullPrice.toLocaleString("en-US")} came back`];
}

// "Day 4 of 7", "Paused · day 4 of 7", "Ended Sun, Nov 2", "Starts Mon, Nov 3".
export function progressText(c: Campaign, nowWall: string): string {
  if (c.state === "SCHEDULED") return `Starts ${wallDate(c.startsLocal)}`;
  if (c.state === "DRAFT") return "Not launched";
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
