import type { FinanceData } from "./useFinanceData";
import type { MatchRow } from "./useMatchData";
import type { JoinedMatchPlayerRow, LegacyMatchRegRow } from "./mdapiMatchesRead";
import {
  getAvailableQuarters,
  getCurrentQuarter,
  isCurrentMonth as isCurrentMonthQ,
  isFutureMonth as isFutureMonthQ,
  type QuarterInfo,
  type QuarterMonth,
} from "./quarters";

const STAFF_EMAIL_DOMAIN = "matchday.com";
import {
  canonicalVenueCost,
  fieldCostsFor,
  findOverride,
  perMatchTotalFor,
  type VenueCostInfo,
} from "./financeCosts";
import { groupVenues } from "./venueGroups";
import {
  buildFieldIdToVenueIdMap,
  normalizeMatchName,
  resolveVenueForMatch,
} from "./venueNormalization";

// Q2Month is a month-key string (e.g. "Apr 2026"). Kept as a named
// alias so the dozen helpers that take a month parameter stay
// readable. Month iteration is scoped to whichever quarter is
// active in the page context (quarter.months).
export type Q2Month = string;

export type Mode = "mtd" | "projection";

// === Wave 3a: dynamic month-keyed records ===
//
// MONTH_NUMBER / MONTH_DAYS / MONTH_FULL_NAME used to be hardcoded
// against ["Apr 2026", "May 2026", "Jun 2026"]. They're now populated
// at module load from EARLIEST_QUARTER → quarter-after-current
// (inclusive) so the dozens of internal helpers that look up
// `MONTH_NUMBER[month]` keep working when the page selector
// switches to a past quarter (records cover Q2 2026 onward) and
// when forward-looking helpers (e.g. priorMonthSameDayMtdGross
// crossing into the next quarter) need to resolve a month-after-now
// key. Module-load is fine — `now` is captured once per page
// hydration.
const MONTH_NUMBER: Record<string, number> = {};
const MONTH_DAYS: Record<string, number> = {};
const MONTH_FULL_NAME: Record<string, string> = {};
// Flat (key → QuarterMonth) lookup mirrors the three records above
// so helpers that need year-aware date math (no longer assuming
// 2026 everywhere) can find it in one shot.
const MONTH_BY_KEY: Record<string, QuarterMonth> = {};

function seedMonthRecords() {
  const quarters = getAvailableQuarters();
  // Also seed one quarter past current so prior/next-month math near
  // quarter boundaries always finds a key. EARLIEST_QUARTER bounds the
  // back end (2026Q2); we don't need older months.
  const cur = quarters[0] ?? getCurrentQuarter();
  const nextYear = cur.quarter === 4 ? cur.year + 1 : cur.year;
  const nextQ = cur.quarter === 4 ? 1 : cur.quarter + 1;
  const nextQuarter = getCurrentQuarter(
    new Date(nextYear, (nextQ - 1) * 3 + 1, 1),
  );

  const allMonths = [
    ...quarters.flatMap((q) => q.months),
    ...nextQuarter.months,
  ];
  for (const m of allMonths) {
    if (MONTH_NUMBER[m.key] !== undefined) continue; // dedupe
    MONTH_NUMBER[m.key] = m.monthIndex;
    MONTH_DAYS[m.key] = m.daysInMonth;
    MONTH_FULL_NAME[m.key] = m.fullName;
    MONTH_BY_KEY[m.key] = m;
  }
}
seedMonthRecords();

// Centralized eyebrow composer for time-scoped insight cards. Append
// the active month so a glance at the card tells the reader what
// window the numbers cover. Skip on rolling/cumulative cards (Cash
// Runway) and rolling-window cards (New Venues Profitable/Struggling
// run on a 30-90 day launch window, not the calendar month).
export function monthScopedTitle(base: string, month: Q2Month): string {
  return `${base} · ${MONTH_FULL_NAME[month] ?? ""}`;
}

function monthStartFor(month: Q2Month): Date {
  const qm = MONTH_BY_KEY[month];
  if (!qm) return new Date(NaN);
  return new Date(qm.year, qm.monthIndex, 1);
}

export function isFutureMonth(month: Q2Month, now: Date = new Date()): boolean {
  const qm = MONTH_BY_KEY[month];
  if (!qm) return false;
  return isFutureMonthQ(qm, now);
}

// Returns the month within `quarter` that contains `now`, or null
// if `now` is outside the quarter.
export function getCurrentMonthInQuarter(
  quarter: QuarterInfo,
  now: Date = new Date(),
): Q2Month | null {
  const found = quarter.months.find((m) => isCurrentMonthQ(m, now));
  return found?.key ?? null;
}

// Reads starting_cash_${quarter.key.toLowerCase()} from fin_config —
// e.g. starting_cash_2026q2 ("80000"), starting_cash_2026q3 ("0").
// Migration 0026 renamed the legacy `starting_cash_q2_2026` key to
// the new convention. Quarters with no row default to 0 + a one-time
// console.warn so the operator notices a missing seed.
const STARTING_CASH_WARNED = new Set<string>();
export function startingCash(
  data: FinanceData,
  quarter: QuarterInfo,
): number {
  const key = `starting_cash_${quarter.key.toLowerCase()}`;
  const v = data.config[key];
  if (!v) {
    if (typeof console !== "undefined" && !STARTING_CASH_WARNED.has(key)) {
      STARTING_CASH_WARNED.add(key);
      console.warn(
        `[financeStats] no fin_config row for ${key} — defaulting to $0. ` +
          `Add a row in /admin/finance once the real Q opening balance is known.`,
      );
    }
    return 0;
  }
  const parsed = parseFloat(v);
  return Number.isNaN(parsed) ? 0 : parsed;
}

// First day → last day of a quarter, as "YYYY-MM-DD" strings.
// Drives the BillingScheduleCalendar's "ALL" months range.
export function quarterDateRange(
  quarter: QuarterInfo,
): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = quarter.months[0];
  const last = quarter.months[quarter.months.length - 1];
  return {
    start: `${first.year}-${pad(first.monthIndex + 1)}-01`,
    end: `${last.year}-${pad(last.monthIndex + 1)}-${pad(last.daysInMonth)}`,
  };
}

// DPP daily extrapolation. Returns the multiplier from realized-MTD
// → projected end-of-month for the given month's daily-paid revenue.
// 1.0 for past/future months (no extrapolation); for the current
// calendar month, scales realized-through-today by (days-in-month /
// today's day-of-month) to project the full month.
function dppExtrapolationFactor(month: Q2Month, now: Date): number {
  const qm = MONTH_BY_KEY[month];
  if (!qm || !isCurrentMonthQ(qm, now)) return 1;
  const elapsed = now.getDate();
  if (elapsed <= 0) return 1;
  return qm.daysInMonth / elapsed;
}

function filterRevenueRows(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date,
) {
  const all = data.revenue.filter((r) => r.month === month);
  const future = isFutureMonth(month, now);

  if (mode === "mtd") {
    if (future) return [];
    return all.filter((r) => r.source !== "PROJECTION");
  }
  // Projection mode:
  //   - active/past months: realized rows only. The active-month PROJECTION
  //     row covers the gap between realized-to-date and end-of-month, but
  //     here we extrapolate realized DPP via dppExtrapolationFactor instead,
  //     so PROJECTION rows for active/past months would double-count.
  //   - future months: BOTH realized and PROJECTION rows. Per-type the
  //     PROJECTION sum is treated as a floor, with realized progress eating
  //     into the unrealized portion (see aggregateRevenue). This lets a
  //     manually-entered future-dated revenue row contribute to the
  //     projection total instead of being silently dropped.
  if (future) return all;
  return all.filter((r) => r.source !== "PROJECTION");
}

// Aggregate a set of revenue rows into a single number.
//
// For future months in projection mode (`isFutureProjection = true`):
//   per type, total += max(sum of PROJECTION rows, sum of non-PROJECTION rows).
//   PROJECTION acts as a floor — realized rows count toward the estimate but
//   never inflate beyond it; if realized exceeds projection, realized wins
//   (good news, the operator is outperforming the bootstrap estimate). DPP
//   extrapolation does not apply (factor is always 1 for future months).
//
// Otherwise: applies the existing DPP daily-extrapolation factor to realized
// DPP rows in the active month, leaving everything else as-is.
function aggregateRevenue<T extends { type: FinanceData["revenue"][number]["type"]; source: FinanceData["revenue"][number]["source"] }>(
  rows: T[],
  pickField: (r: T) => number,
  factor: number,
  isFutureProjection: boolean,
): number {
  if (isFutureProjection) {
    const proj = new Map<string, number>();
    const real = new Map<string, number>();
    for (const r of rows) {
      const v = pickField(r);
      const map = r.source === "PROJECTION" ? proj : real;
      map.set(r.type, (map.get(r.type) ?? 0) + v);
    }
    const types = new Set<string>([...proj.keys(), ...real.keys()]);
    let total = 0;
    for (const t of types) {
      total += Math.max(proj.get(t) ?? 0, real.get(t) ?? 0);
    }
    return total;
  }
  if (factor === 1) {
    return rows.reduce((s, r) => s + pickField(r), 0);
  }
  let total = 0;
  for (const r of rows) {
    const v = pickField(r);
    if (r.source !== "PROJECTION" && r.type === "DPP") {
      total += v * factor;
    } else {
      total += v;
    }
  }
  return total;
}

// For the current month in projection mode, lift the aggregated total
// when the operator's PROJECTION row for Membership exceeds realized
// Membership. Membership bills in bursts (subscribers have rolling
// renewal dates throughout the month), so realized accumulates over
// the first ~10 days and lags the operator's full-month estimate. The
// lib's default "realized only for current month" is correct for DPP
// (steady daily flow + extrapolation factor handles the gap) but
// understates Membership for the early portion of the month.
//
// Math: supplement = max(0, projectionMembership − realizedMembership)
//   - Early month: projection > realized → supplement lifts to projection
//   - Late month: realized has caught up or exceeded → supplement = 0
//   - No PROJECTION row → projection = 0 → supplement = 0 (no-op)
//
// Applied to net, gross, and fees symmetrically so the breakdown
// stays internally consistent.
function currentMonthMembershipSupplement(
  data: FinanceData,
  month: Q2Month,
  pickField: (r: FinanceData["revenue"][number]) => number,
  mode: Mode,
  now: Date,
): number {
  if (mode !== "projection") return 0;
  const qm = MONTH_BY_KEY[month];
  if (!qm || !isCurrentMonthQ(qm, now)) return 0;
  let realized = 0;
  let projection = 0;
  for (const r of data.revenue) {
    if (r.month !== month) continue;
    if (r.type !== "Membership") continue;
    if (r.source === "PROJECTION") projection += pickField(r);
    else realized += pickField(r);
  }
  return Math.max(0, projection - realized);
}

export function netRevenueFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  const rows = filterRevenueRows(data, month, mode, now);
  const factor =
    mode === "projection" ? dppExtrapolationFactor(month, now) : 1;
  const isFutureProjection =
    mode === "projection" && isFutureMonth(month, now);
  return (
    aggregateRevenue(rows, (r) => r.net, factor, isFutureProjection) +
    currentMonthMembershipSupplement(data, month, (r) => r.net, mode, now)
  );
}

export function grossRevenueFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  const rows = filterRevenueRows(data, month, mode, now);
  const factor =
    mode === "projection" ? dppExtrapolationFactor(month, now) : 1;
  const isFutureProjection =
    mode === "projection" && isFutureMonth(month, now);
  return (
    aggregateRevenue(rows, (r) => r.gross, factor, isFutureProjection) +
    currentMonthMembershipSupplement(data, month, (r) => r.gross, mode, now)
  );
}

export function feesFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  const rows = filterRevenueRows(data, month, mode, now);
  const factor =
    mode === "projection" ? dppExtrapolationFactor(month, now) : 1;
  const isFutureProjection =
    mode === "projection" && isFutureMonth(month, now);
  return (
    aggregateRevenue(rows, (r) => r.fees, factor, isFutureProjection) +
    currentMonthMembershipSupplement(data, month, (r) => r.fees, mode, now)
  );
}

