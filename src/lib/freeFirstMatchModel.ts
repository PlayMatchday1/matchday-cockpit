/* FREE FIRST MATCH — the model behind /lifecycle/free-first-match. Redesign 2026-11-21 (Figma
 * 9TgSk4sYqq4nNoTH73wRRs frame 21615:72): "Is giving the first match away worth it?"
 *
 * The server builds a BASE from the mirror once (freeFirstMatchBuild.ts) and keeps it warm; every
 * range / city the page asks for is `summarize(base, …)`, pure, so a script can print exactly what the
 * page shows (DISCOVERY.md, "Deploy check").
 *
 * ── COUNTING RULES (Ryan, 2026-11-21; the backend analysis ffm_retention_readonly.sql) ──────────────
 * Real players only: fake / filler accounts and bookings, staff (@playmatchday.com, not a deleted
 * account's del_ tombstone), @matchday.com, ADMIN-type accounts and ZZ test names are out.
 * A PLAYED MATCH is the player's OWN spot (user_type PLAYER), paid_status PAID or FREE, not left, not
 * refunded, on a match that was not cancelled or deleted and has started. Each match's own local
 * date (start_date is LOCAL WALL CLOCK with a Z it does not mean). A first-timer's day is their first
 * played match. A 7- or 14-day rate counts a player only once the whole window has passed:
 * day + W < today. Included cities only: Warsaw, New York City and El Paso are out.
 *
 * ── PAID (Ryan, 2026-11-05) ─────────────────────────────────────────────────────────────────────
 * A follow-up counts as paid when its amount is above zero (card or credit, after any promo), OR it is
 * the player's own spot on a member-free match while they hold a membership that day.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────────────────────────────
 * "Paid back" and "Spent" are ACTUAL card dollars: total_amount (the card charge, cents, tax
 * included) of every PAID booking the player made (own spot, guests, extra spots), minus refunds,
 * wallet credit not added. The mirror carries `refunded` as a BOOLEAN, so a refunded booking counts
 * as fully refunded (the backend reads partial amounts from its refunds table; a partial refund reads
 * low here). Dollar-priced matches only: Warsaw is złoty and is never added to a dollar figure.
 *
 * ── SOLD OUT (Ryan, 2026-11-11) ─────────────────────────────────────────────────────────────────
 * Full at the field's max player spots (Field Ops, fin_venues.max_players). A field with no max set
 * falls back to full at the match's own size, and is flagged. "Lost" counts EVERY free first-timer
 * spot on a sold-out match — the automatic free match, first-match codes and referral codes (Ryan,
 * 2026-11-21) — at that match's price.
 */

import { addDays } from "./weekBuckets";

/** The day the automatic free first match went live (app 1.89). Wall-clock day. */
export const LAUNCH_DAY = "2026-11-05";
/** The sold-out baseline: the 10 weeks before launch (the backend's Aug 24 – Nov 4). */
export const BASELINE_FROM = "2026-08-24";
export const BASELINE_TO = "2026-11-04";
/** The internal code the backend books the automatic free own spot under. */
export const FIRST_MATCH_AUTO_CODE = "FIRST-MATCH-AUTO";
/** The production id, kept as a fallback should the promo mirror ever lack the row. */
export const FIRST_MATCH_AUTO_PROD_ID = 23482;
/** Cities left out of every number (Ryan, 2026-11-21). */
export const EXCLUDED_CITIES = new Set(["WAW", "NYC", "NY", "ELP"]);
/** "Turn off?" when a field sells out on this share of its matches in the range. */
export const TURN_OFF_SHARE = 0.4;
/** "↑ from X%" when the range is this many points above the baseline, on a baseline of MIN matches. */
export const UP_POINTS = 15;
export const UP_MIN_BASELINE = 5;
/** "Same as paid" when the free rate is within this many points of the paid-before rate. */
export const SAME_POINTS = 2;
/** Under this many judged players a column shows "N judged" / "too early". */
export const JUDGED_MIN = 100;
/** Regular players coming back: windows of this many days. */
export const REGULAR_DAYS = 14;

