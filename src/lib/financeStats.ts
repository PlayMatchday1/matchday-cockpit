import type { FinanceData } from "./useFinanceData";
import type { MatchRow } from "./useMatchData";
import {
  canonicalVenueCost,
  fieldCostsFor,
  findOverride,
  perMatchTotalFor,
} from "./financeCosts";
import { groupVenues } from "./venueGroups";
import { normalizeMatchName } from "./venueNormalization";

export const Q2_MONTHS = ["Apr 2026", "May 2026", "Jun 2026"] as const;
export type Q2Month = (typeof Q2_MONTHS)[number];

export type Mode = "mtd" | "projection";

const MONTH_NUMBER: Record<Q2Month, number> = {
  "Apr 2026": 3,
  "May 2026": 4,
  "Jun 2026": 5,
};

const MONTH_DAYS: Record<Q2Month, number> = {
  "Apr 2026": 30,
  "May 2026": 31,
  "Jun 2026": 30,
};

const MONTH_FULL_NAME: Record<Q2Month, string> = {
  "Apr 2026": "APRIL",
  "May 2026": "MAY",
  "Jun 2026": "JUNE",
};

// Centralized eyebrow composer for time-scoped insight cards. Append
// the active month so a glance at the card tells the reader what
// window the numbers cover. Skip on rolling/cumulative cards (Cash
// Runway) and rolling-window cards (New Venues Profitable/Struggling
// run on a 30-90 day launch window, not the calendar month).
export function monthScopedTitle(base: string, month: Q2Month): string {
  return `${base} · ${MONTH_FULL_NAME[month]}`;
}

function monthStartFor(month: Q2Month): Date {
  return new Date(2026, MONTH_NUMBER[month], 1);
}

export function isFutureMonth(month: Q2Month, now: Date = new Date()): boolean {
  const todayMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return monthStartFor(month).getTime() > todayMonthStart.getTime();
}

export function getCurrentQ2Month(now: Date = new Date()): Q2Month | null {
  if (now.getFullYear() !== 2026) return null;
  const m = now.getMonth();
  for (const month of Q2_MONTHS) {
    if (MONTH_NUMBER[month] === m) return month;
  }
  return null;
}

export function startingCash(data: FinanceData): number {
  const v = data.config["starting_cash_q2_2026"];
  if (!v) return 80000;
  const parsed = parseFloat(v);
  return Number.isNaN(parsed) ? 80000 : parsed;
}

export function isCurrentQ2Month(month: Q2Month, now: Date = new Date()): boolean {
  return month === getCurrentQ2Month(now);
}
function isCurrentQ2(now: Date, month: Q2Month): boolean {
  return isCurrentQ2Month(month, now);
}

function dppExtrapolationFactor(month: Q2Month, now: Date): number {
  if (!isCurrentQ2(now, month)) return 1;
  const elapsed = now.getDate();
  if (elapsed <= 0) return 1;
  return MONTH_DAYS[month] / elapsed;
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
  // Projection mode: realized for active/past months, PROJECTION for future
  // months. Never blend the two — the active-month PROJECTION row covers the
  // gap between realized-to-date and end-of-month, but here we extrapolate
  // realized DPP via dppExtrapolationFactor instead, so PROJECTION rows for
  // active/past months would double-count.
  if (future) return all.filter((r) => r.source === "PROJECTION");
  return all.filter((r) => r.source !== "PROJECTION");
}