export function netRevenueByCityFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): Map<string, number> {
  // Exclude PROJECTION rows from the per-city breakdown — they're topline
  // placeholder estimates not attributable to a single market. The company-
  // wide totals (netRevenueFor / grossRevenueFor) still pick them up via
  // filterRevenueRows for future months, so the totals row reflects them
  // even when the per-city columns are blank.
  const rows = filterRevenueRows(data, month, mode, now).filter(
    (r) => r.source !== "PROJECTION",
  );
  const factor =
    mode === "projection" ? dppExtrapolationFactor(month, now) : 1;

  const byCity = new Map<string, number>();
  for (const r of rows) {
    const isExtrap = factor !== 1 && r.type === "DPP";
    const value = isExtrap ? r.net * factor : r.net;
    byCity.set(r.city, (byCity.get(r.city) ?? 0) + value);
  }
  return byCity;
}

function filterExpenseRows(
  data: FinanceData,
  month: Q2Month,
  _mode: Mode,
  _now: Date,
) {
  // No future-month gate. fin_expenses rows are committed ledger entries
  // (recurring subscriptions, salaries, contractor invoices dated on the
  // last day of the month), not pending estimates — they should sum across
  // every Q2 month regardless of mode. Revenue gates by future-month
  // because customers haven't been billed yet; expenses don't have that
  // ambiguity.
  return data.expenses.filter((r) => r.month === month);
}

export function otherExpensesFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  return filterExpenseRows(data, month, mode, now).reduce(
    (s, r) => s + r.amount,
    0,
  );
}

export function otherExpensesByCategoryFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): Map<string, number> {
  const rows = filterExpenseRows(data, month, mode, now);
  const byCat = new Map<string, number>();
  for (const r of rows) {
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amount);
  }
  return byCat;
}

export function managerPayFor(data: FinanceData, month: Q2Month): number {
  // Source of truth is fin_expenses category='Match Manager Pay' (one row
  // per (city, Thursday) week, written by /admin/finance/manager-pay).
  // The legacy fin_manager_pay table is no longer read.
  return data.expenses
    .filter(
      (r) =>
        r.month === month && r.category === "Match Manager Pay",
    )
    .reduce((s, r) => s + r.amount, 0);
}

// Map the legacy snake_case keys (left over from the retired
// fin_monthly_expenses table) to the canonical fin_expenses.category
// strings that are now the single source of truth for these three.
const DEDICATED_LINE_CATEGORY: Record<
  "city_manager" | "marketing" | "equipment",
  string
> = {
  city_manager: "City Manager",
  marketing: "Marketing",
  equipment: "Equipment",
};

// Categories rendered as their own dedicated row on Cash Flow + handled
// outside the generic otherCatRows loop. Anything in this set must be
// excluded from generic-category aggregations to avoid double-counting.
const DEDICATED_LINE_CATEGORIES = new Set<string>([
  "Match Manager Pay",
  "City Manager",
  "Marketing",
  "Equipment",
]);

export function monthlyExpenseCategoryFor(
  data: FinanceData,
  month: Q2Month,
  key: "city_manager" | "marketing" | "equipment",
): number {
  const category = DEDICATED_LINE_CATEGORY[key];
  return data.expenses
    .filter((r) => r.month === month && r.category === category)
    .reduce((s, r) => s + r.amount, 0);
}

export function perMatchVenueCostFor(
  data: FinanceData,
  month: Q2Month,
): number {
  // Override-aware total via the shared helper. Cash Flow's per-match line,
  // hero metrics, and the Field Costs reconciliation footer all read from
  // this so they agree by construction.
  return perMatchTotalFor(data, month);
}

export function totalExpensesFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  // All venue costs flow through fieldCostsFor (one number, override-aware).
  // Match Manager Pay has its own dedicated line via managerPayFor, so it's
  // excluded here to avoid double-counting. City Manager / Marketing /
  // Equipment are now line items in fin_expenses (post 2026-05-07 migration),
  // so they're included in this generic accumulator the same way Contractors
  // / Subscriptions / Corporate Salaries are — no separate add.
  const linesNotInDedicatedTotal = filterExpenseRows(data, month, mode, now)
    .filter((r) => r.category !== "Match Manager Pay")
    .reduce((s, r) => s + r.amount, 0);
  return (
    linesNotInDedicatedTotal +
    fieldCostsFor(data, month) +
    managerPayFor(data, month)
  );
}

export function netPLFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  return (
    netRevenueFor(data, month, mode, now) -
    totalExpensesFor(data, month, mode, now)
  );
}

export function distinctExpenseCategories(
  data: FinanceData,
  quarter: QuarterInfo,
  mode: Mode,
  now: Date = new Date(),
): string[] {
  const cats = new Set<string>();
  for (const m of quarter.months) {
    for (const c of otherExpensesByCategoryFor(data, m.key, mode, now).keys()) {
      cats.add(c);
    }
  }
  // Filter out the dedicated lines (Match Manager Pay + City Manager +
  // Marketing + Equipment). Each of those gets its own row in Cash Flow
  // via a dedicated helper; including them here would double-render.
  return [...cats].filter((c) => !DEDICATED_LINE_CATEGORIES.has(c)).sort();
}

export function distinctCitiesFromRevenue(
  data: FinanceData,
  quarter: QuarterInfo,
): string[] {
  // PROJECTION rows are topline placeholders not attributable to a market;
  // they're rendered through the company-wide totals row, not as a per-city
  // line, so we ignore them when building the per-city list.
  const monthSet = new Set(quarter.months.map((m) => m.key));
  const cities = new Set<string>();
  for (const r of data.revenue) {
    if (r.source === "PROJECTION") continue;
    if (monthSet.has(r.month)) {
      cities.add(r.city);
    }
  }
  return [...cities].sort();
}

// ===== Quarter hero values (always projection mode) =====

export function quarterNetRevenueProjected(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  return quarter.months.reduce(
    (s, m) => s + netRevenueFor(data, m.key, "projection", now),
    0,
  );
}

export function quarterExpensesProjected(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  return quarter.months.reduce(
    (s, m) => s + totalExpensesFor(data, m.key, "projection", now),
    0,
  );
}

export function quarterNetPLProjected(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  return (
    quarterNetRevenueProjected(data, quarter, now) -
    quarterExpensesProjected(data, quarter, now)
  );
}


// "Closed-month actual" quarter P&L for the hero subtitle. Includes
// each month of the selected quarter that has started — past months
// at their final realized numbers, the current month at its
// full-month closed projection. Future months contribute $0.
//
// For past quarters all three months are past, so the result equals
// the realized quarter total — same number the operator sees in
// Cash Flow's per-month Net P&L row summed across months.
export function quarterNetPLActualClosedMonth(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  let total = 0;
  for (const m of quarter.months) {
    if (isFutureMonthQ(m, now)) continue;
    total +=
      netRevenueFor(data, m.key, "projection", now) -
      totalExpensesFor(data, m.key, "projection", now);
  }
  return total;
}

export function projectedEndingCash(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  return startingCash(data, quarter) + quarterNetPLProjected(data, quarter, now);
}

// ===== Month-over-month deltas (for /admin/finance/cash-flow hero) =====

export type MoMLineItem = {
  /** "expense" for fin_expenses categories + Field Costs / City Manager
   *  / Marketing / Equipment; "revenue" for DPP / Membership / etc. */
  kind: "expense" | "revenue";
  /** Category name (expenses) or type (revenue). */
  name: string;
  /** Signed delta in dollars: nextMonth − currentMonth. */
  delta: number;
  /** Human-readable driver attribution. */
  driver: string;
  /** True when the comparison's next-side value comes from a
   *  `source = 'PROJECTION'` row in fin_revenue. UI uses this to
   *  render the (i) caveat icon and visually de-emphasize the row. */
  isProjectionDriven: boolean;
  /** Per-source breakdown of how this delta is composed (city,
   *  venue, vendor, or revenue type depending on parent category).
   *  Sorted by |delta| desc. Only items with |delta| ≥ $50 surface
   *  individually; smaller items roll up into a single "Other (N
   *  sources)" entry at the end. Undefined when no breakdown source
   *  is available or when no individual source passes the threshold —
   *  UI hides the chevron in either case. */
  children?: CategoryChild[];
  /** Per-revenue-type PROJECTION amounts for the next month, sorted
   *  by amount desc. Only set on the "Expected revenue (forecast)"
   *  combined row — UI uses it to compose the (i) tooltip. */
  projectionBreakdown?: Array<{ type: string; amount: number }>;
};

export type MonthOverMonthDeltas = {
  currentMonth: Q2Month | null;
  nextMonth: Q2Month | null;
  /** All non-zero (|Δ| ≥ $0.50) line items, sorted by |delta| desc.
   *  Mixes expense and revenue items in one ranked list. UI applies
   *  any further visibility threshold (e.g. ≥ $500). */
  lineItems: MoMLineItem[];
  /** null when nextMonth is null. */
  netDelta: { current: number; next: number; delta: number } | null;
};

// Rolls up every expense category for a month, projection-mode.
// Includes fin_expenses categories (MMP, Subscriptions, Corp Salaries,
// Contractors, VEO Camera, Misc, etc.) plus the synthetic "Field
// Costs", "City Manager", "Marketing", "Equipment" categories.
function expensesByCategory(
  data: FinanceData,
  month: Q2Month,
  now: Date,
): Map<string, number> {
  const byCat = new Map<string, number>(
    otherExpensesByCategoryFor(data, month, "projection", now),
  );
  byCat.set("Field Costs", fieldCostsFor(data, month));
  byCat.set("City Manager", monthlyExpenseCategoryFor(data, month, "city_manager"));
  byCat.set("Marketing", monthlyExpenseCategoryFor(data, month, "marketing"));
  byCat.set("Equipment", monthlyExpenseCategoryFor(data, month, "equipment"));
  return byCat;
}

type RevenueTypeAggregate = {
  // Value used in totals and MoM deltas.
  effective: number;
  // Sum of PROJECTION-source rows (only > 0 for future months).
  projected: number;
  // Sum of non-PROJECTION-source rows (DPP-extrapolated for current month).
  realized: number;
  // Which side won the max() for future months. Past/current months always
  // = "realized" since PROJECTION rows are excluded there. Tiebreak (and
  // equality) goes to "projection" so a type with no realized rows reads
  // as projection-driven.
  origin: "projection" | "realized";
};

// Per-type revenue breakdown for a month in projection mode.
//
//   - past/current months: PROJECTION rows are skipped entirely (the
//     current month's PROJECTION row would double-count with DPP×factor).
//     `realized` is the per-type sum; `projected` is always 0;
//     origin = "realized".
//   - future months: both PROJECTION rows (`projected`) and non-PROJECTION
//     rows (`realized`) are summed per type. `effective = max(...)` —
//     PROJECTION acts as a floor; realized rows eat into the unrealized
//     portion. If realized exceeds projection, the type is realized-driven
//     and should render as a normal revenue line in the MoM panel. (See
//     aggregateRevenue for the parallel total-level computation.)
function revenueByType(
  data: FinanceData,
  month: Q2Month,
  now: Date,
): Map<string, RevenueTypeAggregate> {
  const future = isFutureMonth(month, now);
  const factor = dppExtrapolationFactor(month, now);
  const proj = new Map<string, number>();
  const real = new Map<string, number>();
  for (const r of data.revenue) {
    if (r.month !== month) continue;
    const isProj = r.source === "PROJECTION";
    // Past/current months: drop PROJECTION rows (would double-count with DPP
    // factor on the realized DPP rows). Future months: keep both kinds.
    if (!future && isProj) continue;
    const v = r.net;
    const scaled =
      factor !== 1 && !isProj && r.type === "DPP" ? v * factor : v;
    const map = isProj ? proj : real;
    map.set(r.type, (map.get(r.type) ?? 0) + scaled);
  }
  const out = new Map<string, RevenueTypeAggregate>();
  const types = new Set<string>([...proj.keys(), ...real.keys()]);
  for (const t of types) {
    const p = proj.get(t) ?? 0;
    const re = real.get(t) ?? 0;
    if (future) {
      out.set(t, {
        effective: Math.max(p, re),
        projected: p,
        realized: re,
        origin: re > p ? "realized" : "projection",
      });
    } else {
      out.set(t, {
        effective: re,
        projected: 0,
        realized: re,
        origin: "realized",
      });
    }
  }
  return out;
}