/** How the player got their first match. */
export type Group = "free" | "code" | "ref" | "paid" | "other";
export const FREE_GROUPS: ReadonlySet<Group> = new Set<Group>(["free", "code", "ref"]);

/** Per-player referral codes are "<user id>ref". Everything else new-user and 100% off is a code. */
export const isReferralCode = (code: string): boolean => /^\d+ref$/i.test(code.trim());

/* ── CLASSIFYING A BOOKING ───────────────────────────────────────────────────────────────────── */

export type BookingLite = { userType: string | null; amountCents: number; promocodeId: number | null };
export type MatchLite = { isFreeMember: boolean; day: string };
export type SubLite = { activationDay: string | null; canceledDay: string | null };

/** Did the player hold a membership on the match's day? Chicago days against the wall-clock day. */
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

/* ── SOLD OUT ────────────────────────────────────────────────────────────────────────────────── */

export type CapacityState = "sold_out" | "full_can_expand" | "sold_out_no_field_max" | null;

export function capacityState(m: { booked: number; cap: number | null; fieldMax: number | null }): CapacityState {
  if (m.fieldMax != null && m.fieldMax > 0) {
    if (m.booked >= m.fieldMax) return "sold_out";
    return m.cap != null && m.cap > 0 && m.booked >= m.cap ? "full_can_expand" : null;
  }
  return m.cap != null && m.cap > 0 && m.booked >= m.cap ? "sold_out_no_field_max" : null;
}
/** Counts as sold out: full at the field max, or, with no max set, full at its own size. */
export const isSoldOut = (m: { booked: number; cap: number | null; fieldMax: number | null }): boolean => {
  const st = capacityState(m);
  return st === "sold_out" || st === "sold_out_no_field_max";
};

/* ── THE BASE (built on the server from the mirror) ──────────────────────────────────────────── */

export type FirstTimer = {
  id: number;
  /** Wall-clock day of the first played match. */
  day: string;
  matchId: number;
  city: string;
  fieldKey: string;
  group: Group;
  /** List price of the first spot when it was free by a promo (amount 0), dollar matches; else 0. */
  spotCents: number;
  /** Days from the first match to every paid follow-up match (own spot, played), ascending. */
  paidDays: number[];
  /** Net card cents on the first match itself (own spot and any guests booked with it). */
  firstCents: number;
  /** [days from the first match, net card cents] for every charged booking on another match. */
  spend: [number, number][];
};

export type BaseMatch = {
  id: number;
  day: string;
  /** "YYYY-MM-DDTHH:MM" wall clock, for display. */
  wall: string;
  /** True UTC kickoff (startDateUtc), ms. */
  startMs: number;
  city: string;
  fieldKey: string;
  fieldName: string;
  booked: number;
  cap: number | null;
  fieldMax: number | null;
  /** List price in cents; null when not priced in dollars. */
  priceCents: number | null;
  /** firstMatchFreeEnabled from raw; null when the payload lacks it. */
  ffe: boolean | null;
};

/** A player who left their own spot before kickoff, on a live match. */
export type Leave = { matchId: number; day: string; city: string; late: boolean; firstTimer: boolean; refilled: boolean };
export type Rating = { day: string; city: string; stars: number; returning: boolean; matchId: number };
export type Play = { person: number; day: string; city: string };

export type Base = {
  generatedAt: string;
  /** Today in America/Chicago. */
  today: string;
  nowMs: number;
  mirrorSyncedAt: string | null;
  cities: { code: string; name: string }[];
  people: FirstTimer[];
  matches: BaseMatch[];
  leaves: Leave[];
  ratings: Rating[];
  plays: Play[];
};

/* ── THE VIEW (what the page draws) ──────────────────────────────────────────────────────────── */

