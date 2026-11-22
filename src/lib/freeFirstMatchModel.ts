/* FREE FIRST MATCH — the model behind /lifecycle/free-first-match. Simple v2 (Ryan, Figma
 * 9TgSk4sYqq4nNoTH73wRRs frames 21624:72 and 21630:84, 2026-11-22): three tiles, one field table with the Free
 * Match switch, the free-vs-paid comparison, and an info box on each that shows the numbers behind it and the
 * list they come from. The calculations are the 2026-11-21 redesign's, unchanged.
 *
 * The server builds a BASE from the mirror once (freeFirstMatchBuild.ts) and keeps it warm; every range / city
 * the page asks for is `summarize(base, …)` and every list behind an info box is `listFor(base, …)`. Both read
 * the SAME selection (`select`), so a box and its list always add up to the number on the page; the suite
 * scripts/ffm-soldout-test.ts asserts it.
 *
 * ── COUNTING RULES (Ryan, 2026-11-21; the backend analysis ffm_retention_readonly.sql) ──────────────
 * Real players only: fake / filler accounts and bookings, staff (@playmatchday.com, not a deleted account's
 * del_ tombstone), @matchday.com and ZZ test names are out (ADMIN-type accounts cannot be seen in the mirror).
 * A PLAYED MATCH is the player's OWN spot (user_type PLAYER), paid_status PAID or FREE, not left, not refunded,
 * on a match that was not cancelled or deleted and has started. Each match's own local date (start_date is
 * LOCAL WALL CLOCK with a Z it does not mean). A first-timer's day is their first played match. A W-day rate
 * counts a player only once the whole window has passed: day + W < today. Included cities only: Warsaw, New
 * York City and El Paso are out.
 *
 * ── PAID (Ryan, 2026-11-05) ─────────────────────────────────────────────────────────────────────
 * A follow-up counts as paid when its amount is above zero (card or credit, after any promo), OR it is the
 * player's own spot on a member-free match while they hold a membership that day.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────────────────────────────
 * "Paid back" and "Spent" are ACTUAL card dollars: total_amount (the card charge, cents, tax included) of every
 * PAID booking the player made (own spot, guests, extra spots) on a started dollar match, minus refunds, wallet
 * credit not added. The mirror carries `refunded` as a BOOLEAN, so a refunded booking counts as fully refunded.
 * Warsaw is złoty and is never added to a dollar figure.
 *
 * ── SOLD OUT (Ryan, 2026-11-11) ─────────────────────────────────────────────────────────────────
 * Full at the field's max player spots (Field Ops, fin_venues.max_players). A field with no max set falls back
 * to full at the match's own size, and is flagged. "Lost" counts EVERY free first-timer spot on a sold-out match
 * — the automatic free match, first-match codes and referral codes (Ryan, 2026-11-21) — at that match's price.
 *
 * ── BETTER, WORSE OR THE SAME (Ryan, 2026-11-21) ────────────────────────────────────────────────
 * Free players are called better or worse than paid only when the two 95% ranges (Wilson) do not overlap;
 * otherwise "same as paid". Under 30 free players with the full window the tile reads "too early" (Ryan,
 * 2026-11-22); the comparison columns tag "N judged" / "too early" under 100.
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
/** A field "usually sells out" (the amber dot) at this share of its matches in the range. */
export const USUALLY_SELLS_OUT = 0.4;
/** The "Come back and pay" windows; 7 is the default. */
export const WINDOWS = [7, 14, 30] as const;
export type Window = (typeof WINDOWS)[number];
/** Under this many free players with the full window, the tile reads "too early". */
export const TILE_MIN_JUDGED = 30;
/** Under this many judged players a comparison column tags "N judged" / "too early". */
export const JUDGED_MIN = 100;

