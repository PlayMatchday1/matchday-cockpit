// THE FINANCE PERIOD — one control, three grains, read by every section.
//
// WHAT IT REPLACED. Two controls doing one job: a QUARTER dropdown in the page frame, and a MONTH
// segment inside the City P&L card that could only ever offer that quarter's three months. Asking
// for August meant first knowing August is in Q3. Here the grain and the step are the same
// control, so August is one click from July and one grain-change from Q3 2026.
//
// CHANGING GRAIN ZOOMS, IT DOES NOT JUMP. The anchor is a point in time, not an index: August 2026
// widens to Q3 2026 and then to 2026, and narrowing comes back to August. That is why `anchor` is
// a Date and every constructor takes one.
//
// THE CURRENT PERIOD IS ALWAYS PARTIAL, and each grain states its OWN denominator — 17 of 31 for
// August, 48 of 92 for Q3, 229 of 365 for 2026. Borrowing one figure across grains would be worse
// than showing none, because it would look precise.
//
// ── ON "now" ───────────────────────────────────────────────────────────────────────────────────
// THERE IS NO SERVER-SIDE DATE ON THIS PATH. Finance reads Supabase directly from the browser;
// there is no /api/finance, and every section computes its own `new Date()` (CityPnlTable,
// CostSection, RevenueSection, venueRealizedCostFor, isCurrentMonth …). So `now` is threaded in
// from ONE place — the provider — and passed to both the chip and the sections. That is what makes
// the chip agree with the numbers beside it. Introducing a server clock here would make it
// DISAGREE with the realized-cost maths, which is the opposite of what the chip is for.
//
// Dates here are local-midnight civil dates. That is the right frame: a period is a calendar
// object, not an instant, and the match wall-clock trap (start_date wearing a Z) lives at the
// mdapi read boundary, which this file never touches.

import {
  EARLIEST_QUARTER,
  getQuarterByKey,
  type QuarterInfo,
} from "./quarters";
import type { Q2Month } from "./financeStats";

export type Grain = "month" | "quarter" | "year";

export const GRAINS: readonly Grain[] = ["month", "quarter", "year"];
export const GRAIN_LABEL: Record<Grain, string> = {
  month: "Month",
  quarter: "Quarter",
  year: "Year",
};
// The jump-back button names the grain it returns to, so the button says what it will do.
export const THIS_LABEL: Record<Grain, string> = {
  month: "This month",
  quarter: "This quarter",
  year: "This year",
};

const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY = 86400_000;
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const monthKey = (y: number, mi: number): Q2Month => `${MONTH_SHORT[mi]} ${y}`;

// The first month the finance record can serve. Below EARLIEST_QUARTER there is no quarter to
// fetch AND financeStats' MONTH_BY_KEY is unseeded, so venuePartnerRevenueFor returns 0 — a
// silent zero rather than an absence. Months below this are OMITTED and counted, never drawn.
const FLOOR_YEAR = EARLIEST_QUARTER.year;
const FLOOR_MONTH_INDEX = (EARLIEST_QUARTER.quarter - 1) * 3;
export const RECORD_STARTS = `${MONTH_FULL[FLOOR_MONTH_INDEX]} ${FLOOR_YEAR}`;
const belowFloor = (y: number, mi: number) =>
  y < FLOOR_YEAR || (y === FLOOR_YEAR && mi < FLOOR_MONTH_INDEX);

export type FinancePeriod = {
  grain: Grain;
  // THE POINT IN TIME THE OPERATOR PICKED, carried across grain changes so zooming is reversible.
  // Deriving grain changes from `start` instead loses it: August widens to 2026 whose start is
  // 1 January, and narrowing again lands on January rather than back on August.
  anchor: Date;
  key: string;   // "2026-08" | "2026Q3" | "2026" — the URL value
  label: string; // "August 2026" | "Q3 2026" | "2026"
  start: Date;   // local midnight, first day of the period
  end: Date;     // local midnight, last day of the period (inclusive)
  // The month keys this period spans, in order, EXCLUDING any below the record floor.
  months: Q2Month[];
  // How many calendar months were dropped by that floor. Non-zero means the label says more than
  // the data covers, and the bar says so out loud.
  monthsOmitted: number;
  isCurrent: boolean;  // contains `now` — shows the PARTIAL chip
  // Entirely ahead of today. Reachable only by URL (the forward arrow is dead on the current
  // period), but it must not read as CLOSED: absence of a chip is this design's signal that a
  // number is final, and a period that has not started is the opposite of final.
  isFuture: boolean;
  elapsedDays: number; // inclusive of today
  totalDays: number;
  // The quarters that must be fetched to cover this period. One for a month or a quarter, up to
  // four for a year. Below-floor quarters are absent, which is what monthsOmitted reports.
  quarters: QuarterInfo[];
};