export type Rate = { players: number; judged: number; hits: number; pct: number | null };
export type Column = {
  from: string; to: string; players: number;
  paid7: Rate; paid14: Rate;
  perPlayer7: { value: number | null; judged: number };
  spent14: { cents: number | null; judged: number };
};
export type UpcomingMatch = { id: number; wall: string; ffe: boolean | null };
export type FieldRow = {
  key: string; field: string; city: string;
  matches: number; soldOut: number; pct: number | null;
  baselineMatches: number; baselinePct: number | null; up: boolean;
  freeOnFull: number; lostCents: number; paidBackCents: number | null;
  noMax: boolean; turnOff: boolean;
  upcoming: UpcomingMatch[];
};
export type View = {
  generatedAt: string; mirrorSyncedAt: string | null; today: string;
  range: { from: string; to: string; days: number };
  before: { from: string; to: string };
  city: string | null;
  cities: { code: string; name: string }[];
  verdict: { label: "Working" | "Mixed" | "Not working" | "Too early"; tone: "good" | "warn" | "bad" | "muted"; text: string };
  newPerDay: { after: number; before: number; afterPlayers: number; beforePlayers: number; changePct: number | null };
  came7: { free: Rate; paid: Rate; code: Rate; diffPts: number | null };
  paidBack: { cents: number; spenders: number; players: number; paidMatches: number };
  lost: { cents: number; spots: number; matches: number; perWeekCents: number; noMaxMatches: number };
  refill: { leaves: number; refilled: number };
  fields: FieldRow[];
  suggestedOff: number;
  cohorts: { paid: Column; free: Column; code: Column };
  paidShift: { before: number; after: number };
  firm14: string | null;
  watch: {
    late: { before: Rate; after: Rate };
    rating: { before: number | null; after: number | null; beforeN: number; afterN: number; fullBefore: number | null; fullAfter: number | null; roomBefore: number | null; roomAfter: number | null };
    regulars: { before: Rate; after: Rate; beforeWindow: [string, string]; afterWindow: [string, string] };
  };
};

/* ── HELPERS ─────────────────────────────────────────────────────────────────────────────────── */

export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** Has the W-day window from `start` fully passed by `today`? (its last day, start + W, is before today) */
export const windowDone = (start: string, w: number, today: string): boolean => addDays(start, w) < today;
const pctOf = (hits: number, n: number): number | null => (n > 0 ? hits / n : null);
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function rateOf(ps: readonly FirstTimer[], w: number, today: string): Rate {
  let judged = 0, hits = 0;
  for (const p of ps) {
    if (!windowDone(p.day, w, today)) continue;
    judged++;
    if (p.paidDays.some((d) => d <= w)) hits++;
  }
  return { players: ps.length, judged, hits, pct: pctOf(hits, judged) };
}

export function column(ps: readonly FirstTimer[], from: string, to: string, today: string): Column {
  const j7 = ps.filter((p) => windowDone(p.day, 7, today));
  const j14 = ps.filter((p) => windowDone(p.day, 14, today));
  return {
    from, to, players: ps.length,
    paid7: rateOf(ps, 7, today), paid14: rateOf(ps, 14, today),
    perPlayer7: { value: mean(j7.map((p) => p.paidDays.filter((d) => d <= 7).length)), judged: j7.length },
    spent14: { cents: mean(j14.map((p) => p.firstCents + p.spend.reduce((a, [d, c]) => a + (d <= 14 ? c : 0), 0))), judged: j14.length },
  };
}

/** Paid back by free players through `to`: actual card dollars on matches other than the free one. */
export function paidBackOf(ps: readonly FirstTimer[], to: string): { cents: number; spenders: number; paidMatches: number } {
  let cents = 0, spenders = 0, paidMatches = 0;
  for (const p of ps) {
    const through = daysBetween(p.day, to);
    let mine = 0;
    for (const [d, c] of p.spend) if (d >= 0 && d <= through) mine += c;
    cents += mine;
    if (mine > 0) spenders++;
    paidMatches += p.paidDays.filter((d) => d <= through).length;
  }
  return { cents, spenders, paidMatches };
}

