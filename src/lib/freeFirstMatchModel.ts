/* FREE FIRST MATCH — the model behind /lifecycle/free-first-match (Ryan, 2026-11-05).
 *
 * App 1.89 (2026-11-05) gives every new player their first match free, automatically, as the internal
 * promo FIRST-MATCH-AUTO (production id 23482), on iPhone and Android (backend heroku-prod a71fc05,
 * first-match-free.service.ts decide(): app >= 1.89 and platform ios or android). The page leads with
 * one question: are more new sign-ups playing their first match. Everything here is pure so the route
 * builds the payload once and the page re-reads it per window without another request.
 *
 * ── FAIR WINDOWS (Ryan, 2026-11-08) ──────────────────────────────────────────────────────────
 * Every rate uses ONE window, W = 7, 14 or 30 days, for every cohort. "Within W days" of a start day
 * means on a day <= start + W, so a player who comes back the same weekday a week later is inside a
 * 7-day window. A player counts only once the window has fully passed: start + W < today (the last
 * day of the window is yesterday or earlier). Everyone else is "too early", never a failure.
 *
 * ── WHAT A "FREE CLAIM" IS ───────────────────────────────────────────────────────────────────
 * A growth_participation row (one shared rule for who counts: migration 0208, see
 * docs/free-first-match/DISCOVERY.md §6) whose booking carries a FIRST-MATCH-AUTO promocode_id. The
 * backend writes that id onto the new player's own spot (DISCOVERY.md §1). is_first_match is NOT the
 * signal: it marks any first booking, paid or free.
 *
 * ── WHAT "PAID" IS (Ryan, 2026-11-05 answers) ───────────────────────────────────────────────
 * A booking counts as paid when its amount is above zero (card or credit, after any promo), OR it is
 * the player's own spot on a member-free match while they hold a membership at match time. Guest
 * spots, free promos and fake fills do not count. amount is CENTS after the promo and before credit
 * (creditsModel.ts); a 100%-off code leaves amount 0.
 *
 * ── THE TWO CLOCKS ───────────────────────────────────────────────────────────────────────────
 * Match days are growth_participation.match_date, the match's LOCAL WALL-CLOCK day (the view slices
 * start_date, which wears a Z it does not mean). Subscription activation_date and
 * completed_sign_up_at are TRUE UTC instants and are read as their America/Chicago day. Never swap
 * them (docs/matchday-api-facts.md, "Match startDate/endDate are LOCAL WALL CLOCK").
 */

import { addDays } from "./weekBuckets";

/** The day the automatic free first match went live (app 1.89). Wall-clock day. */
export const LAUNCH_DAY = "2026-11-05";
/** The "before" groups: first matches from Aug 7 to Nov 4, 2026. They never follow the range picker. */
export const BEFORE_FROM = "2026-08-07";
export const BEFORE_TO = "2026-11-04";
/** The internal code the backend books the free own spot under. All rows with this code count, so a
 *  version that later ended or was deleted still counts (first-match-free.service.ts). */
export const FIRST_MATCH_AUTO_CODE = "FIRST-MATCH-AUTO";
/** The production id, kept as a fallback should the promo mirror ever lack the row. */
export const FIRST_MATCH_AUTO_PROD_ID = 23482;
/** The window choices. Every rate on the page uses the selected one. */
export const WINDOWS = [7, 14, 30] as const;
export type Window = (typeof WINDOWS)[number];
/** The longest window: the server keeps follow-ups and sign-ups this far out. */
export const MAX_WINDOW = 30;
/** The activation "before" cohort is this many days of sign-ups. */
export const BEFORE_SIGNUP_DAYS = 28;

/** How the player got their first match. */
export type Group = "paid" | "code" | "ref" | "free";