// Driver string for an expense category. Per-venue attribution for
// Field Costs; per-city for MMP / City Manager / Marketing /
// Equipment; generic Higher/Lower/New/Ends for everything else.
function expenseDriverString(
  data: FinanceData,
  category: string,
  currentMonth: Q2Month,
  nextMonth: Q2Month,
): string {
  const fmtSig = (n: number) =>
    n > 0 ? `+$${Math.round(n).toLocaleString("en-US")}`
         : n < 0 ? `-$${Math.round(Math.abs(n)).toLocaleString("en-US")}`
                : "$0";

  if (category === "Field Costs") {
    const cur = fieldCostsByVenue(data, currentMonth);
    const nxt = fieldCostsByVenue(data, nextMonth);
    return topMapDriver(cur, nxt, "Field-cost mix shift", fmtSig);
  }
  if (category === "Match Manager Pay") {
    const cur = mmpByCity(data, currentMonth);
    const nxt = mmpByCity(data, nextMonth);
    return topMapDriver(cur, nxt, "Manager pay mix shift", fmtSig);
  }
  if (category === "City Manager" || category === "Marketing" || category === "Equipment") {
    const key =
      category === "City Manager" ? "city_manager"
      : category === "Marketing" ? "marketing"
      : "equipment";
    const cur = monthlyExpenseByCity(data, currentMonth, key);
    const nxt = monthlyExpenseByCity(data, nextMonth, key);
    return topMapDriver(cur, nxt, `${category} mix shift`, fmtSig);
  }

  // Generic fin_expenses category (no per-X breakdown).
  const finCur = data.expenses
    .filter((r) => r.month === currentMonth && r.category === category)
    .reduce((s, r) => s + r.amount, 0);
  const finNxt = data.expenses
    .filter((r) => r.month === nextMonth && r.category === category)
    .reduce((s, r) => s + r.amount, 0);
  if (finCur === 0 && finNxt > 0) return `New in ${nextMonth.split(" ")[0]}`;
  if (finNxt === 0 && finCur > 0) return `Ends in ${currentMonth.split(" ")[0]}`;
  if (finNxt > finCur) return "Higher next month";
  return "Lower next month";
}

function topMapDriver(
  cur: Map<string, number>,
  nxt: Map<string, number>,
  fallback: string,
  fmtSig: (n: number) => string,
): string {
  const deltas = new Map<string, number>();
  const keys = new Set<string>([...cur.keys(), ...nxt.keys()]);
  for (const k of keys) deltas.set(k, (nxt.get(k) ?? 0) - (cur.get(k) ?? 0));
  if (deltas.size === 0) return fallback;
  const top = [...deltas.entries()].sort(
    (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
  )[0];
  if (!top || Math.abs(top[1]) < 1) return fallback;
  return `Driven by ${top[0]} (${fmtSig(top[1])})`;
}

function fieldCostsByVenue(data: FinanceData, month: Q2Month): Map<string, number> {
  const byVenue = new Map<string, number>();
  for (const v of data.venues) {
    const cost = canonicalVenueCost(data, v.id, month).amount;
    if (cost > 0) {
      byVenue.set(`${v.city} · ${v.venue_name}`, cost);
    }
  }
  return byVenue;
}

function mmpByCity(data: FinanceData, month: Q2Month): Map<string, number> {
  const byCity = new Map<string, number>();
  for (const r of data.expenses) {
    if (r.month !== month) continue;
    if (r.category !== "Match Manager Pay") continue;
    if (!r.city) continue;
    byCity.set(r.city, (byCity.get(r.city) ?? 0) + r.amount);
  }
  return byCity;
}

function monthlyExpenseByCity(
  data: FinanceData,
  month: Q2Month,
  key: "city_manager" | "marketing" | "equipment",
): Map<string, number> {
  const category = DEDICATED_LINE_CATEGORY[key];
  const byCity = new Map<string, number>();
  for (const r of data.expenses) {
    if (r.month !== month || r.category !== category) continue;
    if (!r.city) continue;
    byCity.set(r.city, (byCity.get(r.city) ?? 0) + r.amount);
  }
  return byCity;
}

// Per-vendor breakdown for a generic fin_expenses category. Used as
// the drill-down source for Contractors / Subscriptions / Corporate
// Salaries / Misc — anything without a per-city or per-venue model.
function finExpensesByVendor(
  data: FinanceData,
  month: Q2Month,
  category: string,
): Map<string, number> {
  const byVendor = new Map<string, number>();
  for (const r of data.expenses) {
    if (r.month !== month) continue;
    if (r.category !== category) continue;
    const vendor = r.vendor || "(no vendor)";
    byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + r.amount);
  }
  return byVendor;
}

// Per-city breakdown for a generic fin_expenses category. NULL city
// or the literal "Company-wide" string both surface as "Company-wide"
// (don't drop). Used for VEO Camera, where vendor names collapse to
// a single value but cost actually splits across cities.
function finExpensesByCity(
  data: FinanceData,
  month: Q2Month,
  category: string,
): Map<string, number> {
  const byCity = new Map<string, number>();
  for (const r of data.expenses) {
    if (r.month !== month) continue;
    if (r.category !== category) continue;
    const city = r.city && r.city !== "Company-wide" ? r.city : "Company-wide";
    byCity.set(city, (byCity.get(city) ?? 0) + r.amount);
  }
  return byCity;
}

// Diff two per-source maps into a delta map (next − current). Keys
// from either side surface; missing-side counts as 0.
// Per-source row in a category drill-down. Carries before/after as
// well as Δ so the UI can render "$X → $Y · +$Z" instead of just
// the delta — useful for spotting zero-to-something rows or the
// shape of a cost shift. Field Costs additionally populates
// fromBreakdown/toBreakdown ("13 × $105" / "Monthly flat" /
// "Lump sum" / "Pre-paid") so the panel can show whether a Δ is
// driven by volume vs rate vs a fixed-cost transition. Other
// categories leave breakdowns undefined.
export type CategoryChild = {
  name: string;
  fromAmount: number;
  toAmount: number;
  delta: number;
  fromBreakdown?: string;
  toBreakdown?: string;
};

function deltasFromMaps(
  cur: Map<string, number>,
  nxt: Map<string, number>,
): Map<string, { from: number; to: number; delta: number }> {
  const out = new Map<string, { from: number; to: number; delta: number }>();
  for (const k of new Set<string>([...cur.keys(), ...nxt.keys()])) {
    const from = cur.get(k) ?? 0;
    const to = nxt.get(k) ?? 0;
    out.set(k, { from, to, delta: to - from });
  }
  return out;
}

const CHILD_VISIBLE_THRESHOLD = 50; // |Δ| < $50 → rolls into "Other (N sources)"

// Sorts a per-source map into a children[] array: items with |Δ| ≥ $50
// surface individually; smaller items collapse into a single
// "Other (N sources)" tail row whose from/to/delta are summed across
// the rolled-up entries. Returns undefined when no individual source
// passes the threshold (UI hides chevron then).
type PerKeyValue = {
  from: number;
  to: number;
  delta: number;
  fromBreakdown?: string;
  toBreakdown?: string;
};

function buildChildren(
  perKey: Map<string, PerKeyValue>,
  unitLabel: { singular: string; plural: string } = {
    singular: "source",
    plural: "sources",
  },
): CategoryChild[] | undefined {
  const items: CategoryChild[] = [...perKey.entries()]
    .map(([name, v]) => ({
      name,
      fromAmount: v.from,
      toAmount: v.to,
      delta: v.delta,
      fromBreakdown: v.fromBreakdown,
      toBreakdown: v.toBreakdown,
    }))
    .filter((i) => Math.abs(i.delta) >= 0.5);
  if (items.length === 0) return undefined;

  const big = items.filter((i) => Math.abs(i.delta) >= CHILD_VISIBLE_THRESHOLD);
  const small = items.filter((i) => Math.abs(i.delta) < CHILD_VISIBLE_THRESHOLD);
  if (big.length === 0) return undefined;

  big.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  if (small.length > 0) {
    const otherFrom = small.reduce((s, i) => s + i.fromAmount, 0);
    const otherTo = small.reduce((s, i) => s + i.toAmount, 0);
    const otherDelta = otherTo - otherFrom;
    if (Math.abs(otherDelta) >= 0.5) {
      const label =
        small.length === 1
          ? `Other (1 ${unitLabel.singular})`
          : `Other (${small.length} ${unitLabel.plural})`;
      // Rollup row: leave breakdowns undefined — the aggregated
      // entries don't share a single coherent "N × $rate" answer.
      big.push({
        name: label,
        fromAmount: otherFrom,
        toAmount: otherTo,
        delta: otherDelta,
      });
    }
  }
  return big;
}

// Compact, panel-friendly description of a venue's monthly cost
// composition. Drives the "Apr: 13 × $105   May: 14 × $105" line in
// the Field Costs drill-down.
//
//   per_match (matches > 0)  → "{N} × ${rate}"  (rate = amount/N)
//   per_match (no matches)   → "—"
//   override (amount > 0)    → "Monthly flat" / "Lump sum" / "Profit
//                              share" / "Override" — derived from
//                              the override.reason prefix when present
//   override (amount = 0)    → "Pre-paid"
//   needs_override           → "Needs override"
//   no_charge / per_hour_no_fee → "No fee"
//   per_hour_metered         → "{H}h"
//   unknown                  → "—"
function compactCostBreakdown(info: VenueCostInfo): string {
  if (info.kind === "override") {
    if (info.amount === 0) return "Pre-paid";
    const r = (info.override?.reason ?? "").toLowerCase();
    if (r.includes("monthly_flat") || r.includes("monthly flat")) return "Monthly flat";
    if (r.includes("lump_sum") || r.includes("lump sum")) return "Lump sum";
    if (r.includes("profit_share") || r.includes("profit share")) return "Profit share";
    return "Override";
  }
  if (info.kind === "per_match") {
    if (info.matchCount === 0) return "—";
    const rate = info.amount / info.matchCount;
    const rateStr = Number.isInteger(rate) ? `$${rate}` : `$${rate.toFixed(2)}`;
    return `${info.matchCount} × ${rateStr}`;
  }
  if (info.kind === "per_hour_metered") {
    return `${info.totalHours}h`;
  }
  if (info.kind === "no_charge" || info.kind === "per_hour_no_fee") {
    return "No fee";
  }
  if (info.kind === "needs_override") return "Needs override";
  return "—";
}

// Per-category breakdown router. Returns the appropriate children
// rollup for an expense category, or undefined when no per-source
// breakdown applies (chevron hidden).
function expenseCategoryChildren(
  data: FinanceData,
  category: string,
  currentMonth: Q2Month,
  nextMonth: Q2Month,
): CategoryChild[] | undefined {
  if (category === "Field Costs") {
    // Bypass deltasFromMaps + the scalar fieldCostsByVenue: we need
    // both the cost AND a per-month breakdown string ("13 × $105" /
    // "Monthly flat" / "Pre-paid"). Build the perKey map directly
    // from canonicalVenueCost, which already exposes kind /
    // matchCount / override.reason / amount.
    const perKey = new Map<string, PerKeyValue>();
    for (const v of data.venues) {
      const fromInfo = canonicalVenueCost(data, v.id, currentMonth);
      const toInfo = canonicalVenueCost(data, v.id, nextMonth);
      const from = fromInfo.amount;
      const to = toInfo.amount;
      if (from <= 0 && to <= 0) continue;
      const label = `${v.city} · ${v.venue_name}`;
      perKey.set(label, {
        from,
        to,
        delta: to - from,
        fromBreakdown: compactCostBreakdown(fromInfo),
        toBreakdown: compactCostBreakdown(toInfo),
      });
    }
    return buildChildren(perKey, { singular: "city", plural: "cities" });
  }
  if (category === "Match Manager Pay") {
    return buildChildren(
      deltasFromMaps(
        mmpByCity(data, currentMonth),
        mmpByCity(data, nextMonth),
      ),
    );
  }
  if (category === "City Manager" || category === "Marketing" || category === "Equipment") {
    const key =
      category === "City Manager" ? "city_manager"
      : category === "Marketing" ? "marketing"
      : "equipment";
    return buildChildren(
      deltasFromMaps(
        monthlyExpenseByCity(data, currentMonth, key),
        monthlyExpenseByCity(data, nextMonth, key),
      ),
      { singular: "city", plural: "cities" },
    );
  }
  if (category === "VEO Camera") {
    // Vendor name collapses to a single "VEO" entry — break down by
    // city instead, which is the actionable axis.
    return buildChildren(
      deltasFromMaps(
        finExpensesByCity(data, currentMonth, category),
        finExpensesByCity(data, nextMonth, category),
      ),
      { singular: "city", plural: "cities" },
    );
  }
  // Generic fin_expenses category — per-vendor breakdown.
  return buildChildren(
    deltasFromMaps(
      finExpensesByVendor(data, currentMonth, category),
      finExpensesByVendor(data, nextMonth, category),
    ),
  );
}