/* ── SUMMARIZE ───────────────────────────────────────────────────────────────────────────────── */

export function defaultRange(today: string): { from: string; to: string } {
  const y = addDays(today, -1);
  return { from: LAUNCH_DAY, to: y < LAUNCH_DAY ? LAUNCH_DAY : y };
}

export function summarize(base: Base, opts: { from?: string; to?: string; city?: string | null }): View {
  const today = base.today;
  const def = defaultRange(today);
  let from = opts.from && opts.from >= LAUNCH_DAY ? opts.from : def.from;
  let to = opts.to && opts.to <= def.to ? opts.to : def.to;
  if (to < from) [from, to] = [def.from, def.to];
  const days = daysBetween(from, to) + 1;
  const bTo = addDays(LAUNCH_DAY, -1), bFrom = addDays(LAUNCH_DAY, -days);
  const city = opts.city && base.cities.some((c) => c.code === opts.city) ? opts.city : null;
  const inCity = (c: string) => (city ? c === city : !EXCLUDED_CITIES.has(c));
  const inR = (d: string) => d >= from && d <= to;
  const inB = (d: string) => d >= bFrom && d <= bTo;

  const people = base.people.filter((p) => inCity(p.city));
  const after = people.filter((p) => inR(p.day));
  const before = people.filter((p) => inB(p.day));
  const g = (ps: FirstTimer[], grp: Group) => ps.filter((p) => p.group === grp);
  const freeA = g(after, "free"), paidB = g(before, "paid"), codeB = g(before, "code");

  // 1. New first-timers a day.
  const newPerDay = {
    after: after.length / days, before: before.length / days, afterPlayers: after.length, beforePlayers: before.length,
    changePct: before.length > 0 ? after.length / before.length - 1 : null,
  };

  // 2. Came back and paid in 7 days.
  const free7 = rateOf(freeA, 7, today), paid7 = rateOf(paidB, 7, today), code7 = rateOf(codeB, 7, today);
  const diffPts = free7.pct != null && paid7.pct != null ? Math.round(free7.pct * 100) - Math.round(paid7.pct * 100) : null;

  // 3. Paid back so far.
  const pb = paidBackOf(freeA, to);

  // 4. Lost on sold-out matches, and the field table.
  const matches = base.matches.filter((m) => inCity(m.city));
  const freeOn = new Map<number, FirstTimer[]>();
  for (const p of people) if (FREE_GROUPS.has(p.group) && p.spotCents >= 0) (freeOn.get(p.matchId) ?? freeOn.set(p.matchId, []).get(p.matchId)!).push(p);
  type Acc = FieldRow & { freePlayers: FirstTimer[] };
  const fields = new Map<string, Acc>();
  const acc = (m: BaseMatch): Acc => fields.get(m.fieldKey) ?? fields.set(m.fieldKey, {
    key: m.fieldKey, field: m.fieldName, city: m.city, matches: 0, soldOut: 0, pct: null, baselineMatches: 0, baselinePct: null, up: false,
    freeOnFull: 0, lostCents: 0, paidBackCents: null, noMax: false, turnOff: false, upcoming: [], freePlayers: [],
  }).get(m.fieldKey)!;
  const baseline = new Map<string, { n: number; s: number }>();
  let lostCents = 0, lostSpots = 0, lostMatches = 0, noMaxMatches = 0;
  const soldOutIds = new Set<number>();
  for (const m of matches) {
    if (m.day >= BASELINE_FROM && m.day <= BASELINE_TO && m.startMs <= base.nowMs) {
      const b = baseline.get(m.fieldKey) ?? baseline.set(m.fieldKey, { n: 0, s: 0 }).get(m.fieldKey)!;
      b.n++; if (isSoldOut(m)) b.s++;
    }
    if (inR(m.day) && m.startMs <= base.nowMs) {
      const r = acc(m);
      r.matches++;
      const free = freeOn.get(m.id) ?? [];
      r.freePlayers.push(...free.filter((p) => inR(p.day)));
      if (isSoldOut(m)) {
        r.soldOut++;
        soldOutIds.add(m.id);
        const st = capacityState(m);
        if (st === "sold_out_no_field_max") { r.noMax = true; }
        const k = free.length;
        if (k > 0) {
          const c = k * (m.priceCents ?? 0);
          r.freeOnFull += k; r.lostCents += c;
          lostSpots += k; lostCents += c; lostMatches++;
          if (st === "sold_out_no_field_max") noMaxMatches++;
        }
      }
    }
  }
  for (const m of matches) {
    if (m.startMs <= base.nowMs) continue;
    const r = fields.get(m.fieldKey);
    if (r) r.upcoming.push({ id: m.id, wall: m.wall, ffe: m.ffe });
  }
  const rows: FieldRow[] = [];
  for (const r of fields.values()) {
    r.pct = r.matches > 0 ? r.soldOut / r.matches : null;
    const b = baseline.get(r.key);
    r.baselineMatches = b?.n ?? 0;
    r.baselinePct = b && b.n > 0 ? b.s / b.n : null;
    r.up = r.pct != null && r.baselinePct != null && r.baselineMatches >= UP_MIN_BASELINE && (r.pct - r.baselinePct) * 100 >= UP_POINTS;
    r.paidBackCents = r.freePlayers.length > 0 ? paidBackOf(r.freePlayers, to).cents : null;
    const on = r.upcoming.some((u) => u.ffe !== false);
    r.turnOff = r.pct != null && r.pct >= TURN_OFF_SHARE && on;
    r.upcoming.sort((a, b) => (a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.id - b.id));
    const { freePlayers: _drop, ...row } = r;
    void _drop;
    rows.push(row);
  }
  rows.sort((a, b) => b.lostCents - a.lostCents || (b.pct ?? -1) - (a.pct ?? -1) || b.matches - a.matches || a.field.localeCompare(b.field));

  // The explainer: own spots left before kickoff on sold-out matches, and whether the seat was refilled.
  let leaves = 0, refilled = 0;
  for (const l of base.leaves) if (inR(l.day) && inCity(l.city) && soldOutIds.has(l.matchId)) { leaves++; if (l.refilled) refilled++; }

  // 6. Columns.
  const cohorts = { paid: column(paidB, bFrom, bTo, today), free: column(freeA, from, to, today), code: column(codeB, bFrom, bTo, today) };
  const paidShift = { before: paidB.length, after: g(after, "paid").length };
  let firm14: string | null = null;
  if (cohorts.free.paid14.judged < JUDGED_MIN && freeA.length >= JUDGED_MIN) {
    const days14 = freeA.map((p) => p.day).sort();
    firm14 = addDays(days14[JUDGED_MIN - 1], 15);
  }

  // 7. Watch list.
  const lateRate = (inP: (d: string) => boolean, firstTimers: number): Rate => {
    let n = 0;
    for (const l of base.leaves) if (l.late && l.firstTimer && inP(l.day) && inCity(l.city)) n++;
    return { players: firstTimers + n, judged: firstTimers + n, hits: n, pct: pctOf(n, firstTimers + n) };
  };
  const soldOutAny = new Set(matches.filter((m) => isSoldOut(m)).map((m) => m.id));
  const avgStars = (inP: (d: string) => boolean, pick: (r: Rating) => boolean) => {
    const xs = base.ratings.filter((r) => r.returning && inP(r.day) && inCity(r.city) && pick(r)).map((r) => r.stars);
    return { avg: mean(xs), n: xs.length };
  };
  const rA = avgStars(inR, () => true), rB = avgStars(inB, () => true);
  const regular = (start: string, end: string): Rate => {
    const len = daysBetween(start, end) + 1;
    const pStart = addDays(start, -len), pEnd = addDays(start, -1);
    const prior = new Set<number>(), now = new Set<number>();
    for (const p of base.plays) {
      if (!inCity(p.city)) continue;
      if (p.day >= pStart && p.day <= pEnd) prior.add(p.person);
      else if (p.day >= start && p.day <= end) now.add(p.person);
    }
    let back = 0;
    for (const id of prior) if (now.has(id)) back++;
    return { players: prior.size, judged: prior.size, hits: back, pct: pctOf(back, prior.size) };
  };
  let aStart = addDays(to, -(REGULAR_DAYS - 1));
  if (aStart < LAUNCH_DAY) aStart = LAUNCH_DAY;
  const len = daysBetween(aStart, to) + 1;
  const bStart = addDays(LAUNCH_DAY, -len);

  const watch: View["watch"] = {
    late: { before: lateRate(inB, before.length), after: lateRate(inR, after.length) },
    rating: {
      before: rB.avg, after: rA.avg, beforeN: rB.n, afterN: rA.n,
      fullBefore: avgStars(inB, (r) => soldOutAny.has(r.matchId)).avg, fullAfter: avgStars(inR, (r) => soldOutAny.has(r.matchId)).avg,
      roomBefore: avgStars(inB, (r) => !soldOutAny.has(r.matchId)).avg, roomAfter: avgStars(inR, (r) => !soldOutAny.has(r.matchId)).avg,
    },
    regulars: { before: regular(bStart, bTo), after: regular(aStart, to), beforeWindow: [bStart, bTo], afterWindow: [aStart, to] },
  };

  const suggestedOff = rows.filter((r) => r.turnOff).length;
  const lost = { cents: lostCents, spots: lostSpots, matches: lostMatches, perWeekCents: (lostCents / days) * 7, noMaxMatches };

  return {
    generatedAt: base.generatedAt, mirrorSyncedAt: base.mirrorSyncedAt, today,
    range: { from, to, days }, before: { from: bFrom, to: bTo }, city, cities: base.cities,
    verdict: verdictOf(newPerDay.changePct, free7, diffPts, lost.cents, suggestedOff),
    newPerDay, came7: { free: free7, paid: paid7, code: code7, diffPts },
    paidBack: { ...pb, players: freeA.length },
    lost, refill: { leaves, refilled }, fields: rows, suggestedOff,
    cohorts, paidShift, firm14, watch,
  };
}