export type Person = {
  id: number;
  name: string;
  group: Group;
  /** Wall-clock day of the first match (the free match for the free group). */
  anchor: string;
  matchId: number;
  /** city_identifier of the anchor match ("ATX"). */
  city: string;
  /** Display name ("Austin"). */
  cityName: string;
  /** Canonical venue name of the anchor match. */
  field: string;
  /** The anchor match's list price in cents — what the free spot was worth. */
  spotCents: number;
  /** Days from the anchor to the 1st and 2nd paid follow-up match (own spot), at most two, ascending. */
  paidOffsets: number[];
};

/** One completed sign-up: its Chicago day, and the person's first match day (wall clock), if any. */
export type Signup = { day: string; first: string | null };

export type MatchRow = {
  id: number;
  /** Wall-clock day and "YYYY-MM-DDTHH:MM" of kickoff. */
  day: string;
  wall: string;
  city: string;
  cityName: string;
  /** Canonical venue name. */
  field: string;
  booked: number;
  cap: number | null;
  priceCents: number;
  /** The match's firstMatchFreeEnabled (from mdapi_matches.raw). null when the payload lacks it. */
  ffe: boolean | null;
  freePlayers: { id: number; name: string }[];
};

export type Payload = {
  generatedAt: string;
  /** Today in America/Chicago, the default range end. */
  today: string;
  /** When the booking mirror last synced (the newest row's synced_at). */
  mirrorSyncedAt: string | null;
  autoPromoIds: number[];
  /** Direct count of standing FIRST-MATCH-AUTO bookings in the mirror, for the deploy check. */
  autoBookingsStanding: number;
  people: Person[];
  /** Completed sign-ups from LAUNCH_DAY - MAX_WINDOW - BEFORE_SIGNUP_DAYS on. A sign-up whose person
   *  had already played before signing up (a re-registration) is left out: not a new player. */
  signups: Signup[];
  /** Every live match from LAUNCH_DAY on, with the free claimants anchored on it. */
  matches: MatchRow[];
};

/* ── CLASSIFYING A BOOKING (server side) ───────────────────────────────────────────────────── */

export type BookingLite = { userType: string | null; amountCents: number; promocodeId: number | null };
export type MatchLite = { isFreeMember: boolean; day: string };
export type SubLite = { activationDay: string | null; canceledDay: string | null };

/** Did the player hold a membership on the match's day? activation and cancellation are compared as
 *  Chicago days against the match's wall-clock day. A cancellation is read as the end of the benefit
 *  on that day: the period end is not in the mirror (docs, "canceledAt is the moment they pressed
 *  cancel"), so this under-counts member spots in a cancelled member's final weeks. */
export function memberOn(subs: readonly SubLite[], day: string): boolean {
  return subs.some((s) => s.activationDay != null && s.activationDay <= day && (s.canceledDay == null || s.canceledDay >= day));
}

export function isPaidBooking(b: BookingLite, m: MatchLite, subs: readonly SubLite[]): boolean {
  if (b.userType !== "PLAYER") return false;
  if (b.amountCents > 0) return true;
  if (b.promocodeId != null) return false;
  if (!m.isFreeMember) return false;
  return memberOn(subs, m.day);
}

/** Per-player referral codes are "<user id>ref" (36ref, 87633ref). Everything else new-user and
 *  100% off is a marketing first-match code (Ryan, 2026-11-05). */
export const isReferralCode = (code: string): boolean => /^\d+ref$/i.test(code.trim());

/* ── THE PAGE'S VIEW OF THE PAYLOAD (client side) ──────────────────────────────────────────── */

const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** Has the W-day window from `start` fully passed by `today`? (its last day, start + W, is before today) */
export const windowDone = (start: string, w: number, today: string): boolean => addDays(start, w) < today;

/** Free claimants with their free match on or before today (a booked future match is not yet a claim). */
export function freePeople(people: readonly Person[], today: string): Person[] {
  return people.filter((p) => p.group === "free" && p.anchor >= LAUNCH_DAY && p.anchor <= today);
}

export function beforePeople(people: readonly Person[], group: Exclude<Group, "free">): Person[] {
  return people.filter((p) => p.group === group && p.anchor >= BEFORE_FROM && p.anchor <= BEFORE_TO);
}

