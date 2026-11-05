/* FREE FIRST MATCH — the model behind /lifecycle/free-first-match (Ryan, 2026-11-05).
 *
 * App 1.89 (2026-11-05) gives every new player their first match free, automatically, as the internal
 * promo FIRST-MATCH-AUTO (production id 23482). This page asks one question: does that free match turn
 * into paying players at a cost we accept. Everything here is pure so the route can build the payload
 * once and the page can filter it by range and city without another request.
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
export const PAID_WINDOW_DAYS = 30;
export const MEMBER_WINDOW_DAYS = 60;

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
  paid2nd30: boolean;
  paid3rd: boolean;
  member60: boolean;
};

export type RegDay = { day: string; city: string; n: number };

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
  regs: RegDay[];
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

export type Filter = { start: string; end: string; city: string | "all" };

const inRange = (day: string, f: Filter) => day >= f.start && day <= f.end;
const inCity = (city: string, f: Filter) => f.city === "all" || city === f.city;

/** The free claimants the range and city select. The range is the day of the free match. */
export function freePeople(people: readonly Person[], f: Filter): Person[] {
  return people.filter((p) => p.group === "free" && inRange(p.anchor, f) && inCity(p.city, f));
}

/** A before group: first matches Aug 7 to Nov 4, every range; the city filter still applies. */
export function beforePeople(people: readonly Person[], group: Exclude<Group, "free">, f: Filter): Person[] {
  return people.filter((p) => p.group === group && p.anchor >= BEFORE_FROM && p.anchor <= BEFORE_TO && inCity(p.city, f));
}

export type GroupStats = {
  players: number;
  paid2nd: number;
  paid3rd: number;
  members: number;
  /** Total value of the first spots, cents (the free spots given away, for the free group). */
  spotCents: number;
  /** cents per paying player, or null when nobody has paid yet. */
  costPerPayerCents: number | null;
};

export function groupStats(ps: readonly Person[]): GroupStats {
  let paid2nd = 0, paid3rd = 0, members = 0, spotCents = 0;
  for (const p of ps) {
    if (p.paid2nd30) paid2nd++;
    if (p.paid3rd) paid3rd++;
    if (p.member60) members++;
    spotCents += p.spotCents;
  }
  return {
    players: ps.length, paid2nd, paid3rd, members, spotCents,
    costPerPayerCents: paid2nd > 0 ? spotCents / paid2nd : null,
  };
}

/** Registrations in the range, by the Chicago day they completed signup; the city filter compares the
 *  declared city against the selected match city's display name. */
export function registrations(regs: readonly RegDay[], f: Filter, cityName: (code: string) => string): number {
  const want = f.city === "all" ? null : cityName(f.city);
  let n = 0;
  for (const r of regs) if (inRange(r.day, f) && (want == null || r.city === want)) n += r.n;
  return n;
}

export type ByCityRow = { city: string; cityName: string; claimed: number; paid2nd: number; costPerPayerCents: number | null };

export function byCity(free: readonly Person[], cityName: (code: string) => string, allCities: readonly string[]): ByCityRow[] {
  const m = new Map<string, Person[]>();
  for (const c of allCities) m.set(c, []);
  for (const p of free) (m.get(p.city) ?? m.set(p.city, []).get(p.city)!).push(p);
  return [...m.entries()]
    .map(([city, ps]) => { const s = groupStats(ps); return { city, cityName: cityName(city), claimed: s.players, paid2nd: s.paid2nd, costPerPayerCents: s.costPerPayerCents }; })
    .sort((a, b) => b.claimed - a.claimed || a.cityName.localeCompare(b.cityName));
}

export type PaidSpots = {
  matchesWithFree: number;
  soldOutWithFree: number;
  spotsLost: number;
  spotsLostCents: number;
  /** Mean of booked / capacity, or null with no matches. */
  fillWithFree: number | null;
  fillWithout: number | null;
};

export const isSoldOut = (m: Pick<MatchRow, "booked" | "cap">): boolean => m.cap != null && m.cap > 0 && m.booked >= m.cap;

/** Matches in the range and city. A match "has a free player" when one of the SELECTED free
 *  claimants is anchored on it, so the card and the KPIs describe the same people. */
export function matchesInRange(matches: readonly MatchRow[], f: Filter): MatchRow[] {
  return matches.filter((m) => inRange(m.day, f) && inCity(m.city, f));
}

export function paidSpots(ms: readonly MatchRow[], freeIds: ReadonlySet<number>): PaidSpots {
  let matchesWithFree = 0, soldOutWithFree = 0, spotsLost = 0, spotsLostCents = 0;
  const fillA: number[] = [], fillB: number[] = [];
  for (const m of ms) {
    const free = m.freePlayers.filter((p) => freeIds.has(p.id));
    const fill = m.cap != null && m.cap > 0 ? Math.min(1, m.booked / m.cap) : null;
    if (free.length > 0) {
      matchesWithFree++;
      if (fill != null) fillA.push(fill);
      if (isSoldOut(m)) { soldOutWithFree++; spotsLost += free.length; spotsLostCents += free.length * m.priceCents; }
    } else if (fill != null) fillB.push(fill);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { matchesWithFree, soldOutWithFree, spotsLost, spotsLostCents, fillWithFree: mean(fillA), fillWithout: mean(fillB) };
}

export type LogMatch = MatchRow & { soldOut: boolean };
export type LogField = { field: string; city: string; cityName: string; freePlayers: number; matches: number; paid2nd: number };

/** Matches with a selected free claimant, newest first. */
export function logMatches(ms: readonly MatchRow[], freeIds: ReadonlySet<number>): LogMatch[] {
  return ms
    .map((m) => ({ ...m, freePlayers: m.freePlayers.filter((p) => freeIds.has(p.id)), soldOut: isSoldOut(m) }))
    .filter((m) => m.freePlayers.length > 0)
    .sort((a, b) => (a.wall < b.wall ? 1 : a.wall > b.wall ? -1 : b.id - a.id));
}

/** One row per field, by free players, highest first. Paid 2nd is the share of that field's free
 *  claimants who paid again within 30 days. */
export function logFields(free: readonly Person[]): LogField[] {
  const m = new Map<string, { field: string; city: string; cityName: string; people: Person[]; matches: Set<number> }>();
  for (const p of free) {
    const k = `${p.city}|${p.field}`;
    const e = m.get(k) ?? m.set(k, { field: p.field, city: p.city, cityName: p.cityName, people: [], matches: new Set() }).get(k)!;
    e.people.push(p);
    e.matches.add(p.matchId);
  }
  return [...m.values()]
    .map((e) => ({ field: e.field, city: e.city, cityName: e.cityName, freePlayers: e.people.length, matches: e.matches.size, paid2nd: e.people.filter((p) => p.paid2nd30).length }))
    .sort((a, b) => b.freePlayers - a.freePlayers || a.field.localeCompare(b.field));
}

/** The follow-up windows, for the server. */
export const paidWindowEnd = (anchor: string): string => addDays(anchor, PAID_WINDOW_DAYS);
export const memberWindowEnd = (anchor: string): string => addDays(anchor, MEMBER_WINDOW_DAYS);