/** How the player got their first match. */
export type Group = "free" | "code" | "ref" | "paid" | "other";
export const FREE_GROUPS: ReadonlySet<Group> = new Set<Group>(["free", "code", "ref"]);
export const GROUP_LABEL: Record<Group, string> = { free: "Free first match", code: "First-match code", ref: "Referral code", paid: "Paid", other: "Other (member spot, other promo, comp)" };

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
  /** [days from the first match, card cents charged, cents refunded] per charged booking on another match. */
  spend: [number, number, number][];
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

export type Base = {
  generatedAt: string;
  /** Today in America/Chicago. */
  today: string;
  nowMs: number;
  mirrorSyncedAt: string | null;
  cities: { code: string; name: string }[];
  people: FirstTimer[];
  matches: BaseMatch[];
  /** Display names of the first-timers (a deleted account reads "Deleted Account"). */
  names: Record<number, string>;
};

/* ── HELPERS ─────────────────────────────────────────────────────────────────────────────────── */

export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
/** Has the W-day window from `start` fully passed by `today`? (its last day, start + W, is before today) */
export const windowDone = (start: string, w: number, today: string): boolean => addDays(start, w) < today;
const pctOf = (hits: number, n: number): number | null => (n > 0 ? hits / n : null);

export const Z95 = 1.96;
/** Wilson's 95% score interval: stays inside 0–100% and behaves on small groups and rates near 0. */
export function wilson(hits: number, n: number): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = hits / n, z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export type Rate = { players: number; judged: number; hits: number; pct: number | null; range: { lo: number; hi: number } | null };
export type Compare = "better" | "worse" | "same";
/** Better / worse only when the 95% ranges do not overlap. null = no range on one side. */
export function compareRates(free: Rate, paid: Rate): Compare | null {
  if (!free.range || !paid.range) return null;
  if (free.range.lo > paid.range.hi) return "better";
  if (free.range.hi < paid.range.lo) return "worse";
  return "same";
}

/** Paid a 2nd match within W days? */
const paidWithin = (p: FirstTimer, w: number) => p.paidDays.some((d) => d <= w);
export function rateOf(ps: readonly FirstTimer[], w: number, today: string): Rate {
  let judged = 0, hits = 0;
  for (const p of ps) {
    if (!windowDone(p.day, w, today)) continue;
    judged++;
    if (paidWithin(p, w)) hits++;
  }
  return { players: ps.length, judged, hits, pct: pctOf(hits, judged), range: wilson(hits, judged) };
}

/** Net card cents a player spent in their first W days, the first match included. */
export const spentWithin = (p: FirstTimer, w: number): number => p.firstCents + p.spend.reduce((a, [d, c, r]) => a + (d <= w ? c - r : 0), 0);
/** A sum over the players with the full window, and how many there were. */
type Avg = { value: number | null; total: number; judged: number };
function avgOver(ps: readonly FirstTimer[], w: number, today: string, f: (p: FirstTimer) => number): Avg {
  let total = 0, judged = 0;
  for (const p of ps) if (windowDone(p.day, w, today)) { judged++; total += f(p); }
  return { value: judged > 0 ? total / judged : null, total, judged };
}

export type Column = {
  from: string; to: string; players: number;
  paid7: Rate; paid14: Rate; paid30: Rate;
  /** Paid matches per player in 7 days: total paid follow-ups within 7 days ÷ players with 7 days. */
  perPlayer7: Avg;
  /** Spent in 14 / 30 days, cents per player: total ÷ players with the window. */
  spent14: Avg; spent30: Avg;
};

export function column(ps: readonly FirstTimer[], from: string, to: string, today: string): Column {
  return {
    from, to, players: ps.length,
    paid7: rateOf(ps, 7, today), paid14: rateOf(ps, 14, today), paid30: rateOf(ps, 30, today),
    perPlayer7: avgOver(ps, 7, today, (p) => p.paidDays.filter((d) => d <= 7).length),
    spent14: avgOver(ps, 14, today, (p) => spentWithin(p, 14)),
    spent30: avgOver(ps, 30, today, (p) => spentWithin(p, 30)),
  };
}