function quartersCovering(start: Date, end: Date): QuarterInfo[] {
  const out: QuarterInfo[] = [];
  const seen = new Set<string>();
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const key = `${cur.getFullYear()}Q${Math.floor(cur.getMonth() / 3) + 1}`;
    if (!seen.has(key)) {
      seen.add(key);
      const q = getQuarterByKey(key);
      if (q) out.push(q);
    }
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function build(grain: Grain, anchor: Date, start: Date, end: Date, label: string, key: string, now: Date): FinancePeriod {
  const months: Q2Month[] = [];
  let monthsOmitted = 0;
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    if (belowFloor(cur.getFullYear(), cur.getMonth())) monthsOmitted += 1;
    else months.push(monthKey(cur.getFullYear(), cur.getMonth()));
    cur.setMonth(cur.getMonth() + 1);
  }
  const today = midnight(now);
  const isCurrent = today >= start && today <= end;
  const totalDays = Math.round((end.getTime() - start.getTime()) / DAY) + 1;
  // Elapsed is INCLUSIVE of today, which is what "17 of 31 days" means on the 17th. A closed
  // period has elapsed === total; a future one, 0.
  const elapsedDays = isCurrent
    ? Math.round((today.getTime() - start.getTime()) / DAY) + 1
    : today > end ? totalDays : 0;
  return { grain, anchor, key, label, start, end, months, monthsOmitted, isCurrent,
    isFuture: today < start, elapsedDays, totalDays, quarters: quartersCovering(start, end) };
}

export function periodFor(grain: Grain, anchor: Date, now: Date): FinancePeriod {
  const y = anchor.getFullYear();
  const mi = anchor.getMonth();
  if (grain === "month") {
    const start = new Date(y, mi, 1);
    const end = new Date(y, mi + 1, 0);
    return build("month", anchor, start, end, `${MONTH_FULL[mi]} ${y}`, `${y}-${String(mi + 1).padStart(2, "0")}`, now);
  }
  if (grain === "quarter") {
    const q = Math.floor(mi / 3);
    const start = new Date(y, q * 3, 1);
    const end = new Date(y, q * 3 + 3, 0);
    return build("quarter", anchor, start, end, `Q${q + 1} ${y}`, `${y}Q${q + 1}`, now);
  }
  const start = new Date(y, 0, 1);
  const end = new Date(y, 12, 0);
  return build("year", anchor, start, end, String(y), String(y), now);
}

export const currentPeriod = (grain: Grain, now: Date) => periodFor(grain, now, now);

// STEP one period of the CURRENT grain. Anchoring on start/end (not on start ± 1 month) keeps
// month arithmetic off the 31st, where "one month back" from the 31st lands on the 3rd.
export function stepPeriod(p: FinancePeriod, dir: -1 | 1, now: Date): FinancePeriod {
  const s = p.start;
  const anchor =
    p.grain === "month" ? new Date(s.getFullYear(), s.getMonth() + dir, 1)
    : p.grain === "quarter" ? new Date(s.getFullYear(), s.getMonth() + 3 * dir, 1)
    : new Date(s.getFullYear() + dir, 0, 1);
  return periodFor(p.grain, anchor, now);
}

// CHANGING GRAIN KEEPS THE POINT IN TIME. It reuses the CARRIED anchor, not the period's start,
// so August 2026 widens to Q3 2026 and to 2026 and narrows back to August — a zoom, not a jump.
export const changeGrain = (p: FinancePeriod, grain: Grain, now: Date) => periodFor(grain, p.anchor, now);