export type GroupStats = {
  players: number;
  /** Players whose window has fully passed: the denominator of every rate. */
  done: number;
  tooEarly: number;
  paid2nd: number;
  paid3rd: number;
  /** Value of the first spots, all players (the free spots given away, for the free group). */
  spotCents: number;
  /** Spot value of the `done` players over those who paid a 2nd match; null when nobody has. */
  costPerPayerCents: number | null;
};

export function groupStats(ps: readonly Person[], w: number, today: string): GroupStats {
  let done = 0, paid2nd = 0, paid3rd = 0, spotCents = 0, doneCents = 0;
  for (const p of ps) {
    spotCents += p.spotCents;
    if (!windowDone(p.anchor, w, today)) continue;
    done++;
    doneCents += p.spotCents;
    if (p.paidOffsets.length >= 1 && p.paidOffsets[0] <= w) paid2nd++;
    if (p.paidOffsets.length >= 2 && p.paidOffsets[1] <= w) paid3rd++;
  }
  return { players: ps.length, done, tooEarly: ps.length - done, paid2nd, paid3rd, spotCents, costPerPayerCents: paid2nd > 0 ? doneCents / paid2nd : null };
}

/* ── ACTIVATION ─────────────────────────────────────────────────────────────────────────────── */

export type Cohort = { from: string; to: string; signups: number; done: number; tooEarly: number; played: number };

/** The two sign-up cohorts for window W.
 *  BEFORE is 28 days of sign-ups whose whole window closed before launch (to = LAUNCH_DAY - W - 1), so
 *  no one in it could have had the free match. AFTER is every sign-up from LAUNCH_DAY to today. */
export function activation(signups: readonly Signup[], w: number, today: string): { before: Cohort; after: Cohort } {
  const bTo = addDays(LAUNCH_DAY, -w - 1), bFrom = addDays(bTo, -(BEFORE_SIGNUP_DAYS - 1));
  const cohort = (from: string, to: string): Cohort => {
    let n = 0, done = 0, played = 0;
    for (const s of signups) {
      if (s.day < from || s.day > to) continue;
      n++;
      if (!windowDone(s.day, w, today)) continue;
      done++;
      if (s.first != null && s.first >= s.day && dayDiff(s.day, s.first) <= w) played++;
    }
    return { from, to, signups: n, done, tooEarly: n - done, played };
  };
  return { before: cohort(bFrom, bTo), after: cohort(LAUNCH_DAY, today) };
}

/** Sign-ups from launch to today, for the claimed card. */
export const signupsSinceLaunch = (signups: readonly Signup[], today: string): number =>
  signups.filter((s) => s.day >= LAUNCH_DAY && s.day <= today).length;

/** The first day the after cohort has anyone with a full window: launch + W + 1. */
export const firstAfterReadDay = (w: number): string => addDays(LAUNCH_DAY, w + 1);

/* ── SOLD-OUT SPOTS ─────────────────────────────────────────────────────────────────────────── */

export const isSoldOut = (m: Pick<MatchRow, "booked" | "cap">): boolean => m.cap != null && m.cap > 0 && m.booked >= m.cap;

export type FieldLoss = {
  city: string; cityName: string; field: string;
  soldOutWithFree: number; spotsLost: number; centsLost: number;
  /** The field's matches from today on, and how many have the free first match on. */
  upcoming: number; upcomingOn: number; upcomingUnknown: number;
};

/** Sold-out matches with a free claimant on them (launch to today), by field, most spots lost first.
 *  "Sold out" is the match's booked count now against its cap: a match that sold out and then lost a
 *  player reads as not sold out. */