/** One player's money on matches other than their free one, through `to`. */
export function playerPaidBack(p: FirstTimer, to: string): { charged: number; refunded: number; net: number; paidMatches: number } {
  const through = daysBetween(p.day, to);
  let charged = 0, refunded = 0;
  for (const [d, c, r] of p.spend) if (d >= 0 && d <= through) { charged += c; refunded += r; }
  return { charged, refunded, net: charged - refunded, paidMatches: p.paidDays.filter((d) => d <= through).length };
}
/** Paid back by free players through `to`: actual card dollars on matches other than the free one. */
export function paidBackOf(ps: readonly FirstTimer[], to: string): { cents: number; charged: number; refunded: number; spenders: number; paidMatches: number } {
  let charged = 0, refunded = 0, spenders = 0, paidMatches = 0;
  for (const p of ps) {
    const x = playerPaidBack(p, to);
    charged += x.charged; refunded += x.refunded; paidMatches += x.paidMatches;
    if (x.net > 0) spenders++;
  }
  return { cents: charged - refunded, charged, refunded, spenders, paidMatches };
}

/* ── THE SELECTION: what every number and every list reads ───────────────────────────────────── */

export function defaultRange(today: string): { from: string; to: string } {
  const y = addDays(today, -1);
  return { from: LAUNCH_DAY, to: y < LAUNCH_DAY ? LAUNCH_DAY : y };
}

export type Opts = { from?: string; to?: string; city?: string | null };

type LostMatch = { m: BaseMatch; free: FirstTimer[]; cents: number };
type Selection = {
  today: string; from: string; to: string; days: number; bFrom: string; bTo: string; city: string | null;
  inCity: (c: string) => boolean;
  after: FirstTimer[]; before: FirstTimer[];
  freeA: FirstTimer[]; paidB: FirstTimer[]; codeB: FirstTimer[];
  /** Started matches in the range, in the city. */
  played: BaseMatch[];
  /** Sold-out matches in the range carrying at least one free first-timer spot. */
  lost: LostMatch[];
  /** Free first-timers (incl. codes) anchored on each match. */
  freeOn: Map<number, FirstTimer[]>;
  inR: (d: string) => boolean;
};

export function select(base: Base, opts: Opts): Selection {
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
  const freeOn = new Map<number, FirstTimer[]>();
  for (const p of after) if (FREE_GROUPS.has(p.group)) (freeOn.get(p.matchId) ?? freeOn.set(p.matchId, []).get(p.matchId)!).push(p);
  const played = base.matches.filter((m) => inCity(m.city) && inR(m.day) && m.startMs <= base.nowMs);
  const lost: LostMatch[] = [];
  for (const m of played) {
    if (!isSoldOut(m)) continue;
    const free = freeOn.get(m.id) ?? [];
    if (free.length > 0) lost.push({ m, free, cents: free.length * (m.priceCents ?? 0) });
  }
  return {
    today, from, to, days, bFrom, bTo, city, inCity, after, before, inR, played, lost, freeOn,
    freeA: after.filter((p) => p.group === "free"), paidB: before.filter((p) => p.group === "paid"), codeB: before.filter((p) => p.group === "code"),
  };
}

/* ── THE VIEW (what the page draws) ──────────────────────────────────────────────────────────── */