/** The one-line verdict, written from the numbers. */
export function verdictOf(changePct: number | null, free7: Rate, diffPts: number | null, lostCents: number, suggestedOff: number): View["verdict"] {
  if (changePct == null || free7.judged < 30 || diffPts == null) {
    return { label: "Too early", tone: "muted", text: "Not enough free players have had 7 days yet to judge whether they come back." };
  }
  const growth = Math.round(changePct * 100);
  const more = growth > 0 ? `More new players (+${growth}% a day)` : growth < 0 ? `Fewer new players (${growth}% a day)` : "The same number of new players a day";
  const back = Math.abs(diffPts) <= SAME_POINTS ? "who come back and pay as often as paid first-timers did"
    : diffPts > 0 ? `who come back and pay more often than paid first-timers did (${diffPts} pts more)`
    : `who come back and pay less often than paid first-timers did (${-diffPts} pts less)`;
  const cost = lostCents > 0
    ? ` The cost is free spots on sold-out matches${suggestedOff > 0 ? `: turn it off on the ${suggestedOff === 1 ? "field" : `${suggestedOff} fields`} that sell out.` : "."}`
    : " No free spot has been given on a sold-out match.";
  const label = growth >= 10 && diffPts >= -SAME_POINTS ? "Working" : growth <= 0 ? "Not working" : "Mixed";
  return { label, tone: label === "Working" ? "good" : label === "Mixed" ? "warn" : "bad", text: `${more} ${back}.${cost}` };
}