export function soldOutByField(matches: readonly MatchRow[], free: readonly Person[], today: string): { rows: FieldLoss[]; matches: number; spots: number; cents: number } {
  const freeIds = new Set(free.map((p) => p.id));
  const by = new Map<string, FieldLoss>();
  const key = (m: MatchRow) => `${m.city}|${m.field}`;
  const row = (m: MatchRow) => by.get(key(m)) ?? by.set(key(m), { city: m.city, cityName: m.cityName, field: m.field, soldOutWithFree: 0, spotsLost: 0, centsLost: 0, upcoming: 0, upcomingOn: 0, upcomingUnknown: 0 }).get(key(m))!;
  let nm = 0, ns = 0, nc = 0;
  for (const m of matches) {
    if (m.day < LAUNCH_DAY || m.day > today || !isSoldOut(m)) continue;
    const k = m.freePlayers.filter((p) => freeIds.has(p.id)).length;
    if (k === 0) continue;
    const r = row(m);
    r.soldOutWithFree++; r.spotsLost += k; r.centsLost += k * m.priceCents;
    nm++; ns += k; nc += k * m.priceCents;
  }
  for (const m of matches) {
    if (m.day < today) continue;
    const r = by.get(key(m));
    if (!r) continue;
    r.upcoming++;
    if (m.ffe === true) r.upcomingOn++;
    else if (m.ffe == null) r.upcomingUnknown++;
  }
  const rows = [...by.values()].sort((a, b) => b.spotsLost - a.spotsLost || b.centsLost - a.centsLost || a.field.localeCompare(b.field));
  return { rows, matches: nm, spots: ns, cents: nc };
}

/* ── BY CITY AND THE FREE MATCH LOG (restored 2026-11-08, on the selected window) ──────────── */

export type ByCityRow = { city: string; cityName: string; stats: GroupStats };

/** Free claimants by the city of their free match; every running city listed, most claims first. */
export function byCity(free: readonly Person[], w: number, today: string, cityName: (code: string) => string, allCities: readonly string[]): ByCityRow[] {
  const m = new Map<string, Person[]>();
  for (const c of allCities) m.set(c, []);
  for (const p of free) (m.get(p.city) ?? m.set(p.city, []).get(p.city)!).push(p);
  return [...m.entries()]
    .map(([city, ps]) => ({ city, cityName: cityName(city), stats: groupStats(ps, w, today) }))
    .sort((a, b) => b.stats.players - a.stats.players || a.cityName.localeCompare(b.cityName));
}

export type LogMatch = MatchRow & { soldOut: boolean };
export type LogField = { field: string; city: string; cityName: string; matches: number; stats: GroupStats };

/** Matches since launch with a free claimant on them, newest first. */
export function logMatches(matches: readonly MatchRow[], free: readonly Person[], today: string): LogMatch[] {
  const ids = new Set(free.map((p) => p.id));
  return matches
    .filter((m) => m.day >= LAUNCH_DAY && m.day <= today)
    .map((m) => ({ ...m, freePlayers: m.freePlayers.filter((p) => ids.has(p.id)), soldOut: isSoldOut(m) }))
    .filter((m) => m.freePlayers.length > 0)
    .sort((a, b) => (a.wall < b.wall ? 1 : a.wall > b.wall ? -1 : b.id - a.id));
}

/** One row per field, most free players first; the paid 2nd rate is on the selected window. */
export function logFields(free: readonly Person[], w: number, today: string): LogField[] {
  const m = new Map<string, { field: string; city: string; cityName: string; people: Person[]; matches: Set<number> }>();
  for (const p of free) {
    const k = `${p.city}|${p.field}`;
    const e = m.get(k) ?? m.set(k, { field: p.field, city: p.city, cityName: p.cityName, people: [], matches: new Set() }).get(k)!;
    e.people.push(p);
    e.matches.add(p.matchId);
  }
  return [...m.values()]
    .map((e) => ({ field: e.field, city: e.city, cityName: e.cityName, matches: e.matches.size, stats: groupStats(e.people, w, today) }))
    .sort((a, b) => b.stats.players - a.stats.players || a.field.localeCompare(b.field));
}

/** Days between two wall-clock / Chicago days, for the server's follow-up offsets. */
export const daysBetween = dayDiff;