export type UpcomingMatch = { id: number; wall: string; ffe: boolean | null };
export type FieldRow = {
  key: string; field: string; city: string;
  matches: number; soldOut: number; pct: number | null;
  /** Free first-timer spots (incl. codes) on this field's sold-out matches, and their price. */
  freeOnFull: number; lostCents: number;
  /** Sells out on USUALLY_SELLS_OUT or more of its matches in the range: the amber dot. */
  usually: boolean;
  noMax: boolean;
  upcoming: UpcomingMatch[];
};
export type CameW = { w: number; free: Rate; paid: Rate; code: Rate; compare: Compare | null; diffPts: number | null; tooEarly: boolean };
export type View = {
  generatedAt: string; mirrorSyncedAt: string | null; today: string;
  range: { from: string; to: string; days: number };
  before: { from: string; to: string };
  city: string | null;
  cities: { code: string; name: string }[];
  newPlayers: { after: number; before: number; afterPerDay: number; beforePerDay: number; changePct: number | null; afterByGroup: Record<Group, number>; beforeByGroup: Record<Group, number> };
  came: Record<Window, CameW>;
  money: {
    paidBack: { cents: number; charged: number; refunded: number; spenders: number; players: number; paidMatches: number };
    lost: { cents: number; spots: number; matches: number; noMaxMatches: number; byPrice: { priceCents: number; spots: number; matches: number; cents: number }[] };
  };
  fields: FieldRow[];
  cohorts: { paid: Column; free: Column; code: Column };
};

const byGroup = (ps: readonly FirstTimer[]): Record<Group, number> => {
  const out: Record<Group, number> = { free: 0, code: 0, ref: 0, paid: 0, other: 0 };
  for (const p of ps) out[p.group]++;
  return out;
};

export function summarize(base: Base, opts: Opts): View {
  const sel = select(base, opts);
  const { today, from, to, days, bFrom, bTo, after, before, freeA, paidB, codeB } = sel;

  const came = {} as Record<Window, CameW>;
  for (const w of WINDOWS) {
    const free = rateOf(freeA, w, today), paid = rateOf(paidB, w, today), code = rateOf(codeB, w, today);
    const tooEarly = free.judged < TILE_MIN_JUDGED;
    came[w] = {
      w, free, paid, code, tooEarly,
      compare: tooEarly ? null : compareRates(free, paid),
      diffPts: free.pct != null && paid.pct != null ? Math.round(free.pct * 100) - Math.round(paid.pct * 100) : null,
    };
  }

  const pb = paidBackOf(freeA, to);
  const byPrice = new Map<number, { priceCents: number; spots: number; matches: number; cents: number }>();
  let noMaxMatches = 0;
  for (const l of sel.lost) {
    const price = l.m.priceCents ?? 0;
    const e = byPrice.get(price) ?? byPrice.set(price, { priceCents: price, spots: 0, matches: 0, cents: 0 }).get(price)!;
    e.spots += l.free.length; e.matches++; e.cents += l.cents;
    if (capacityState(l.m) === "sold_out_no_field_max") noMaxMatches++;
  }

  // The field table: every field with a started match in the range.
  const fields = new Map<string, FieldRow>();
  const lostById = new Map(sel.lost.map((l) => [l.m.id, l]));
  for (const m of sel.played) {
    const r = fields.get(m.fieldKey) ?? fields.set(m.fieldKey, {
      key: m.fieldKey, field: m.fieldName, city: m.city, matches: 0, soldOut: 0, pct: null, freeOnFull: 0, lostCents: 0, usually: false, noMax: false, upcoming: [],
    }).get(m.fieldKey)!;
    r.matches++;
    if (isSoldOut(m)) { r.soldOut++; if (capacityState(m) === "sold_out_no_field_max") r.noMax = true; }
    const l = lostById.get(m.id);
    if (l) { r.freeOnFull += l.free.length; r.lostCents += l.cents; }
  }
  for (const m of base.matches) {
    if (m.startMs <= base.nowMs || !sel.inCity(m.city)) continue;
    fields.get(m.fieldKey)?.upcoming.push({ id: m.id, wall: m.wall, ffe: m.ffe });
  }
  const rows = [...fields.values()];
  for (const r of rows) {
    r.pct = r.matches > 0 ? r.soldOut / r.matches : null;
    r.usually = r.pct != null && r.pct >= USUALLY_SELLS_OUT;
    r.upcoming.sort((a, b) => (a.wall < b.wall ? -1 : a.wall > b.wall ? 1 : a.id - b.id));
  }
  rows.sort((a, b) => b.lostCents - a.lostCents || (b.pct ?? -1) - (a.pct ?? -1) || b.matches - a.matches || a.field.localeCompare(b.field));

  return {
    generatedAt: base.generatedAt, mirrorSyncedAt: base.mirrorSyncedAt, today,
    range: { from, to, days }, before: { from: bFrom, to: bTo }, city: sel.city, cities: base.cities,
    newPlayers: {
      after: after.length, before: before.length, afterPerDay: after.length / days, beforePerDay: before.length / days,
      changePct: before.length > 0 ? after.length / before.length - 1 : null,
      afterByGroup: byGroup(after), beforeByGroup: byGroup(before),
    },
    came,
    money: {
      paidBack: { ...pb, players: freeA.length },
      lost: {
        cents: sel.lost.reduce((a, l) => a + l.cents, 0), spots: sel.lost.reduce((a, l) => a + l.free.length, 0),
        matches: sel.lost.length, noMaxMatches, byPrice: [...byPrice.values()].sort((a, b) => b.cents - a.cents || b.priceCents - a.priceCents),
      },
    },
    fields: rows,
    cohorts: { paid: column(paidB, bFrom, bTo, today), free: column(freeA, from, to, today), code: column(codeB, bFrom, bTo, today) },
  };
}

