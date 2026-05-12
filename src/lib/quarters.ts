// Quarter-aware date utilities. Source-of-truth for "which quarter
// are we in" and "what months/dates does that quarter span." Designed
// to be consumed by Finance surfaces in the staged Wave 1-4 rollout:
//
//   - Wave 1 (this file): foundation only. financeStats.ts's
//     Q2_MONTHS becomes a derived value backed by
//     getCurrentQuarter().months.map(m => m.key).
//   - Waves 2-4: page-level selector + per-consumer migration.
//
// Reusable for Cities / Clubhouse later. Not wired into those today.
//
// === Conventions ===
//
// - Quarter numbering follows the calendar:
//     Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec
// - QuarterKey shape: `${year}Q${1|2|3|4}` — e.g. "2026Q2".
// - Month keys match the existing fin_revenue.month text format
//   ("Apr 2026", "May 2026", ...) for back-compat with the DB.
// - Date boundaries are local-midnight inclusive on both ends
//   (start = Apr 1 00:00, end = Jun 30 00:00). Same semantics the
//   existing Q2_MONTHS-derived helpers used.
// - EARLIEST_QUARTER caps the lower bound at 2026Q2 — Q1 2026 and
//   prior have no cockpit data and intentionally don't appear in
//   the selector.

export type Quarter = 1 | 2 | 3 | 4;
export type QuarterKey = `${number}Q${1 | 2 | 3 | 4}`;

export interface QuarterMonth {
  // "Apr 2026" — matches fin_revenue.month / fin_expenses.month text.
  key: string;
  // "Apr"
  shortName: string;
  // "APRIL" — used by monthScopedTitle for insight-card eyebrows.
  fullName: string;
  year: number;
  // 0-based JS Date month index (0 = Jan).
  monthIndex: number;
  daysInMonth: number;
}

export interface QuarterInfo {
  year: number;
  quarter: Quarter;
  // "2026Q2" — stable URL param value.
  key: QuarterKey;
  // "Q2 2026" — human-readable, used in headings and dropdowns.
  label: string;
  // First day of quarter, local midnight.
  start: Date;
  // Last day of quarter, local midnight (inclusive).
  end: Date;
  // Exactly 3 months in chronological order.
  months: [QuarterMonth, QuarterMonth, QuarterMonth];
}

// Lower bound on what the selector exposes. Q1 2026 and earlier have
// no cockpit data; we don't surface them.
export const EARLIEST_QUARTER: { year: number; quarter: Quarter } = {
  year: 2026,
  quarter: 2,
};

const SHORT_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const FULL_MONTH_NAMES = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
];

// Returns the number of days in (year, monthIndex). Handles leap years
// via Date(year, monthIndex + 1, 0) which is the last day of monthIndex.
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function buildQuarterMonth(year: number, monthIndex: number): QuarterMonth {
  return {
    key: `${SHORT_MONTH_NAMES[monthIndex]} ${year}`,
    shortName: SHORT_MONTH_NAMES[monthIndex],
    fullName: FULL_MONTH_NAMES[monthIndex],
    year,
    monthIndex,
    daysInMonth: daysInMonth(year, monthIndex),
  };
}

// (year, quarter) → first/last day, local-midnight. Pure date math.
export function getQuarterDateRange(
  year: number,
  quarter: Quarter,
): { start: Date; end: Date } {
  const firstMonth = (quarter - 1) * 3; // Q1→0, Q2→3, Q3→6, Q4→9
  const lastMonth = firstMonth + 2;
  return {
    start: new Date(year, firstMonth, 1),
    end: new Date(year, lastMonth, daysInMonth(year, lastMonth)),
  };
}

function buildQuarterInfo(year: number, quarter: Quarter): QuarterInfo {
  const firstMonth = (quarter - 1) * 3;
  const months: [QuarterMonth, QuarterMonth, QuarterMonth] = [
    buildQuarterMonth(year, firstMonth),
    buildQuarterMonth(year, firstMonth + 1),
    buildQuarterMonth(year, firstMonth + 2),
  ];
  const { start, end } = getQuarterDateRange(year, quarter);
  return {
    year,
    quarter,
    key: `${year}Q${quarter}` as QuarterKey,
    label: `Q${quarter} ${year}`,
    start,
    end,
    months,
  };
}

// Today's quarter — first quarter that contains `now`.
export function getCurrentQuarter(now: Date = new Date()): QuarterInfo {
  const year = now.getFullYear();
  const quarter = (Math.floor(now.getMonth() / 3) + 1) as Quarter;
  return buildQuarterInfo(year, quarter);
}

// Parse "2026Q2" / "2027q3" → QuarterInfo. Returns null for malformed
// input or quarters before EARLIEST_QUARTER. Future quarters that
// haven't started yet ARE returned — UI is responsible for hiding
// them (getAvailableQuarters does the hiding).
export function getQuarterByKey(key: string): QuarterInfo | null {
  const m = key.trim().match(/^(\d{4})Q([1-4])$/i);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const quarter = parseInt(m[2], 10) as Quarter;
  if (
    year < EARLIEST_QUARTER.year ||
    (year === EARLIEST_QUARTER.year && quarter < EARLIEST_QUARTER.quarter)
  ) {
    return null;
  }
  return buildQuarterInfo(year, quarter);
}

// Quarter list for the selector: EARLIEST_QUARTER → current, newest
// first. Future quarters that haven't started yet are excluded.
export function getAvailableQuarters(now: Date = new Date()): QuarterInfo[] {
  const current = getCurrentQuarter(now);
  const out: QuarterInfo[] = [];
  let year = EARLIEST_QUARTER.year;
  let quarter: Quarter = EARLIEST_QUARTER.quarter;
  while (true) {
    out.push(buildQuarterInfo(year, quarter));
    if (year === current.year && quarter === current.quarter) break;
    if (quarter === 4) {
      year += 1;
      quarter = 1;
    } else {
      quarter = (quarter + 1) as Quarter;
    }
    // Safety bound — prevents infinite loop if `now` is somehow
    // before EARLIEST_QUARTER (returns empty in that case).
    if (year > current.year + 1) {
      return [];
    }
  }
  return out.reverse();
}

// Predicates against a QuarterMonth.
export function isCurrentMonth(
  month: QuarterMonth,
  now: Date = new Date(),
): boolean {
  return (
    month.year === now.getFullYear() && month.monthIndex === now.getMonth()
  );
}

export function isFutureMonth(
  month: QuarterMonth,
  now: Date = new Date(),
): boolean {
  const monthStart = new Date(month.year, month.monthIndex, 1);
  const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return monthStart.getTime() > todayMonthStart.getTime();
}

export function isCurrentQuarter(
  q: QuarterInfo,
  now: Date = new Date(),
): boolean {
  const cur = getCurrentQuarter(now);
  return q.year === cur.year && q.quarter === cur.quarter;
}