// FORWARD IS NOT CAPPED. Future periods have to be reachable — expenses and cash-flow projections
// are entered ahead of time, and that is what the old quarter dropdown's planning entry was for.
//
// THE MODEL DOES NOT END GOING FORWARD: getQuarterByKey accepts any year at or above the floor, so
// there is no boundary to stop at and inventing one would only take the entry surface away again.
// An empty future period is not ambiguous — it carries the grey "Not started" chip, which is
// exactly what distinguishes it from a closed period whose numbers are final.
//
// `now` is kept in the signature: the cap belongs to the period model, and a future limit added
// later belongs here rather than in the bar.
export const canStepForward = (_p: FinancePeriod, _now: Date) => true;
// BACK STOPS AT THE RECORD. Stepping below it would render a period of structural zeroes.
export const canStepBack = (p: FinancePeriod) => {
  const prevEnd = new Date(p.start.getTime() - DAY);
  return !belowFloor(prevEnd.getFullYear(), prevEnd.getMonth());
};

// ── URL ────────────────────────────────────────────────────────────────────────────────────────
// "2026-08" | "2026Q3" | "2026". Unparseable or below-floor values fall back to the default rather
// than rendering an empty period.
export function periodFromUrl(raw: string | null, now: Date): FinancePeriod {
  const s = (raw ?? "").trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
    const y = +m[1], mi = +m[2] - 1;
    if (mi >= 0 && mi <= 11 && !belowFloor(y, mi)) return periodFor("month", new Date(y, mi, 1), now);
  } else if ((m = s.match(/^(\d{4})Q([1-4])$/i))) {
    const y = +m[1], q = +m[2] - 1;
    if (!belowFloor(y, q * 3 + 2)) return periodFor("quarter", new Date(y, q * 3, 1), now);
  } else if ((m = s.match(/^(\d{4})$/))) {
    const y = +m[1];
    if (!belowFloor(y, 11)) return periodFor("year", new Date(y, 0, 1), now);
  }
  // THE DEFAULT IS THE CURRENT MONTH — the question being asked nine times out of ten.
  return currentPeriod("month", now);
}

// The QuarterInfo the legacy consumers still need. Fifteen components read useFinanceQuarter()
// and expect exactly three months; they keep getting the quarter CONTAINING the period, so they
// behave as they did rather than receiving a shape they cannot render.
export function containingQuarter(p: FinancePeriod): QuarterInfo {
  return p.quarters[0] ?? getQuarterByKey(`${p.start.getFullYear()}Q${Math.floor(p.start.getMonth() / 3) + 1}`)
    ?? getQuarterByKey(`${FLOOR_YEAR}Q${EARLIEST_QUARTER.quarter}`)!;
}

// ── A COMPARISON SPAN ───────────────────────────────────────────────────────────────────────────
//
// Revenue plots the selected period plus the prior three AT THE SAME GRAIN. Rather than mount a
// loader per period, the four are collapsed into one synthetic period covering the whole span, so
// the fetch is a single set of quarters and every bar is sliced out of the same data.
//
// THE FETCH IS CAPPED AT FOUR QUARTERS — the widest useFinancePeriodData can mount, since hooks
// cannot be called conditionally. Four months or four quarters fit; four YEARS do not, so the
// oldest periods are dropped until the span fits and `dropped` reports how many. A silently
// shortened chart would read as "this is all there was".
export function comparisonSpan(p: FinancePeriod, count: number, now: Date): {
  periods: FinancePeriod[];
  span: FinancePeriod;
  dropped: number;
} {
  let periods: FinancePeriod[] = [];
  let cur = p;
  for (let i = 0; i < count; i++) {
    periods.unshift(cur);
    if (!canStepBack(cur)) break;
    cur = stepPeriod(cur, -1, now);
  }
  let dropped = 0;
  let span = spanOf(periods, p, now);
  while (periods.length > 1 && span.quarters.length > 4) {
    periods = periods.slice(1);
    dropped += 1;
    span = spanOf(periods, p, now);
  }
  return { periods, span, dropped };
}

function spanOf(periods: FinancePeriod[], anchorPeriod: FinancePeriod, now: Date): FinancePeriod {
  const start = periods[0].start;
  const end = periods[periods.length - 1].end;
  return build(anchorPeriod.grain, anchorPeriod.anchor, start, end,
    `${periods[0].label} – ${periods[periods.length - 1].label}`, anchorPeriod.key, now);
}