/* ── THE LISTS BEHIND THE INFO BOXES ─────────────────────────────────────────────────────────── */

export type ListKind = "new" | "came" | "paidback" | "lost" | "field" | "cohorts";
export type List = { title: string; columns: string[]; rows: (string | number)[][]; total: string };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLbl = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const whenLbl = (wall: string) => `${wall.slice(0, 10)} ${wall.slice(11, 16)}`;

/** The rows behind an info box. `arg` is the window for "came" and the field key for "field". Each list's
 *  rows are the SAME players or matches the box counts, so they add up to it (ffm-soldout-test asserts it). */
export function listFor(base: Base, opts: Opts, kind: ListKind, arg?: string): List {
  const sel = select(base, opts);
  const name = (id: number) => base.names[id] ?? `Player ${id}`;
  const fieldOf = new Map(base.matches.map((m) => [m.id, m.fieldName]));
  const cityName = (c: string) => base.cities.find((x) => x.code === c)?.name ?? c;
  switch (kind) {
    case "new": {
      const rows = [...sel.after.map((p) => ["Since launch", p] as const), ...sel.before.map((p) => ["Before", p] as const)]
        .map(([period, p]) => [period, name(p.id), p.id, p.day, cityName(p.city), fieldOf.get(p.matchId) ?? "", GROUP_LABEL[p.group]]);
      return { title: "New players: first-timers in each period", columns: ["Period", "Player", "Player id", "First match", "City", "Field", "How"], rows,
        total: `${sel.after.length} since launch (${dayLbl(sel.from)} – ${dayLbl(sel.to)}), ${sel.before.length} before (${dayLbl(sel.bFrom)} – ${dayLbl(sel.bTo)})` };
    }
    case "came": {
      const w = Number(arg) || 7;
      const groups: [string, FirstTimer[]][] = [["Free first match", sel.freeA], ["Paid first match", sel.paidB], ["First-match code", sel.codeB]];
      const rows: (string | number)[][] = [];
      for (const [g, ps] of groups) for (const p of ps) {
        if (!windowDone(p.day, w, sel.today)) continue;
        const d = p.paidDays[0];
        rows.push([g, name(p.id), p.id, p.day, paidWithin(p, w) ? "Yes" : "No", d == null ? "" : d]);
      }
      return { title: `Came back and paid within ${w} days: players who have had the ${w} days`, columns: ["Group", "Player", "Player id", "First match", `Paid 2nd within ${w} days`, "Days to 1st paid follow-up"], rows,
        total: `${rows.length} players (${rows.filter((r) => r[4] === "Yes").length} paid a 2nd match)` };
    }
    case "paidback": {
      let sum = 0;
      const rows = sel.freeA.map((p) => {
        const x = playerPaidBack(p, sel.to); sum += x.net;
        return [name(p.id), p.id, p.day, fieldOf.get(p.matchId) ?? "", x.paidMatches, usd(x.charged), usd(x.refunded), usd(x.net)];
      }).sort((a, b) => Number(String(b[7]).slice(1)) - Number(String(a[7]).slice(1)));
      return { title: `Paid back: free players' spending on other matches, through ${dayLbl(sel.to)}`, columns: ["Player", "Player id", "Free match", "Field", "Paid matches", "Charged", "Refunded", "Net"], rows,
        total: `${rows.length} free players, ${usd(sum)} net` };
    }
    case "lost": {
      const rows = sel.lost.map((l) => [whenLbl(l.m.wall), l.m.fieldName, cityName(l.m.city), l.m.booked, l.m.cap ?? "", l.m.fieldMax ?? "no max set", usd(l.m.priceCents ?? 0), l.free.length, usd(l.cents)]);
      return { title: "Lost on sold-out matches: free first-match spots, incl. codes", columns: ["Match", "Field", "City", "Booked", "Match size", "Field max", "Price", "Free spots", "Lost"], rows,
        total: `${rows.length} matches, ${sel.lost.reduce((a, l) => a + l.free.length, 0)} spots, ${usd(sel.lost.reduce((a, l) => a + l.cents, 0))}` };
    }
    case "field": {
      const ms = sel.played.filter((m) => m.fieldKey === arg);
      const rows = ms.map((m) => {
        const k = isSoldOut(m) ? (sel.freeOn.get(m.id) ?? []).length : 0;
        return [whenLbl(m.wall), m.booked, m.cap ?? "", m.fieldMax ?? "no max set", isSoldOut(m) ? "Yes" : "No", k, usd(m.priceCents ?? 0), usd(k * (m.priceCents ?? 0))];
      });
      const field = ms[0]?.fieldName ?? arg ?? "";
      return { title: `${field}: matches in the range`, columns: ["Match", "Booked", "Match size", "Field max", "Sold out", "Free spots on full", "Price", "Lost"], rows,
        total: `${ms.length} matches, ${rows.filter((r) => r[4] === "Yes").length} sold out` };
    }
    case "cohorts": {
      const yn = (p: FirstTimer, w: number) => (windowDone(p.day, w, sel.today) ? (paidWithin(p, w) ? "Yes" : "No") : "too early");
      const sp = (p: FirstTimer, w: number) => (windowDone(p.day, w, sel.today) ? usd(spentWithin(p, w)) : "too early");
      const groups: [string, FirstTimer[]][] = [["Paid first match", sel.paidB], ["Free first match", sel.freeA], ["First-match code", sel.codeB]];
      const rows: (string | number)[][] = [];
      for (const [g, ps] of groups) for (const p of ps) {
        rows.push([g, name(p.id), p.id, p.day, yn(p, 7), yn(p, 14), yn(p, 30),
          windowDone(p.day, 7, sel.today) ? p.paidDays.filter((d) => d <= 7).length : "too early", sp(p, 14), sp(p, 30)]);
      }
      return { title: "Free players vs players who paid for their first match", columns: ["Group", "Player", "Player id", "First match", "Paid 2nd · 7 days", "Paid 2nd · 14 days", "Paid 2nd · 30 days", "Paid matches · 7 days", "Spent · 14 days", "Spent · 30 days"], rows,
        total: `${sel.paidB.length} paid, ${sel.freeA.length} free, ${sel.codeB.length} code` };
    }
  }
}