function applyDppExtrapolation<T extends { type: FinanceData["revenue"][number]["type"]; source: FinanceData["revenue"][number]["source"] }>(
  rows: T[],
  pickField: (r: T) => number,
  factor: number,
): number {
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

export function netRevenueFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  const rows = filterRevenueRows(data, month, mode, now);
  const factor =
    mode === "projection" ? dppExtrapolationFactor(month, now) : 1;
  return applyDppExtrapolation(rows, (r) => r.net, factor);
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
  return applyDppExtrapolation(rows, (r) => r.gross, factor);
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
  return applyDppExtrapolation(rows, (r) => r.fees, factor);
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

export function monthlyExpenseCategoryFor(
  data: FinanceData,
  month: Q2Month,
  key: "city_manager" | "marketing" | "equipment",
): number {
  return data.monthlyExpenses
    .filter((r) => r.month === month)
    .reduce((s, r) => s + r[key], 0);
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
  // All venue costs now flow through fieldCostsFor (one number,
  // override-aware). Manager Pay still has its own line below, so exclude
  // it here to avoid double-counting.
  const otherNonManagerPay = filterExpenseRows(data, month, mode, now)
    .filter((r) => r.category !== "Match Manager Pay")
    .reduce((s, r) => s + r.amount, 0);
  return (
    otherNonManagerPay +
    fieldCostsFor(data, month) +
    managerPayFor(data, month) +
    monthlyExpenseCategoryFor(data, month, "city_manager") +
    monthlyExpenseCategoryFor(data, month, "marketing") +
    monthlyExpenseCategoryFor(data, month, "equipment")
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
  mode: Mode,
  now: Date = new Date(),
): string[] {
  const cats = new Set<string>();
  for (const m of Q2_MONTHS) {
    for (const c of otherExpensesByCategoryFor(data, m, mode, now).keys()) {
      cats.add(c);
    }
  }
  // Match Manager Pay is rendered via its own dedicated row (managerPayFor)
  // and totalled separately, so don't surface it as a generic expense
  // category — would double-render in the Cash Flow widget.
  return [...cats].filter((c) => c !== "Match Manager Pay").sort();
}

export function distinctCitiesFromRevenue(data: FinanceData): string[] {
  // PROJECTION rows are topline placeholders not attributable to a market;
  // they're rendered through the company-wide totals row, not as a per-city
  // line, so we ignore them when building the per-city list.
  const cities = new Set<string>();
  for (const r of data.revenue) {
    if (r.source === "PROJECTION") continue;
    if ((Q2_MONTHS as readonly string[]).includes(r.month)) {
      cities.add(r.city);
    }
  }
  return [...cities].sort();
}

// ===== Q2 hero values (always projection mode) =====

export function q2NetRevenueProjected(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return Q2_MONTHS.reduce(
    (s, m) => s + netRevenueFor(data, m, "projection", now),
    0,
  );
}

export function q2ExpensesProjected(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return Q2_MONTHS.reduce(
    (s, m) => s + totalExpensesFor(data, m, "projection", now),
    0,
  );
}

export function q2NetPLProjected(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return q2NetRevenueProjected(data, now) - q2ExpensesProjected(data, now);
}

// "Closed-month actual" Q2 P&L for the hero subtitle. Includes each
// Q2 month that has started — past months at their final realized
// numbers, the current month at its full-month closed projection
// (realized + dated-but-not-yet-fired rows like the Apr 30 corporate
// salaries / last Thursday MMP). Future months contribute $0.
//
// Mechanism: for past + current months we just call netRevenueFor +
// totalExpensesFor in projection mode. filterRevenueRows in
// projection mode already excludes PROJECTION-source rows for
// past/current months and only returns PROJECTION for future months
// — so skipping future months gives us what we want without any
// extra source filter.
//
// Result is what you'd see in the Cash Flow page's per-month Net P&L
// row for the current month, summed across started months. Matches
// the operator mental model of "where does this quarter close" minus
// the May/Jun bootstrap estimates.
export function q2NetPLActualClosedMonth(
  data: FinanceData,
  now: Date = new Date(),
): number {
  let total = 0;
  for (const m of Q2_MONTHS) {
    if (isFutureMonth(m, now)) continue;
    total +=
      netRevenueFor(data, m, "projection", now) -
      totalExpensesFor(data, m, "projection", now);
  }
  return total;
}

export function projectedEndingCash(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return startingCash(data) + q2NetPLProjected(data, now);
}

// ===== Month-over-month deltas (for /admin/finance/cash-flow hero) =====

export type MoMDelta = {
  /** Category name (for expenses) or revenue type (for revenue). */
  label: string;
  /** Signed delta in dollars: nextMonth − currentMonth. */
  delta: number;
  /** Human-readable driver attribution. */
  driver: string;
  /**
   * True if either side of the comparison is sourced from
   * `source = 'PROJECTION'` rows in fin_revenue (always the case for
   * a future-month next side). Component uses this to render the (i)
   * caveat icon next to the subtitle.
   */
  driverFromProjection: boolean;
};

export type MonthOverMonthDeltas = {
  currentMonth: Q2Month | null;
  nextMonth: Q2Month | null;
  /** null when there's no nextMonth in Q2 (June currentMonth) or no currentMonth. */
  biggestExpenseDelta: MoMDelta | null;
  biggestRevenueDelta: MoMDelta | null;
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

// Per-type revenue map for a month in projection mode. For current/
// past months, sums realized non-PROJECTION rows with DPP × factor.
// For future months, sums PROJECTION rows by their declared type.
function revenueByType(
  data: FinanceData,
  month: Q2Month,
  now: Date,
): Map<string, number> {
  const future = isFutureMonth(month, now);
  const factor = dppExtrapolationFactor(month, now);
  const byType = new Map<string, number>();
  for (const r of data.revenue) {
    if (r.month !== month) continue;
    if (future ? r.source !== "PROJECTION" : r.source === "PROJECTION") continue;
    const v = r.net;
    const scaled =
      factor !== 1 && r.source !== "PROJECTION" && r.type === "DPP"
        ? v * factor
        : v;
    byType.set(r.type, (byType.get(r.type) ?? 0) + scaled);
  }
  return byType;
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
  const byCity = new Map<string, number>();
  for (const r of data.monthlyExpenses) {
    if (r.month !== month) continue;
    const v = r[key];
    if (v > 0) byCity.set(r.city, v);
  }
  return byCity;
}

// Driver string for revenue type. When nextMonth is a future month,
// its values come entirely from manually-seeded PROJECTION rows in
// fin_revenue — flag that honestly rather than fabricate venue-level
// attribution that doesn't exist on PROJECTION rows.
function revenueDriverString(
  type: string,
  nextMonth: Q2Month,
  nextIsFuture: boolean,
): { driver: string; fromProjection: boolean } {
  if (nextIsFuture) {
    return {
      driver: `${nextMonth.split(" ")[0]} target from PROJECTION estimate`,
      fromProjection: true,
    };
  }
  return { driver: `${type} mix shift`, fromProjection: false };
}

export function monthOverMonthDeltas(
  data: FinanceData,
  now: Date = new Date(),
): MonthOverMonthDeltas {
  const currentMonth = getCurrentQ2Month(now);
  const idx = currentMonth ? Q2_MONTHS.indexOf(currentMonth) : -1;
  const nextMonth =
    idx >= 0 && idx < Q2_MONTHS.length - 1 ? Q2_MONTHS[idx + 1] : null;

  if (!currentMonth || !nextMonth) {
    return {
      currentMonth,
      nextMonth: null,
      biggestExpenseDelta: null,
      biggestRevenueDelta: null,
      netDelta: null,
    };
  }

  // Expense side
  const expCur = expensesByCategory(data, currentMonth, now);
  const expNxt = expensesByCategory(data, nextMonth, now);
  const expCats = new Set<string>([...expCur.keys(), ...expNxt.keys()]);
  let topExp: MoMDelta | null = null;
  for (const cat of expCats) {
    const delta = (expNxt.get(cat) ?? 0) - (expCur.get(cat) ?? 0);
    if (!topExp || Math.abs(delta) > Math.abs(topExp.delta)) {
      topExp = {
        label: cat,
        delta,
        driver: expenseDriverString(data, cat, currentMonth, nextMonth),
        driverFromProjection: false,
      };
    }
  }

  // Revenue side
  const revCur = revenueByType(data, currentMonth, now);
  const revNxt = revenueByType(data, nextMonth, now);
  const revTypes = new Set<string>([...revCur.keys(), ...revNxt.keys()]);
  const nextIsFuture = isFutureMonth(nextMonth, now);
  let topRev: MoMDelta | null = null;
  for (const type of revTypes) {
    const delta = (revNxt.get(type) ?? 0) - (revCur.get(type) ?? 0);
    if (!topRev || Math.abs(delta) > Math.abs(topRev.delta)) {
      const { driver, fromProjection } = revenueDriverString(
        type,
        nextMonth,
        nextIsFuture,
      );
      topRev = {
        label: type,
        delta,
        driver,
        driverFromProjection: fromProjection,
      };
    }
  }

  // Net delta — sum revenue/expenses both sides for the headline
  const curRevTotal = [...revCur.values()].reduce((s, v) => s + v, 0);
  const curExpTotal = [...expCur.values()].reduce((s, v) => s + v, 0);
  const nxtRevTotal = [...revNxt.values()].reduce((s, v) => s + v, 0);
  const nxtExpTotal = [...expNxt.values()].reduce((s, v) => s + v, 0);
  const curNet = curRevTotal - curExpTotal;
  const nxtNet = nxtRevTotal - nxtExpTotal;

  return {
    currentMonth,
    nextMonth,
    biggestExpenseDelta: topExp,
    biggestRevenueDelta: topRev,
    netDelta: { current: curNet, next: nxtNet, delta: nxtNet - curNet },
  };
}

function isoDateLocal(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const dy = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${dy}`;
}

// Realized Q2 revenue booked through today: Stripe + Venmo rows
// (source != PROJECTION) with date <= today. No DPP extrapolation,
// no PROJECTION rows. The hero subtitle uses this as "actual" with
// projected = q2NetRevenueProjected - q2NetRevenueActual.
export function q2NetRevenueActual(
  data: FinanceData,
  now: Date = new Date(),
): number {
  const today = isoDateLocal(now);
  let sum = 0;
  for (const r of data.revenue) {
    if (!Q2_MONTHS.includes(r.month as Q2Month)) continue;
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

// Per-source actual breakdown for Q2 expenses. Useful for sanity
// checks and inspectors; q2ExpensesActual sums these.
export type Q2ExpensesActualBreakdown = {
  managerPay: number;       // fin_expenses category=Match Manager Pay, date <= today
  manualExpenses: number;   // all other fin_expenses, date <= today
  fieldCosts: number;       // schedule-driven by match date; overrides counted in full for past+current months
  monthlyExpenses: number;  // city_manager + marketing + equipment, past + current months
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
  if (!isCurrentQ2Month(month, now)) return fieldCostsFor(data, month);
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
      for (const s of data.schedule) {
        if (s.venue_raw !== v.raw_venue_name) continue;
        if (s.month !== month) continue;
        if (s.date > today) continue;
        total += (s.match_count ?? 0) * rate;
      }
    } else if (v.billing_type === "per_hour") {
      const rate = v.hourly_rate ?? 0;
      if (rate > 0) {
        for (const s of data.schedule) {
          if (s.venue_raw !== v.raw_venue_name) continue;
          if (s.month !== month) continue;
          if (s.date > today) continue;
          total += (s.total_hours ?? 0) * rate;
        }
      }
    }
    // no_charge / unknown: 0 contribution
  }
  return total;
}

// Sum of city_manager + marketing + equipment for a month.
// Past + current months count as actual (fin_monthly_expenses has
// no date column; presence of a row implies the bills are tracked).
// Future months: 0.
function monthlyExpensesActualFor(
  data: FinanceData,
  month: Q2Month,
  now: Date,
): number {
  if (isFutureMonth(month, now)) return 0;
  return (
    monthlyExpenseCategoryFor(data, month, "city_manager") +
    monthlyExpenseCategoryFor(data, month, "marketing") +
    monthlyExpenseCategoryFor(data, month, "equipment")
  );
}

// Realized Q2 expenses booked through today, classified by DATE
// (not month bucket) so current-month spend that's already happened
// counts as actual. Per-source classification:
//
//   fin_expenses (manual + imported):
//     date <= today → actual; else projected.
//     Includes Match Manager Pay (each Thursday cash-out is a
//     separately dated row), Subscriptions, Corporate Salaries, etc.
//   fieldCostsFor:
//     past month → fully actual.
//     current month → schedule-driven costs split by schedule row
//       date; override-driven costs (monthly_flat / lump_sum /
//       profit_share) counted in full as committed.
//     future month → projected.
//   monthlyExpenseCategoryFor (city_manager + marketing + equipment):
//     past + current month → actual (presence of row implies tracked).
//     future month → projected.
//
// projected = q2ExpensesProjected - q2ExpensesActual.
export function q2ExpensesActualBreakdown(
  data: FinanceData,
  now: Date = new Date(),
): Q2ExpensesActualBreakdown {
  const today = isoDateLocal(now);
  let managerPay = 0;
  let manualExpenses = 0;
  for (const r of data.expenses) {
    if (!Q2_MONTHS.includes(r.month as Q2Month)) continue;
    if (r.date > today) continue;
    if (r.category === "Match Manager Pay") managerPay += r.amount;
    else manualExpenses += r.amount;
  }
  let fieldCosts = 0;
  let monthlyExpenses = 0;
  for (const month of Q2_MONTHS) {
    fieldCosts += fieldCostsActualFor(data, month, now);
    monthlyExpenses += monthlyExpensesActualFor(data, month, now);
  }
  return {
    managerPay,
    manualExpenses,
    fieldCosts,
    monthlyExpenses,
    total: managerPay + manualExpenses + fieldCosts + monthlyExpenses,
  };
}

export function q2ExpensesActual(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return q2ExpensesActualBreakdown(data, now).total;
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

export function cityHasAnyQ2Activity(
  data: FinanceData,
  city: string,
): boolean {
  for (const m of Q2_MONTHS) {
    const grossRev = data.revenue
      .filter((r) => r.city === city && r.month === m)
      .reduce((s, r) => s + r.gross, 0);
    if (grossRev !== 0) return true;
    const exp = data.expenses
      .filter((r) => r.city === city && r.month === m)
      .reduce((s, r) => s + r.amount, 0);
    if (exp !== 0) return true;
    // (Manager Pay is in fin_expenses now, already covered by `exp` above —
    // legacy fin_manager_pay table is not consulted.)
    const me = data.monthlyExpenses.find(
      (r) => r.city === city && r.month === m,
    );
    if (me && (me.city_manager || me.marketing || me.equipment)) return true;
  }
  return false;
}

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

export function venueCostFor(
  data: FinanceData,
  city: string,
  venue: string,
  month: Q2Month,
): number {
  // Delegate to the canonical helper so per-(venue, month) overrides flow
  // through City P&L cards, Field Ranking, and any other consumer of this
  // function. Falls back to schedule.venue_cost only when no fin_venues row
  // matches (e.g. a venue name that exists in fin_schedule but isn't in
  // fin_venues yet).
  const venueRow = data.venues.find(
    (v) => v.city === city && v.venue_name === venue,
  );
  if (venueRow) {
    return canonicalVenueCost(data, venueRow.id, month).amount;
  }
  return data.schedule
    .filter((s) => s.city === city && s.venue === venue && s.month === month)
    .reduce((sum, s) => sum + (s.venue_cost ?? 0), 0);
}

export function venueMatchCountFor(
  data: FinanceData,
  city: string,
  venue: string,
  month: Q2Month,
): number {
  return data.schedule
    .filter((s) => s.city === city && s.venue === venue && s.month === month)
    .reduce((sum, s) => sum + (s.match_count ?? 0), 0);
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
  // Match Manager Pay sourced from fin_expenses (category='Match Manager
  // Pay'). Legacy fin_manager_pay table is no longer read.
  const matchManagerPay = data.expenses
    .filter(
      (r) =>
        r.city === city &&
        r.month === month &&
        r.category === "Match Manager Pay",
    )
    .reduce((s, r) => s + r.amount, 0);
  // City-tagged Misc rows roll up into the city's overhead. Misc rows
  // with city=null are company-wide and surface only in Cash Flow / Q2
  // hero, not on a CityPLCard — that's the deliberate split: city tag
  // on a Misc row means "attribute this expense to that city".
  const misc = data.expenses
    .filter(
      (r) =>
        r.city === city &&
        r.month === month &&
        r.category === "Misc",
    )
    .reduce((s, r) => s + r.amount, 0);
  const me = data.monthlyExpenses.find(
    (r) => r.city === city && r.month === month,
  );
  const cityManager = me?.city_manager ?? 0;
  const marketing = me?.marketing ?? 0;
  const equipment = me?.equipment ?? 0;
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
  for (const s of data.schedule) {
    if (s.city === city && s.month === month && s.venue) {
      venues.add(s.venue);
    }
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
  city: string,
  venue: string,
  month: Q2Month,
): VenueMemberSpotBreakdown {
  const row = data.memberSpots.find(
    (s) => s.city === city && s.venue === venue && s.month === month,
  );
  if (!row) return { member: 0, dpp: 0, other: 0, total: 0 };
  return {
    member: row.member_spots,
    dpp: row.dpp_spots,
    other: row.other_spots,
    total: row.member_spots + row.dpp_spots + row.other_spots,
  };
}

export function cityTotalMemberSpotsFor(
  data: FinanceData,
  city: string,
  month: Q2Month,
): number {
  return data.memberSpots
    .filter((s) => s.city === city && s.month === month)
    .reduce((sum, s) => sum + s.member_spots, 0);
}

export function venueAllocatedMemberRevenueFor(
  data: FinanceData,
  city: string,
  venue: string,
  month: Q2Month,
): number {
  const venueSpots = venueMemberSpotsFor(data, city, venue, month).member;
  const cityTotal = cityTotalMemberSpotsFor(data, city, month);
  if (cityTotal === 0) return 0;
  const cityMembership = cityMembershipRevenueFor(data, city, month);
  return (venueSpots / cityTotal) * cityMembership;
}

export type RankingRow = {
  venue: string;
  city: string;
  launchDate: string | null;
  launchedMs: number;
  dppRev: number;
  memberRev: number;
  cityMbrPct: number;
  mbrMixPct: number;
  dppMixPct: number;
  cost: number;
  matchCount: number;
  billingType: FinanceData["venues"][number]["billing_type"] | null;
  perMatchRate: number | null;
  monthlyFlat: number | null;
  netPL: number;
  margin: number;
};

export function buildRankingRows(
  data: FinanceData,
  month: Q2Month,
): RankingRow[] {
  const out: RankingRow[] = [];
  const groups = groupVenues(data.venues);

  for (const g of groups) {
    const primary = g.legs[0];
    // Sum revenue, cost, match counts across all legs. Each leg is queried
    // by its own venue_name so distinct-name legs (Case B) and same-name
    // legs (Case A) both work — same-name legs return identical sums but
    // are deduped by groupVenues bucketing.
    const legNames = new Set(g.legs.map((l) => l.venue_name));
    let dppRev = 0;
    let memberRev = 0;
    let cost = 0;
    let matchCount = 0;
    let memberSpots = 0;
    let dppSpots = 0;
    let otherSpots = 0;

    if (legNames.size === g.legs.length) {
      // Distinct-name legs: query each separately and sum.
      for (const leg of g.legs) {
        dppRev += venueDppRevenueFor(data, g.city, leg.venue_name, month);
        memberRev += venueAllocatedMemberRevenueFor(
          data,
          g.city,
          leg.venue_name,
          month,
        );
        cost += canonicalVenueCost(data, leg.id, month).amount;
        matchCount += venueMatchCountFor(data, g.city, leg.venue_name, month);
        const spots = venueMemberSpotsFor(data, g.city, leg.venue_name, month);
        memberSpots += spots.member;
        dppSpots += spots.dpp;
        otherSpots += spots.other;
      }
    } else {
      // Same-name legs (alias-collapsed): one query covers both. Cost still
      // sums per leg because rates differ.
      const name = primary.venue_name;
      dppRev = venueDppRevenueFor(data, g.city, name, month);
      memberRev = venueAllocatedMemberRevenueFor(data, g.city, name, month);
      matchCount = venueMatchCountFor(data, g.city, name, month);
      const spots = venueMemberSpotsFor(data, g.city, name, month);
      memberSpots = spots.member;
      dppSpots = spots.dpp;
      otherSpots = spots.other;
      for (const leg of g.legs) {
        cost += canonicalVenueCost(data, leg.id, month).amount;
      }
    }

    if (dppRev === 0 && memberRev === 0 && cost === 0) continue;

    const cityTotalMember = cityTotalMemberSpotsFor(data, g.city, month);
    const totalSpots = memberSpots + dppSpots + otherSpots;
    const cityMbrPct =
      cityTotalMember > 0 ? memberSpots / cityTotalMember : 0;
    const mbrMixPct = totalSpots > 0 ? memberSpots / totalSpots : 0;
    const dppMixPct = totalSpots > 0 ? dppSpots / totalSpots : 0;
    const totalRev = dppRev + memberRev;
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
      dppRev,
      memberRev,
      cityMbrPct,
      mbrMixPct,
      dppMixPct,
      cost,
      matchCount,
      billingType: primary.billing_type ?? null,
      perMatchRate: primary.per_match_rate,
      monthlyFlat: primary.monthly_flat,
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

export function tabToMonths(tab: "Q2" | "Apr" | "May" | "Jun"): Q2Month[] {
  if (tab === "Q2") return [...Q2_MONTHS];
  if (tab === "Apr") return ["Apr 2026"];
  if (tab === "May") return ["May 2026"];
  return ["Jun 2026"];
}

// ===== Phase 4 helpers: insight calculations =====

export type VenueInsightRow = {
  city: string;
  venue: string;
  dppRev: number;
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
  month: Q2Month,
  now: Date = new Date(),
): VenueInsightRow[] {
  const out: VenueInsightRow[] = [];
  for (const v of data.venues) {
    const dppRev = venueDppRevenueFor(data, v.city, v.venue_name, month);
    const memberRev = venueAllocatedMemberRevenueFor(
      data,
      v.city,
      v.venue_name,
      month,
    );
    const cost = venueCostFor(data, v.city, v.venue_name, month);
    const spots = venueMemberSpotsFor(data, v.city, v.venue_name, month);
    if (
      dppRev === 0 &&
      memberRev === 0 &&
      cost === 0 &&
      spots.total === 0
    ) {
      continue;
    }
    out.push({
      city: v.city,
      venue: v.venue_name,
      dppRev,
      memberRev,
      cost,
      net: dppRev + memberRev - cost,
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
    fieldNetByCity.set(r.city, (fieldNetByCity.get(r.city) ?? 0) + (r.dppRev - r.cost));
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

const Q2_MONTH_PREFIX: Record<Q2Month, string> = {
  "Apr 2026": "2026-04",
  "May 2026": "2026-05",
  "Jun 2026": "2026-06",
};

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
  const monthPrefix = Q2_MONTH_PREFIX[month];
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