// ── MATCH-ROW RANGES ───────────────────────────────────────────────────────────────────────────
// The from/to bounds a component passes to useMatchRangeData. Dates are LOCAL calendar dates,
// which is the right frame: mdapi_matches.start_date is local wall clock, and the fetch filters on
// it as a YYYY-MM-DD bound.
//
// PADDED BY TWO DAYS on each side. The consumers bucket rows by matchStart's own month, so a pad
// can only add rows they will ignore — whereas being one day short at a boundary silently drops a
// match from the month it belongs to.
export const ymdLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const PAD_DAYS = 2;
export function matchRange(start: Date, end: Date): { fromDate: string; toDate: string } {
  const a = new Date(start); a.setDate(a.getDate() - PAD_DAYS);
  const b = new Date(end); b.setDate(b.getDate() + PAD_DAYS);
  return { fromDate: ymdLocal(a), toDate: ymdLocal(b) };
}


/* ── PACE TO MONTH END ───────────────────────────────────────────────────────────────────────
 * TWO KINDS OF DAY ARE KEPT OUT OF THE RATE, and neither is kept out of revenue-so-far:
 *
 *   DAY 1 — membership bills at the start of the month. Measured across May-Aug 2026 it runs
 *   5.8×-7.8× the median day, every month. Days 2 and 3 run 1.0×-1.5×, indistinguishable from
 *   day 4, which is why the window is ONE day and not three: excluding them discarded two normal
 *   days. The window is a parameter so the measurement can move it again.
 *
 *   TODAY — it is in progress. On 20 Aug the day stood at $585 against a $2,838 median, and a
 *   part-day inside the rate drags every projection down for the whole day. Only applies to the
 *   month in progress; a closed month has no current day.
 *
 *     rate       = (soFar − day 1 − today) ÷ (elapsed − 2)
 *     projection = soFar + remaining × rate
 *
 * REVENUE ALREADY COLLECTED GOES IN AT FACE VALUE — day 1 and today included. It is money that
 * arrived. And days remaining stays month length minus elapsed: excluding today from the RATE
 * does not put it back on the calendar.
 *
 * Pure, and here rather than inline in the card, so the edges can be asserted directly — days 1
 * and 2 have no window at all, and the last day of a month must project to EXACTLY what has been
 * collected rather than that plus one more day.
 */
export type MonthEndPace =
  | { ok: false; reason: "not-enough-days"; remaining: number }
  | { ok: true; rate: number; rateDays: number; remaining: number; projection: number; todayExcluded: boolean };

export function projectMonthEnd(input: {
  soFar: number;
  /** Revenue on days 1..excludedDays. */
  excludedRevenue: number;
  /** Revenue on the current calendar day. Ignored unless isCurrentMonth. */
  currentDayRevenue?: number;
  daysElapsed: number;
  daysInMonth: number;
  excludedDays: number;
  isCurrentMonth?: boolean;
}): MonthEndPace {
  const {
    soFar, excludedRevenue, currentDayRevenue = 0,
    daysElapsed, daysInMonth, excludedDays, isCurrentMonth = false,
  } = input;
  const remaining = Math.max(0, daysInMonth - daysElapsed);
  // ONLY SUBTRACT TODAY IF IT IS NOT ALREADY IN THE EXCLUDED WINDOW. On day 1 of a month "today"
  // and "day 1" are the same day, and subtracting it twice would be a silent double-count.
  const todayExcluded = isCurrentMonth && daysElapsed > excludedDays;
  const rateDays = daysElapsed - excludedDays - (todayExcluded ? 1 : 0);
  // No days left in the window: there is no rate. A projection off zero days is not a rougher
  // estimate, it is not an estimate — the card shows a dash.
  if (rateDays < 1) return { ok: false, reason: "not-enough-days", remaining };
  const rate = (soFar - excludedRevenue - (todayExcluded ? currentDayRevenue : 0)) / rateDays;
  // remaining === 0 makes this exactly soFar, which is what the last day of a month and a closed
  // month must both produce — to the cent, not to the nearest rounding.
  return { ok: true, rate, rateDays, remaining, projection: soFar + remaining * rate, todayExcluded };
}