// Driver string for revenue type.
//   - future + projection-origin: "<Month> target from PROJECTION estimate"
//   - future + realized-origin (manual entries have outstripped the
//     bootstrap projection floor for this type): "<Month> realized — manual
//     entry"
//   - past/current pair: "<Type> mix shift"
function revenueDriverString(
  type: string,
  nextMonth: Q2Month,
  nextIsFuture: boolean,
  nextOrigin: "projection" | "realized" | undefined,
): { driver: string; fromProjection: boolean } {
  if (nextIsFuture && nextOrigin === "projection") {
    return {
      driver: `${nextMonth.split(" ")[0]} target from PROJECTION estimate`,
      fromProjection: true,
    };
  }
  if (nextIsFuture && nextOrigin === "realized") {
    return {
      driver: `${nextMonth.split(" ")[0]} realized — manual entry`,
      fromProjection: false,
    };
  }
  return { driver: `${type} mix shift`, fromProjection: false };
}

export type Q2MonthPair = {
  current: Q2Month;
  next: Q2Month;
  label: string;
  isDefault: boolean;
};

// Every adjacent month-pair within the given quarter, in chronological
// order. Default selection: pair where current = today's calendar
// month if it falls inside the quarter; otherwise the last pair
// (operator reads "what just changed" on past quarters).
//
// In-quarter pairs only — cross-year Q4→Q1 spans are intentionally
// deferred (would require a separate cross-quarter helper).
export function getQuarterMonthPairs(
  quarter: QuarterInfo,
  now: Date = new Date(),
): Q2MonthPair[] {
  if (quarter.months.length < 2) return [];
  const pairs: Q2MonthPair[] = [];
  for (let i = 0; i < quarter.months.length - 1; i++) {
    const cur = quarter.months[i];
    const nxt = quarter.months[i + 1];
    pairs.push({
      current: cur.key,
      next: nxt.key,
      label: `${cur.shortName} → ${nxt.shortName}`,
      isDefault: false,
    });
  }
  const todayMonthKey = getCurrentMonthInQuarter(quarter, now);
  let defaultIdx = -1;
  if (todayMonthKey) {
    defaultIdx = pairs.findIndex((p) => p.current === todayMonthKey);
    if (defaultIdx === -1) defaultIdx = pairs.length - 1;
  } else {
    defaultIdx = pairs.length - 1;
  }
  pairs[defaultIdx].isDefault = true;
  return pairs;
}


// Pass an explicit (currentMonth, nextMonth) pair so the UI can
// toggle between adjacent Q2 pairs without re-deriving from `now`.
// `now` still drives DPP extrapolation factor and future-month
// detection. When either side is null, returns empty/no-comparison.
export function monthOverMonthDeltas(
  data: FinanceData,
  currentMonth: Q2Month | null,
  nextMonth: Q2Month | null,
  now: Date = new Date(),
): MonthOverMonthDeltas {
  if (!currentMonth || !nextMonth) {
    return {
      currentMonth,
      nextMonth,
      lineItems: [],
      netDelta: null,
    };
  }

  const lineItems: MoMLineItem[] = [];
  const NOISE = 0.5; // sub-dollar rounding noise → drop

  // Expense side — every category with non-trivial Δ
  const expCur = expensesByCategory(data, currentMonth, now);
  const expNxt = expensesByCategory(data, nextMonth, now);
  const expCats = new Set<string>([...expCur.keys(), ...expNxt.keys()]);
  for (const cat of expCats) {
    const delta = (expNxt.get(cat) ?? 0) - (expCur.get(cat) ?? 0);
    if (Math.abs(delta) < NOISE) continue;
    lineItems.push({
      kind: "expense",
      name: cat,
      delta,
      driver: expenseDriverString(data, cat, currentMonth, nextMonth),
      isProjectionDriven: false, // fin_expenses has no PROJECTION source
      children: expenseCategoryChildren(data, cat, currentMonth, nextMonth),
    });
  }

  // Revenue side. Per-type values are useful when both sides are
  // realized, but PROJECTION-driven types are just the bootstrap
  // estimate split into accounting buckets — the per-bucket split
  // isn't real signal. Collapse all PROJECTION-driven revenue types
  // into a single "Expected revenue (forecast)" line; keep any
  // realized-vs-realized revenue rows per-type.
  const revCur = revenueByType(data, currentMonth, now);
  const revNxt = revenueByType(data, nextMonth, now);
  const revTypes = new Set<string>([...revCur.keys(), ...revNxt.keys()]);
  const nextIsFuture = isFutureMonth(nextMonth, now);
  let projectionDrivenSum = 0;
  for (const type of revTypes) {
    const curEff = revCur.get(type)?.effective ?? 0;
    const nxtAgg = revNxt.get(type);
    const nxtEff = nxtAgg?.effective ?? 0;
    const delta = nxtEff - curEff;
    if (Math.abs(delta) < NOISE) continue;
    // For future months, missing type = bootstrap PROJECTION didn't model it.
    // Treat that absence as projection-origin so it folds into the combined
    // forecast row instead of misleadingly rendering as a "manual entry" line.
    const nextOrigin: "projection" | "realized" = nxtAgg?.origin
      ?? (nextIsFuture ? "projection" : "realized");
    const { driver, fromProjection } = revenueDriverString(
      type,
      nextMonth,
      nextIsFuture,
      nextOrigin,
    );
    if (fromProjection) {
      // Folded into the combined "Expected revenue (forecast)" row below.
      projectionDrivenSum += delta;
      continue;
    }
    lineItems.push({
      kind: "revenue",
      name: type,
      delta,
      driver,
      isProjectionDriven: false,
    });
  }
  if (Math.abs(projectionDrivenSum) >= NOISE) {
    // No children: the per-type split of a PROJECTION estimate is just
    // an accounting allocation, not actionable signal. The tooltip
    // surfaces the full per-type PROJECTION sums for the next month
    // instead, so the operator can see what the estimate covers.
    const projectionBreakdown: Array<{ type: string; amount: number }> = [];
    for (const [type, agg] of revNxt) {
      if (agg.projected < 1) continue;
      projectionBreakdown.push({ type, amount: agg.projected });
    }
    projectionBreakdown.sort((a, b) => b.amount - a.amount);
    lineItems.push({
      kind: "revenue",
      name: "Expected revenue (forecast)",
      delta: projectionDrivenSum,
      driver: "Next month from PROJECTION estimate",
      isProjectionDriven: true,
      projectionBreakdown:
        projectionBreakdown.length > 0 ? projectionBreakdown : undefined,
    });
  }

  // Sort by absolute delta desc, mixing expense + revenue.
  lineItems.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const curRevTotal = [...revCur.values()].reduce((s, v) => s + v.effective, 0);
  const curExpTotal = [...expCur.values()].reduce((s, v) => s + v, 0);
  const nxtRevTotal = [...revNxt.values()].reduce((s, v) => s + v.effective, 0);
  const nxtExpTotal = [...expNxt.values()].reduce((s, v) => s + v, 0);
  const curNet = curRevTotal - curExpTotal;
  const nxtNet = nxtRevTotal - nxtExpTotal;

  return {
    currentMonth,
    nextMonth,
    lineItems,
    netDelta: { current: curNet, next: nxtNet, delta: nxtNet - curNet },
  };
}

// =====================================================================
// Expense-only forecast (replaces the mixed-revenue Looking Ahead panel)
// =====================================================================

// Categories with absolute month-over-month change ≥ this threshold
// surface in the top-level lane on the Expense Forecast panel; the
// rest collapse into Static — UNLESS they're in PINNED_FORECAST_CATEGORIES
// below, which always render top-level regardless of |Δ|.
export const EXPENSE_FORECAST_MOVER_THRESHOLD = 500;

// Categories pinned to the top-level lane on the Expense Forecast
// panel. These render every period regardless of |Δ|, so admins can
// see month-over-month for the metrics they care about without
// expanding the Static collapse. Order here = render order in the
// panel (pinned first, then non-pinned movers sorted by |Δ| desc).
//
// Pinned categories are also exempt from the zero-zero filter in
// expenseForecastDeltas — Equipment $0 / $0 still renders so admins
// see "no equipment spending this month" instead of nothing.
export const PINNED_FORECAST_CATEGORIES: readonly string[] = [
  "Field Costs",
  "Match Manager Pay",
  "City Manager",
  "Marketing",
  "Equipment",
];
const PINNED_FORECAST_SET = new Set<string>(PINNED_FORECAST_CATEGORIES);

export type ExpenseForecastConfidence = "formula" | "mixed" | "manual";

export type ExpenseForecastRow = {
  category: string;
  fromAmount: number;
  toAmount: number;
  delta: number;
  // One-line description rendered under the category name on the
  // panel. Tells the reader at a glance how trustworthy the
  // projection is without needing tooltips.
  sourceMethod: string;
  // Bucket used for grouping/coloring; matches the diagnostic's
  // three reliability lanes.
  sourceConfidence: ExpenseForecastConfidence;
  // Per-source breakdown when the category supports drill-down. In
  // the redesigned panel, only Field Costs surfaces this — other
  // categories are rendered without a chevron.
  children?: CategoryChild[];
};

export type ExpenseForecast = {
  fromMonth: Q2Month;
  toMonth: Q2Month;
  rows: ExpenseForecastRow[]; // all categories, sorted by |delta| desc
  totals: {
    from: number;
    to: number;
    delta: number;
  };
};

// Source/method one-liner for each category. Hardcoded list mirrors
// the categories surfaced by expensesByCategory: 4 synthetics +
// whatever's in fin_expenses. Default fallback covers any future
// ad-hoc category an admin adds.
function classifyExpenseCategory(category: string): {
  sourceMethod: string;
  sourceConfidence: ExpenseForecastConfidence;
} {
  if (category === "Field Costs") {
    return {
      sourceMethod: "Formula: schedule × per-match rate (override-aware)",
      sourceConfidence: "formula",
    };
  }
  if (category === "Match Manager Pay") {
    return {
      sourceMethod: "Mixed: actuals + scheduled future weeks",
      sourceConfidence: "mixed",
    };
  }
  if (
    category === "City Manager" ||
    category === "Marketing" ||
    category === "Equipment"
  ) {
    return {
      sourceMethod: "Manual entry — recurring monthly per city",
      sourceConfidence: "manual",
    };
  }
  return {
    sourceMethod: "Manual entry",
    sourceConfidence: "manual",
  };
}

export function expenseForecastDeltas(
  data: FinanceData,
  fromMonth: Q2Month,
  toMonth: Q2Month,
  now: Date = new Date(),
): ExpenseForecast {
  const fromCats = expensesByCategory(data, fromMonth, now);
  const toCats = expensesByCategory(data, toMonth, now);
  const allCats = new Set<string>([...fromCats.keys(), ...toCats.keys()]);
  // Ensure every pinned category appears in the output even if neither
  // month produced a row for it. With expensesByCategory's explicit
  // .set() calls for City Manager / Marketing / Equipment / Field Costs
  // they should already be present, but Match Manager Pay only flows
  // through if at least one MMP row exists; this guarantees the panel
  // always renders the pinned set.
  for (const c of PINNED_FORECAST_SET) allCats.add(c);
  const rows: ExpenseForecastRow[] = [];
  for (const category of allCats) {
    const fromAmount = fromCats.get(category) ?? 0;
    const toAmount = toCats.get(category) ?? 0;
    // Pinned categories always render — including $0/$0 — so admins
    // see "no spending this month" explicitly rather than silently.
    // Non-pinned categories with zero on both sides drop out so the
    // panel doesn't list dormant categories the user has never used.
    if (
      !PINNED_FORECAST_SET.has(category) &&
      Math.abs(fromAmount) < 0.5 &&
      Math.abs(toAmount) < 0.5
    ) {
      continue;
    }
    const delta = toAmount - fromAmount;
    const meta = classifyExpenseCategory(category);
    const row: ExpenseForecastRow = {
      category,
      fromAmount,
      toAmount,
      delta,
      sourceMethod: meta.sourceMethod,
      sourceConfidence: meta.sourceConfidence,
    };
    // Only Field Costs ships a per-source drill-down in the new
    // panel. expenseCategoryChildren returns per-venue deltas with
    // a $50 noise floor + "Other (N cities)" rollup.
    if (category === "Field Costs") {
      const children = expenseCategoryChildren(
        data,
        category,
        fromMonth,
        toMonth,
      );
      if (children) row.children = children;
    }
    rows.push(row);
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const fromTotal = [...fromCats.values()].reduce((s, v) => s + v, 0);
  const toTotal = [...toCats.values()].reduce((s, v) => s + v, 0);

  return {
    fromMonth,
    toMonth,
    rows,
    totals: {
      from: fromTotal,
      to: toTotal,
      delta: toTotal - fromTotal,
    },
  };
}

function isoDateLocal(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

// Realized quarter revenue booked through today: Stripe + Venmo rows
// (source != PROJECTION) with date <= today. No DPP extrapolation,
// no PROJECTION rows. Hero subtitle uses this as "actual" with
// projected = quarterNetRevenueProjected - quarterNetRevenueActual.
export function quarterNetRevenueActual(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  const today = isoDateLocal(now);
  const monthSet = new Set(quarter.months.map((m) => m.key));
  let sum = 0;
  for (const r of data.revenue) {
    if (!monthSet.has(r.month)) continue;
    if (r.source === "PROJECTION") continue;
    if (r.date > today) continue;
    sum += r.net;
  }
  return sum;
}


const MONTH_SHORT_LABELS = [
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
] as const;

// Same-day MTD gross for the calendar month before `now`. Sums
// Stripe + Venmo (source != PROJECTION) gross where r.month is the
// prior month label AND r.date <= the same day-of-month in the prior
// month (clamped to that month's last day — e.g. if today is Mar 31,
// cutoff is Feb 28). Pairs with grossRevenueFor(currentMonth, "mtd")
// for the MTD-vs-same-day-last-month delta on the exec hero.
export function priorMonthSameDayMtdGross(
  data: FinanceData,
  now: Date = new Date(),
): number {
  const priorYear = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const priorMonthIdx = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const lastDayOfPriorMonth = new Date(priorYear, priorMonthIdx + 1, 0).getDate();
  const cutoffDay = Math.min(now.getDate(), lastDayOfPriorMonth);
  const cutoffIso = isoDateLocal(new Date(priorYear, priorMonthIdx, cutoffDay));
  const priorMonthLabel = `${MONTH_SHORT_LABELS[priorMonthIdx]} ${priorYear}`;
  let sum = 0;
  for (const r of data.revenue) {
    if (r.month !== priorMonthLabel) continue;
    if (r.source === "PROJECTION") continue;
    if (r.date > cutoffIso) continue;
    sum += r.gross;
  }
  return sum;
}

// Per-source actual breakdown for quarter expenses. Useful for sanity
// checks and inspectors; quarterExpensesActual sums these.
export type Q2ExpensesActualBreakdown = {
  managerPay: number;       // fin_expenses category=Match Manager Pay, date <= today
  manualExpenses: number;   // all other fin_expenses (incl. City Manager / Marketing / Equipment line items), date <= today
  fieldCosts: number;       // schedule-driven by match date; overrides counted in full for past+current months
  total: number;
};

// fieldCostsFor for a single month, classified actual vs projected
// by date:
//   - past month: fully actual (whole monthly canonical cost)
//   - current month, override venues (monthly_flat / lump_sum /
//     profit_share): full override amount counts as actual — the
//     monthly bill is committed once the month begins
//   - current month, schedule-driven venues (per_match / per_hour):
//     iterate fin_schedule rows, count only rows with date <= today
//   - future month: 0
function fieldCostsActualFor(
  data: FinanceData,
  month: Q2Month,
  now: Date,
): number {
  if (isFutureMonth(month, now)) return 0;
  const qm = MONTH_BY_KEY[month];
  if (!qm || !isCurrentMonthQ(qm, now)) return fieldCostsFor(data, month);
  const today = isoDateLocal(now);
  let total = 0;
  for (const v of data.venues) {
    const override = findOverride(data, v.id, month);
    if (override) {
      total += override.override_amount;
      continue;
    }
    if (v.billing_type === "per_match") {
      const rate = v.per_match_rate ?? 0;
      for (const s of data.masterSchedule) {
        if (s.venue_id !== v.id) continue;
        if (s.month !== month) continue;
        if (s.match_date > today) continue;
        total += rate;
      }
    } else if (v.billing_type === "per_hour") {
      const rate = v.hourly_rate ?? 0;
      if (rate > 0) {
        for (const s of data.masterSchedule) {
          if (s.venue_id !== v.id) continue;
          if (s.month !== month) continue;
          if (s.match_date > today) continue;
          total += s.duration_hours * rate;
        }
      }
    }
    // no_charge / unknown: 0 contribution
  }
  return total;
}

// Realized quarter expenses booked through today, classified by DATE
// (not month bucket) so current-month spend that's already happened
// counts as actual. Per-source classification:
//
//   fin_expenses (manual + imported):
//     date <= today → actual; else projected.
//     Includes Match Manager Pay (each Thursday cash-out is a
//     separately dated row), City Manager / Marketing / Equipment
//     (post-2026-05-07 migration — formerly fin_monthly_expenses),
//     Subscriptions, Corporate Salaries, Contractors, etc.
//   fieldCostsFor:
//     past month → fully actual.
//     current month → schedule-driven costs split by schedule row
//       date; override-driven costs (monthly_flat / lump_sum /
//       profit_share) counted in full as committed.
//     future month → projected.
//
// projected = quarterExpensesProjected - quarterExpensesActual.
export function quarterExpensesActualBreakdown(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): Q2ExpensesActualBreakdown {
  const today = isoDateLocal(now);
  const monthSet = new Set(quarter.months.map((m) => m.key));
  let managerPay = 0;
  let manualExpenses = 0;
  for (const r of data.expenses) {
    if (!monthSet.has(r.month)) continue;
    if (r.date > today) continue;
    if (r.category === "Match Manager Pay") managerPay += r.amount;
    else manualExpenses += r.amount;
  }
  let fieldCosts = 0;
  for (const month of quarter.months) {
    fieldCosts += fieldCostsActualFor(data, month.key, now);
  }
  return {
    managerPay,
    manualExpenses,
    fieldCosts,
    total: managerPay + manualExpenses + fieldCosts,
  };
}

export function quarterExpensesActual(
  data: FinanceData,
  quarter: QuarterInfo,
  now: Date = new Date(),
): number {
  return quarterExpensesActualBreakdown(data, quarter, now).total;
}


// ===== Phase 3 helpers: city cards + field ranking =====

// Hardcoded alphabetical order so OKC and St. Louis land predictably
// regardless of how they're stored elsewhere ("Oklahoma City" vs OKC,
// "St Louis" vs "St. Louis"). Don't swap to localeCompare.
export const CITY_DISPLAY_ORDER = [
  "Atlanta",
  "Austin",
  "Dallas",
  "El Paso",
  "Houston",
  "OKC",
  "San Antonio",
  "St. Louis",
] as const;

export type CityName = (typeof CITY_DISPLAY_ORDER)[number];

export function venueDppRevenueFor(
  data: FinanceData,
  city: string,
  venue: string,
  month: Q2Month,
): number {
  return data.revenue
    .filter(
      (r) =>
        r.city === city &&
        r.venue === venue &&
        r.month === month &&
        r.type === "DPP",
    )
    .reduce((s, r) => s + r.net, 0);
}

// Mirrors the partner-dashboard "qualifying revenue" formula
// (partnerStats.computeWeeklyPayments) so Field Ranking shows the
// same revenue number contractually owed against. Sums two streams:
//
//   - DPP from match registrations: matchPricePaid for each non-staff,
//     non-match-canceled DAILY-PAID player row whose field resolves to
//     one of this venue group's canonical leg names AND whose
//     matchStart is in `month`. Includes player-canceled rows (the
//     partner-dashboard filter only excludes match-canceled and staff).
//     Source-of-truth for revenue paid out on, not fin_revenue.DPP
//     (which is the fees-deducted Stripe rollup).
//
//   - Private Rental from fin_revenue.gross for any leg's venue_name
//     in `month`. fin_revenue Strike etc. are excluded by design —
//     only Private Rental flows into partner payouts.
//
// PR-E: attribution is by fin_venues.id on both sides.
//   mdapi side: r.fieldId → data.venueFields → fin_venues.id
//   fin_revenue side: e.venue (canonical name from Stripe boundary)
//     → look up fin_venues.id by venue_name (the boundary already
//     ran fin_venue_aliases canonicalization on ingest).
// Callers pass legVenueIds (Set<number>) for the venue group they
// care about — same role as the prior venueLegNames Set<string>.
export function venuePartnerRevenueFor(
  data: FinanceData,
  matchRegistrations: JoinedMatchPlayerRow[],
  legVenueIds: Set<number>,
  month: Q2Month,
): number {
  // Year + month index together pinpoint the calendar month for the
  // given `month` key (e.g. "Aug 2026" → year 2026, monthIndex 7).
  // Previously the year was hardcoded to 2026; the lookup now reads
  // from MONTH_BY_KEY which is seeded for every available quarter.
  const target = MONTH_BY_KEY[month];
  if (!target) return 0;
  let dpRev = 0;
  for (const r of matchRegistrations) {
    if (r.matchCanceled) continue;
    if (r.email && r.email.toLowerCase().includes(STAFF_EMAIL_DOMAIN)) continue;
    if (r.paymentType !== "DAILY PAID") continue;
    if (r.fieldId == null) continue;
    const venueId = data.venueFields.get(r.fieldId);
    if (venueId == null || !legVenueIds.has(venueId)) continue;
    const d = r.matchStart;
    if (
      d.getFullYear() !== target.year ||
      d.getMonth() !== target.monthIndex
    )
      continue;
    dpRev += Number(r.matchPricePaid ?? 0) || 0;
  }
  // fin_revenue.venue is the canonical name (Stripe boundary already
  // normalized via fin_venue_aliases on ingest). Map that to
  // fin_venues.id via a one-time per-call lookup so the set
  // membership test stays id-based.
  let prRev = 0;
  if (data.revenue.length > 0) {
    const nameToVenueId = new Map<string, number>();
    for (const v of data.venues) nameToVenueId.set(v.venue_name, v.id);
    for (const e of data.revenue) {
      if (e.month !== month) continue;
      if (e.type !== "Private Rental") continue;
      const venueId = nameToVenueId.get(e.venue ?? "");
      if (venueId == null || !legVenueIds.has(venueId)) continue;
      prRev += Number(e.gross ?? 0) || 0;
    }
  }
  return dpRev + prRev;
}

export function venueCostFor(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): number {
  // PR-E: id-keyed signature. canonicalVenueCost already accepts a
  // venue_id; this wrapper preserves the schedule fallback for
  // venues that exist in fin_schedule but not fin_venues (edge case
  // when a venue is renamed on one side but not the other). The
  // fallback resolves the row's (city, venue_name) once for the
  // string match — fin_schedule has no field_id today (PR-F).
  const venueRow = data.venues.find((v) => v.id === venueId);
  if (venueRow) {
    return canonicalVenueCost(data, venueId, month).amount;
  }
  return 0;
}

export function venueMatchCountFor(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): number {
  // venue_id is pre-resolved on masterSchedule rows (including the
  // split-rate day-of-week rule), so a direct id filter is correct
  // here — no need to fan out across (city, venue_name).
  let n = 0;
  for (const s of data.masterSchedule) {
    if (s.venue_id === venueId && s.month === month) n += 1;
  }
  return n;
}

export function cityMembershipRevenueFor(
  data: FinanceData,
  city: string,
  month: Q2Month,
): number {
  return data.revenue
    .filter(
      (r) => r.city === city && r.month === month && r.type === "Membership",
    )
    .reduce((s, r) => s + r.net, 0);
}

export type CityOverhead = {
  matchManagerPay: number;
  cityManager: number;
  marketing: number;
  equipment: number;
  misc: number;
  total: number;
};

export function cityOverheadFor(
  data: FinanceData,
  city: string,
  month: Q2Month,
): CityOverhead {
  // All five categories sourced from fin_expenses line items.
  // City Manager / Marketing / Equipment moved here on 2026-05-07
  // (migration retired the placeholder fin_monthly_expenses table).
  // City-tagged Misc rows roll up into the city's overhead; Misc rows
  // with city=null are company-wide and surface only in Cash Flow / Q2
  // hero, not on a CityPLCard — deliberate split: city tag on a Misc
  // row means "attribute this expense to that city".
  const sumByCategory = (category: string) =>
    data.expenses
      .filter(
        (r) => r.city === city && r.month === month && r.category === category,
      )
      .reduce((s, r) => s + r.amount, 0);
  const matchManagerPay = sumByCategory("Match Manager Pay");
  const cityManager = sumByCategory("City Manager");
  const marketing = sumByCategory("Marketing");
  const equipment = sumByCategory("Equipment");
  const misc = sumByCategory("Misc");
  return {
    matchManagerPay,
    cityManager,
    marketing,
    equipment,
    misc,
    total: matchManagerPay + cityManager + marketing + equipment + misc,
  };
}

export function activeVenuesForCity(
  data: FinanceData,
  city: string,
  month: Q2Month,
): string[] {
  const venues = new Set<string>();
  for (const r of data.revenue) {
    if (
      r.city === city &&
      r.month === month &&
      r.type === "DPP" &&
      r.venue
    ) {
      venues.add(r.venue);
    }
  }
  // For masterSchedule, resolve the venue name through data.venues so the
  // emitted string is the canonical fin_venues.venue_name. Drops any
  // schedule_master/fin_venues string drift that would otherwise surface
  // as two near-identical entries in the active-venues list.
  for (const s of data.masterSchedule) {
    if (s.month !== month) continue;
    if (s.venue_id == null) continue;
    const v = data.venues.find((x) => x.id === s.venue_id);
    if (!v || v.city !== city) continue;
    venues.add(v.venue_name);
  }
  return [...venues].sort();
}

export function cityGrossRevenueFor(
  data: FinanceData,
  city: string,
  month: Q2Month,
): number {
  return data.revenue
    .filter((r) => r.city === city && r.month === month)
    .reduce((s, r) => s + r.gross, 0);
}

export type VenueMemberSpotBreakdown = {
  member: number;
  dpp: number;
  other: number;
  total: number;
};

export function venueMemberSpotsFor(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): VenueMemberSpotBreakdown {
  // PR-E: bucket key is `${venueId}|${month}`. City is implicit in
  // venueId. Reads from the live mdapi-derived index built off
  // mdapi_match_players + fin_venue_fields (field_id → venueId).
  const counts =
    data.mdapiMemberSpots.byVenueMonth.get(`${venueId}|${month}`) ??
    ZERO_SPOT_COUNTS;
  return {
    member: counts.member,
    dpp: counts.dpp,
    other: counts.other,
    total: counts.member + counts.dpp + counts.other,
  };
}

export function cityTotalMemberSpotsFor(
  data: FinanceData,
  city: string,
  month: Q2Month,
): number {
  // Returns the MEMBER-spot total for the city in this month — the
  // denominator for "this venue's share of city MEMBER fills."
  // Reads from mdapiMemberSpots for the same reason as
  // venueMemberSpotsFor above.
  return (
    data.mdapiMemberSpots.byCityMonth.get(`${city}|${month}`)?.member ?? 0
  );
}

export function venueAllocatedMemberRevenueFor(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): number {
  // PR-E: id-keyed venue lookup. City is resolved from the venue
  // row for the cityMembershipRevenueFor denominator. byCityMonth
  // keeps the `${city}|${month}` key — city is the correct grain
  // for the denominator (total city membership revenue).
  const venueRow = data.venues.find((v) => v.id === venueId);
  if (!venueRow) return 0;
  const venueSpots =
    data.mdapiMemberSpots.byVenueMonth.get(`${venueId}|${month}`)?.member ?? 0;
  const cityTotal =
    data.mdapiMemberSpots.byCityMonth.get(`${venueRow.city}|${month}`)?.member ??
    0;
  if (cityTotal <= 0) return 0;
  const cityMembership = cityMembershipRevenueFor(data, venueRow.city, month);
  return (venueSpots / cityTotal) * cityMembership;
}

// Per-match member-revenue allocation for the Match P&L subtab.
//
// Extends `venueAllocatedMemberRevenueFor` one level deeper —
// venue-month → venue-month-match — so individual matches reconcile
// with the venue/month total Field Ranking already shows. Same
// pro-rata mental model: split the venue's monthly member rev
// across that month's matches in proportion to MEMBER fills at
// each match.
//
//   match_member_rev =
//     (member_spots_at_match / month_member_spots_at_venue)
//     × venueAllocatedMemberRevenueFor(...)
//
// Sum across a venue's matches in a month equals the venue's monthly
// member rev. Sum across venues equals city-month membership rev.
//
// month_member_spots_at_venue comes from the pre-aggregated
// fin_member_spots table (same source Field Ranking uses) — keeps
// the upload-aggregate as the single source of truth even though
// the per-match count comes from match_registrations.
const MONTH_NAMES_FROM_ISO = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Returns the canonical month-key ("Apr 2026") for a YYYY-MM-DD ISO
// timestamp. Quarter-agnostic — any month resolves. Downstream
// lookups (mdapiMemberSpots indexes) return 0 for keys they don't
// have, which is the correct empty-state behavior.
function isoToMonthKey(iso: string): Q2Month | null {
  const m = iso.match(/^(\d{4})-(\d{2})-/);
  if (!m) return null;
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${MONTH_NAMES_FROM_ISO[monthIdx]} ${m[1]}`;
}

export function matchAllocatedMemberRevenueFor(
  data: FinanceData,
  args: {
    city: string;
    venueName: string; // canonical (post-alias) — kept for API compat
    matchStartIso: string; // raw ISO timestamp; used for month bucketing
    memberSpots: number; // count of MEMBER-payment registrations at this match
  },
): number {
  if (args.memberSpots <= 0) return 0;

  const month = isoToMonthKey(args.matchStartIso);
  // Match outside Q2 (e.g. user navigated to a March or July week):
  // Q2-keyed helpers would silently return 0 anyway, so short-circuit.
  if (!month) return 0;

  // Algebra:
  //   match_rev = (memberSpots / venueSpots)
  //             × (venueSpots  / cityTotal)
  //             × cityMembership
  //           =  (memberSpots  / cityTotal)
  //             × cityMembership
  // The venue-level count cancels — we only need the city-month
  // total as the denominator.
  const cityTotal =
    data.mdapiMemberSpots.byCityMonth.get(`${args.city}|${month}`)?.member ?? 0;
  if (cityTotal <= 0) return 0;

  const cityMembership = cityMembershipRevenueFor(data, args.city, month);
  return (args.memberSpots / cityTotal) * cityMembership;
}

// =====================================================================
// MdapiMemberSpotIndex — derives member-spot counts directly from
// mdapi_match_players, used as the denominator for the two member-rev
// allocation helpers above. Replaces the fin_member_spots dependency
// (a manually-uploaded monthly aggregate that drifted from real-time
// match data at every month boundary).
//
// Built once in useFinanceData. Q2-scoped to match the cockpit's
// quarterly window — pre-Q2 timestamps short-circuit isoToMonthKey
// upstream so they never hit the index.
// =====================================================================

// Per-key bucket of payment-type counts. `member` is the MEMBER fill
// (FREE rows in mdapi_match_players); `dpp` is DAILY PAID (cash
// per-player); `other` covers anything else with a valid paid_status
// — in practice PROMOCODE. The three buckets sum to "active spots"
// at the venue/city for that Q2 month.
export type MdapiMemberSpotCounts = {
  member: number;
  dpp: number;
  other: number;
};

export type MdapiMemberSpotIndex = {
  // PR-E: key: `${fin_venues.id}|${Q2Month}`. City is implicit in
  // the venue id; the byCityMonth map below carries the city
  // grouping needed for the cityTotal denominator.
  byVenueMonth: Map<string, MdapiMemberSpotCounts>;
  // key: `${city}|${Q2Month}` — unchanged. City-level denominator
  // for the member-revenue allocation algebra.
  byCityMonth: Map<string, MdapiMemberSpotCounts>;
};

const ZERO_SPOT_COUNTS: MdapiMemberSpotCounts = { member: 0, dpp: 0, other: 0 };

export function emptyMdapiMemberSpotIndex(): MdapiMemberSpotIndex {
  return { byVenueMonth: new Map(), byCityMonth: new Map() };
}

export function buildMdapiMemberSpotIndex(
  regs: LegacyMatchRegRow[],
  venues: {
    id: number;
    venue_name: string;
    raw_venue_name: string;
    city: string;
    cost_per_match: number | null;
  }[],
  // PR-E: venueFields is mdapi_field_id → fin_venues.id. Replaces
  // the prior aliases-based name canonicalization, which dropped
  // any field_title whose normalizeMatchName output didn't match a
  // fin_venues.venue_name row. fin_venue_fields is the source of
  // truth — adding a new mdapi field is one INSERT into that table,
  // no normalizer rule changes.
  venueFields: Map<number, number>,
): MdapiMemberSpotIndex {
  const byVenueMonth = new Map<string, MdapiMemberSpotCounts>();
  const byCityMonth = new Map<string, MdapiMemberSpotCounts>();

  const fieldIds = new Set<number>();
  for (const r of regs) if (r.field_id != null) fieldIds.add(r.field_id);
  const fieldToVenue = buildFieldIdToVenueIdMap(fieldIds, venueFields);
  const venueById = new Map(venues.map((v) => [v.id, v]));

  function bucket(map: Map<string, MdapiMemberSpotCounts>, key: string) {
    let cur = map.get(key);
    if (!cur) {
      cur = { member: 0, dpp: 0, other: 0 };
      map.set(key, cur);
    }
    return cur;
  }

  for (const r of regs) {
    // Match-level filters mirror matchPnL.ts active eligibility.
    if (r.match_canceled) continue;
    if (r.player_canceled_at && r.player_canceled_at.trim() !== "") continue;
    // GUEST rows are phantom seats from a host buying multiple spots
    // (same person, second seat). They carry amount=0 and represent
    // no distinct customer. Excluded here so the city-month member
    // denominator feeding the April benchmark counts only real
    // distinct attendees.
    if (r.user_type === "GUEST") continue;

    // Categorize by payment_type. MEMBER → member; DAILY PAID → dpp;
    // anything else with a recognized type (mostly PROMOCODE) → other.
    // Unknown payment_type is dropped so the index doesn't accumulate
    // garbage from rows the cockpit can't interpret.
    const pt = (r.payment_type ?? "").toUpperCase();
    let category: keyof MdapiMemberSpotCounts;
    if (pt === "MEMBER") category = "member";
    else if (pt === "DAILY PAID") category = "dpp";
    else if (pt === "PROMOCODE") category = "other";
    else continue;

    const month = isoToMonthKey(r.match_start);
    if (!month) continue;

    if (r.field_id == null) continue;
    const baseVenueId = fieldToVenue.get(r.field_id);
    if (baseVenueId == null) continue;
    // Day-of-week swap: ATH Katy + Sun match → ATH Katy Sunday venue,
    // so member spots bucket under the right rate-tier row. r.match_start
    // is the wall-clock-stable ISO produced by toLegacyShape; new Date()
    // parses as local, .getDay() is the local day-of-week.
    const matchStart = new Date(r.match_start);
    const resolved = resolveVenueForMatch(baseVenueId, matchStart, venues);
    const v = venueById.get(resolved.venueId);
    if (!v) continue;

    bucket(byVenueMonth, `${resolved.venueId}|${month}`)[category] += 1;
    bucket(byCityMonth, `${v.city}|${month}`)[category] += 1;
  }

  return { byVenueMonth, byCityMonth };
}

// Field → venue resolution moved to venueNormalization.buildFieldToVenueIdMap.

export type RankingRow = {
  venue: string;
  city: string;
  launchDate: string | null;
  launchedMs: number;
  // Drop-in / per-player revenue — sum of match-registration
  // DAILY-PAID matchPricePaid (excludes staff + match-canceled) plus
  // fin_revenue Private Rental gross. NOT the fees-deducted fin_revenue
  // DPP net. The Field Ranking table labels this column "DPP Revenue".
  revenue: number;
  // memberRev + revenue — the venue's total revenue per the partner
  // formula. Surfaced as the leading money column on Field Ranking
  // and the default sort key.
  totalRevenue: number;
  memberRev: number;
  cityMbrPct: number;
  mbrMixPct: number;
  dppMixPct: number;
  cost: number;
  matchCount: number;
  billingType: FinanceData["venues"][number]["billing_type"] | null;
  perMatchRate: number | null;
  monthlyFlat: number | null;
  // Per-leg matches × rate for combined split-rate groups (registered
  // in venueGroups.COMBINE_BY_NAME — today: ATH Katy weekday $140 +
  // Sunday $160). Populated only when the group has > 1 per_match leg
  // so the table subtitle can render "12 × $140 + 5 × $160" instead
  // of collapsing both legs into a single rate. Empty array on
  // non-split rows. Legs come pre-sorted ASC by rate from groupVenues.
  perMatchLegs: Array<{ matchCount: number; rate: number }>;
  netPL: number;
  margin: number;
};

export function buildRankingRows(
  data: FinanceData,
  matchRegistrations: JoinedMatchPlayerRow[],
  month: Q2Month,
): RankingRow[] {
  const out: RankingRow[] = [];
  const groups = groupVenues(data.venues);

  for (const g of groups) {
    const primary = g.legs[0];
    // PR-E: keying on fin_venues.id. legVenueIds covers all legs in
    // the group (e.g. ATH Katy weekday + ATH Katy Sunday). Each
    // helper sums per-leg under the hood; the group iteration here
    // sums per-leg explicitly for cost + match count + spots so
    // split-rate legs accumulate independently.
    const legVenueIds = new Set(g.legs.map((l) => l.id));
    const revenue = venuePartnerRevenueFor(
      data,
      matchRegistrations,
      legVenueIds,
      month,
    );
    let memberRev = 0;
    let cost = 0;
    let matchCount = 0;
    let memberSpots = 0;
    let dppSpots = 0;
    let otherSpots = 0;
    const legCounts: number[] = [];

    for (const leg of g.legs) {
      memberRev += venueAllocatedMemberRevenueFor(data, leg.id, month);
      cost += canonicalVenueCost(data, leg.id, month).amount;
      const legMatches = venueMatchCountFor(data, leg.id, month);
      legCounts.push(legMatches);
      matchCount += legMatches;
      const spots = venueMemberSpotsFor(data, leg.id, month);
      memberSpots += spots.member;
      dppSpots += spots.dpp;
      otherSpots += spots.other;
    }
    // Per-leg subtitle data, only for combined per_match groups.
    // Single-leg groups fall through to the existing single-rate
    // subtitle on the table. Non-per_match billing types don't drive
    // a count × rate formula, so they're skipped here too.
    const perMatchLegs: Array<{ matchCount: number; rate: number }> =
      g.isCombined && primary.billing_type === "per_match"
        ? g.legs.map((leg, idx) => ({
            matchCount: legCounts[idx],
            rate: leg.per_match_rate ?? 0,
          }))
        : [];

    if (revenue === 0 && memberRev === 0 && cost === 0) continue;

    const cityTotalMember = cityTotalMemberSpotsFor(data, g.city, month);
    const totalSpots = memberSpots + dppSpots + otherSpots;
    const cityMbrPct =
      cityTotalMember > 0 ? memberSpots / cityTotalMember : 0;
    const mbrMixPct = totalSpots > 0 ? memberSpots / totalSpots : 0;
    const dppMixPct = totalSpots > 0 ? dppSpots / totalSpots : 0;
    const totalRev = revenue + memberRev;
    const netPL = totalRev - cost;
    const margin = totalRev > 0 ? netPL / totalRev : 0;

    let launchedMs = Number.POSITIVE_INFINITY;
    if (primary.launch_date) {
      const d = new Date(primary.launch_date);
      if (!Number.isNaN(d.getTime())) launchedMs = d.getTime();
    }

    out.push({
      venue: g.displayName,
      city: g.city,
      launchDate: primary.launch_date,
      launchedMs,
      revenue,
      totalRevenue: revenue + memberRev,
      memberRev,
      cityMbrPct,
      mbrMixPct,
      dppMixPct,
      cost,
      matchCount,
      billingType: primary.billing_type ?? null,
      perMatchRate: primary.per_match_rate,
      monthlyFlat: primary.monthly_flat,
      perMatchLegs,
      netPL,
      margin,
    });
  }
  return out;
}

export function relativeTimeFromDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 0) return "—";
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.round(months / 12);
  return `${years}y`;
}

// Quarter-aware tab → months. `tab` is either the quarter key
// ("2026Q2"), the bare quarter label ("Q2"), or one of the quarter's
// month shortNames ("Apr"). Falls back to the full quarter for
// unrecognized values.
export function quarterTabToMonths(
  quarter: QuarterInfo,
  tab: string,
): Q2Month[] {
  if (tab === quarter.key || tab === `Q${quarter.quarter}`) {
    return quarter.months.map((m) => m.key);
  }
  const found = quarter.months.find((m) => m.shortName === tab);
  if (found) return [found.key];
  return quarter.months.map((m) => m.key);
}


// ===== Phase 4 helpers: insight calculations =====

export type VenueInsightRow = {
  city: string;
  venue: string;
  // Partner-dashboard formula (match-reg DAILY-PAID + fin_revenue
  // Private Rental, gross, canonical-resolved). Same number as the
  // Field Ranking "Revenue" column. Replaces the legacy fin_revenue
  // DPP.net sum.
  revenue: number;
  memberRev: number;
  cost: number;
  net: number;
  spots: VenueMemberSpotBreakdown;
  launchDate: string | null;
  launchAgeDays: number | null;
};

function ageInDaysFrom(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

export function buildVenueInsightRows(
  data: FinanceData,
  matchRegistrations: JoinedMatchPlayerRow[],
  month: Q2Month,
  now: Date = new Date(),
): VenueInsightRow[] {
  const out: VenueInsightRow[] = [];
  for (const v of data.venues) {
    const revenue = venuePartnerRevenueFor(
      data,
      matchRegistrations,
      new Set([v.id]),
      month,
    );
    const memberRev = venueAllocatedMemberRevenueFor(data, v.id, month);
    const cost = venueCostFor(data, v.id, month);
    const spots = venueMemberSpotsFor(data, v.id, month);
    if (
      revenue === 0 &&
      memberRev === 0 &&
      cost === 0 &&
      spots.total === 0
    ) {
      continue;
    }
    out.push({
      city: v.city,
      venue: v.venue_name,
      revenue,
      memberRev,
      cost,
      net: revenue + memberRev - cost,
      spots,
      launchDate: v.launch_date,
      launchAgeDays: ageInDaysFrom(v.launch_date, now),
    });
  }
  return out;
}

export type CityInsightRow = {
  city: string;
  fieldNet: number;
  membershipRev: number;
  overhead: number;
  net: number;
  grossRev: number;
};

export function buildCityInsightRows(
  data: FinanceData,
  month: Q2Month,
  venueRows: VenueInsightRow[],
): CityInsightRow[] {
  const cities = new Set<string>();
  for (const c of CITY_DISPLAY_ORDER) cities.add(c);
  for (const r of venueRows) cities.add(r.city);

  const fieldNetByCity = new Map<string, number>();
  for (const r of venueRows) {
    fieldNetByCity.set(r.city, (fieldNetByCity.get(r.city) ?? 0) + (r.revenue - r.cost));
  }

  const out: CityInsightRow[] = [];
  for (const city of cities) {
    const fieldNet = fieldNetByCity.get(city) ?? 0;
    const membershipRev = cityMembershipRevenueFor(data, city, month);
    const overhead = cityOverheadFor(data, city, month).total;
    const grossRev = cityGrossRevenueFor(data, city, month);
    const net = fieldNet + membershipRev - overhead;
    if (
      fieldNet === 0 &&
      membershipRev === 0 &&
      overhead === 0 &&
      grossRev === 0
    ) {
      continue;
    }
    out.push({ city, fieldNet, membershipRev, overhead, net, grossRev });
  }
  return out;
}

export function profitableFields(rows: VenueInsightRow[]): VenueInsightRow[] {
  return rows.filter((r) => r.net > 0).sort((a, b) => b.net - a.net);
}

export function unprofitableFields(rows: VenueInsightRow[]): VenueInsightRow[] {
  return rows.filter((r) => r.net < 0).sort((a, b) => a.net - b.net);
}

export function profitableCities(rows: CityInsightRow[]): CityInsightRow[] {
  return rows.filter((r) => r.net > 0).sort((a, b) => b.net - a.net);
}

export function unprofitableCities(rows: CityInsightRow[]): CityInsightRow[] {
  return rows.filter((r) => r.net < 0).sort((a, b) => a.net - b.net);
}

export function newVenuesProfitable(
  rows: VenueInsightRow[],
): VenueInsightRow[] {
  return rows
    .filter(
      (r) =>
        r.launchAgeDays !== null &&
        r.launchAgeDays >= 30 &&
        r.launchAgeDays < 90 &&
        r.net > 0,
    )
    .sort((a, b) => b.net - a.net);
}

export function newVenuesStruggling(
  rows: VenueInsightRow[],
): VenueInsightRow[] {
  return rows
    .filter(
      (r) =>
        r.launchAgeDays !== null &&
        r.launchAgeDays >= 30 &&
        r.launchAgeDays < 90 &&
        r.net < 0,
    )
    .sort((a, b) => a.net - b.net);
}

export type OverheadBurdenRow = {
  city: string;
  overhead: number;
  revenue: number;
  burdenPct: number;
};

export function overheadBurdenCities(
  rows: CityInsightRow[],
): OverheadBurdenRow[] {
  return rows
    .filter((r) => r.grossRev > 0 && r.overhead / r.grossRev > 0.5)
    .map((r) => ({
      city: r.city,
      overhead: r.overhead,
      revenue: r.grossRev,
      burdenPct: r.overhead / r.grossRev,
    }))
    .sort((a, b) => b.burdenPct - a.burdenPct);
}


export type MembershipHealthVerdict =
  | "strong"
  | "break_even_plus"
  | "marginal"
  | "at_risk";

export type MembershipHealthRow = {
  city: string;
  members: number;
  actualMatchesPerMember: number;
  breakEvenMatches: number;
  ratio: number;
  verdict: MembershipHealthVerdict;
  memberPriceDollars: number;
  weightedDppPriceDollars: number;
};

export function membershipHealthAvailable(data: FinanceData): boolean {
  // After the BE rewrite, this card no longer needs fin_member_spots
  // (the deprecated Sheet source). It needs members + at least one
  // venue with a member_price set so we can determine the city sticker.
  return (
    data.members.length > 0 &&
    data.venues.some((v) => (v.member_price ?? 0) > 0)
  );
}

// Returns the canonical city sticker for a member: every active
// fin_venues row in a city is seeded with the same member_price, so
// pick any one. Falls back to fin_pricing if fin_venues hasn't been
// seeded for that city yet.
function cityMemberPriceFor(
  data: FinanceData,
  city: string,
): number | null {
  for (const v of data.venues) {
    if (v.city !== city) continue;
    if (v.member_price != null && v.member_price > 0) return v.member_price;
  }
  for (const p of data.pricing) {
    if (p.city !== city) continue;
    if (p.member_price > 0) return p.member_price;
  }
  return null;
}

function cityDppFor(
  data: FinanceData,
  canonicalVenue: string,
): { dpp: number; city: string } | null {
  const v = data.venues.find((x) => x.venue_name === canonicalVenue);
  if (v && v.dpp_price != null && v.dpp_price > 0) {
    return { dpp: v.dpp_price, city: v.city };
  }
  const p = data.pricing.find((x) => x.venue_name === canonicalVenue);
  if (p && p.dpp_price > 0) return { dpp: p.dpp_price, city: p.city };
  return null;
}

// Derives the "YYYY-MM" ISO prefix for any month-key (e.g. "Apr 2026"
// → "2026-04"). Uses MONTH_BY_KEY so it works across every quarter
// the page selector might expose.
function monthIsoPrefix(month: Q2Month): string | null {
  const qm = MONTH_BY_KEY[month];
  if (!qm) return null;
  return `${qm.year}-${String(qm.monthIndex + 1).padStart(2, "0")}`;
}

export function buildMembershipHealthRows(
  data: FinanceData,
  matchRows: MatchRow[],
  month: Q2Month,
): MembershipHealthRow[] {
  if (!membershipHealthAvailable(data)) return [];

  // ─── Member cohort: ACTIVE + price > 0 only. Excludes $0 promo
  // accounts from BOTH the count and the matches-played denominator.
  const memberCountByCity = new Map<string, number>();
  const memberPriceCentsTotalByCity = new Map<string, number>();
  for (const m of data.members) {
    if (m.status !== "ACTIVE") continue;
    if (m.price_cents <= 0) continue;
    memberCountByCity.set(m.city, (memberCountByCity.get(m.city) ?? 0) + 1);
    memberPriceCentsTotalByCity.set(
      m.city,
      (memberPriceCentsTotalByCity.get(m.city) ?? 0) + m.price_cents,
    );
  }

  // ─── Matches played by members in the active month, per canonical
  // venue → city. Source: match_registrations.payment_type='MEMBER',
  // non-cancelled, in-month. Field names canonicalized through the
  // same fin_venue_aliases pipeline that fin_revenue uses so combined
  // venues (Premier at SJD → SJD) collapse correctly.
  const monthPrefix = monthIsoPrefix(month);
  if (!monthPrefix) return [];
  type CityMatchAcc = {
    totalMemberRegs: number;
    weightedDppNum: number;
    weightedDppDenom: number;
  };
  const matchesByCity = new Map<string, CityMatchAcc>();
  for (const r of matchRows) {
    if (r.matchCanceled) continue;
    const iso = `${r.matchStart.getFullYear()}-${String(
      r.matchStart.getMonth() + 1,
    ).padStart(2, "0")}`;
    if (iso !== monthPrefix) continue;
    const pt = (r.paymentType ?? "").trim().toLowerCase();
    if (pt !== "member") continue;
    const canonical = normalizeMatchName(r.field, data.venueAliases).canonical;
    if (!canonical) continue;
    const v = cityDppFor(data, canonical);
    if (!v) continue;
    const acc = matchesByCity.get(v.city) ?? {
      totalMemberRegs: 0,
      weightedDppNum: 0,
      weightedDppDenom: 0,
    };
    acc.totalMemberRegs += 1;
    acc.weightedDppNum += v.dpp;
    acc.weightedDppDenom += 1;
    matchesByCity.set(v.city, acc);
  }

  const out: MembershipHealthRow[] = [];
  for (const city of memberCountByCity.keys()) {
    const members = memberCountByCity.get(city) ?? 0;
    if (members < 5) continue;

    // Numerator: city sticker. NOT the cohort average, which gets
    // dragged down by grandfathered $1–10/mo deals (e.g. OKC averages
    // $3.33 vs $15 sticker, Atlanta $10.67 vs $32.48 — see the
    // possible-leak warning below).
    const memberPriceDollars = cityMemberPriceFor(data, city);
    if (memberPriceDollars == null) continue;

    // Surface revenue-leak signal in the console for follow-up — fires
    // when the cohort's avg paid price drifts >30% under the city
    // sticker, which usually means too many grandfathered / promo
    // members in a small market.
    const cohortAvgPriceDollars =
      (memberPriceCentsTotalByCity.get(city) ?? 0) / members / 100;
    if (
      cohortAvgPriceDollars > 0 &&
      memberPriceDollars > 0 &&
      cohortAvgPriceDollars / memberPriceDollars < 0.7
    ) {
      const pct = Math.round(
        (1 - cohortAvgPriceDollars / memberPriceDollars) * 100,
      );
      console.warn(
        `[membership-health] ${city}: avg paid price $${cohortAvgPriceDollars.toFixed(2)} vs $${memberPriceDollars.toFixed(2)} sticker (-${pct}%) — possible revenue leak (${members} active members)`,
      );
    }

    const cm = matchesByCity.get(city);
    const totalMemberRegs = cm?.totalMemberRegs ?? 0;
    const weightedDpp =
      cm && cm.weightedDppDenom > 0
        ? cm.weightedDppNum / cm.weightedDppDenom
        : 0;
    const actualMatchesPerMember = members > 0 ? totalMemberRegs / members : 0;
    const breakEven = weightedDpp > 0 ? memberPriceDollars / weightedDpp : 0;
    const ratio = breakEven > 0 ? actualMatchesPerMember / breakEven : 0;

    let verdict: MembershipHealthVerdict;
    if (ratio >= 1.5) verdict = "strong";
    else if (ratio >= 1) verdict = "break_even_plus";
    else if (ratio >= 0.7) verdict = "marginal";
    else verdict = "at_risk";

    out.push({
      city,
      members,
      actualMatchesPerMember,
      breakEvenMatches: breakEven,
      ratio,
      verdict,
      memberPriceDollars,
      weightedDppPriceDollars: weightedDpp,
    });
  }

  // Sort by tier (Strong → BE+ → Marginal → Overpaying), then by member
  // count desc within tier so the biggest cohorts surface first inside
  // each band.
  const tierRank: Record<MembershipHealthVerdict, number> = {
    strong: 0,
    break_even_plus: 1,
    marginal: 2,
    at_risk: 3,
  };
  return out.sort((a, b) => {
    const t = tierRank[a.verdict] - tierRank[b.verdict];
    if (t !== 0) return t;
    return b.members - a.members;
  });
}

// ===== Revenue per match (last 4 weeks, by city) =====

// `matches` here is 18-spot match-equivalents (total non-canceled
// spots / 18), not raw distinct match count. Normalizes for venues
// that run 14, 22, or 40-spot capacity so per-equivalent-match
// revenue is comparable across cities.
export const SPOTS_PER_MATCH_EQUIVALENT = 18;

export type RevenuePerMatchRow = {
  city: string;
  matches: number; // match-equivalents (float)
  grossTotal: number;
  dppTotal: number;
  grossPerMatch: number;
  dppPerMatch: number;
  mixPct: number; // 0–100, dpp share of gross
};

// "Last 4 ISO weeks ending this past Sunday".
// Returns [start, end) — start at Monday 00:00 local, end exclusive
// at the following Monday 00:00 local. If today is Sunday the
// current week is treated as complete (Sun is its last day).
export function lastFourCompleteIsoWeeks(now: Date): { start: Date; end: Date } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay(); // 0 Sun, 1 Mon, ..., 6 Sat
  const daysToMon = dow === 0 ? 6 : dow - 1;
  const thisMonday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - daysToMon,
  );
  const includesThisWeek = dow === 0;
  const endMonday = includesThisWeek
    ? new Date(
        thisMonday.getFullYear(),
        thisMonday.getMonth(),
        thisMonday.getDate() + 7,
      )
    : thisMonday;
  const start = new Date(
    endMonday.getFullYear(),
    endMonday.getMonth(),
    endMonday.getDate() - 28,
  );
  return { start, end: endMonday };
}

// fin_revenue.date is YYYY-MM-DD plain date — parse as local
// midnight to avoid UTC bucket shift on the 1st of the month.
function parseRevenueDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function computeRevenuePerMatchByCity(
  data: FinanceData,
  matchRows: Pick<MatchRow, "city" | "field" | "matchStart" | "matchCanceled">[],
  now: Date = new Date(),
): RevenuePerMatchRow[] {
  const { start, end } = lastFourCompleteIsoWeeks(now);

  // Revenue side: Stripe-only, bucketed by Stripe charge date.
  // Membership rows don't have a match_start; their charge date is
  // when the recurring payment hit our books, which is the right
  // bucket for "what we earned in this 4-week window."
  const grossByCity = new Map<string, number>();
  const dppByCity = new Map<string, number>();
  for (const r of data.revenue) {
    if (r.source !== "Stripe") continue;
    if (!r.city) continue;
    const d = parseRevenueDate(r.date);
    if (!d) continue;
    if (d < start || d >= end) continue;
    grossByCity.set(r.city, (grossByCity.get(r.city) ?? 0) + r.net);
    if (r.type === "DPP") {
      dppByCity.set(r.city, (dppByCity.get(r.city) ?? 0) + r.net);
    }
  }

  // Match side: total non-canceled spots per city in the window,
  // divided by 18 to give match-equivalents. One row per spot —
  // same source as Spot Mix by City. Normalizes across mixed-
  // capacity venues (14 / 22 / 40-spot) so a 40-spot match counts
  // as ~2.2 equivalents and a 14-spot as ~0.78.
  const spotsByCity = new Map<string, number>();
  for (const m of matchRows) {
    if (m.matchCanceled) continue;
    if (!m.city) continue;
    if (m.matchStart < start || m.matchStart >= end) continue;
    spotsByCity.set(m.city, (spotsByCity.get(m.city) ?? 0) + 1);
  }

  const cities = new Set<string>([
    ...grossByCity.keys(),
    ...spotsByCity.keys(),
  ]);
  const out: RevenuePerMatchRow[] = [];
  for (const city of cities) {
    const grossTotal = grossByCity.get(city) ?? 0;
    const dppTotal = dppByCity.get(city) ?? 0;
    const spots = spotsByCity.get(city) ?? 0;
    const matches = spots / SPOTS_PER_MATCH_EQUIVALENT;
    out.push({
      city,
      matches,
      grossTotal,
      dppTotal,
      grossPerMatch: matches > 0 ? grossTotal / matches : 0,
      dppPerMatch: matches > 0 ? dppTotal / matches : 0,
      mixPct: grossTotal > 0 ? (dppTotal / grossTotal) * 100 : 0,
    });
  }
  return out;
}

// Company-wide blended totals — NOT a simple average of city
// per-match figures. Aggregates raw numerators and denominators
// first, then divides, so big cities weight appropriately.
export function computeRevenuePerMatchTotal(
  rows: RevenuePerMatchRow[],
): RevenuePerMatchRow {
  let matches = 0;
  let grossTotal = 0;
  let dppTotal = 0;
  for (const r of rows) {
    matches += r.matches;
    grossTotal += r.grossTotal;
    dppTotal += r.dppTotal;
  }
  return {
    city: "Total",
    matches,
    grossTotal,
    dppTotal,
    grossPerMatch: matches > 0 ? grossTotal / matches : 0,
    dppPerMatch: matches > 0 ? dppTotal / matches : 0,
    mixPct: grossTotal > 0 ? (dppTotal / grossTotal) * 100 : 0,
  };
}
