import type { FinanceData } from "./useFinanceData";

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

function parseLocalDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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

function isCurrentQ2(now: Date, month: Q2Month): boolean {
  return month === getCurrentQ2Month(now);
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

  let result: typeof all;
  let branch: string;

  if (mode === "mtd") {
    branch = "mtd";
    const today = startOfDay(now);
    result = all.filter((r) => {
      if (r.source === "PROJECTION") return false;
      const d = parseLocalDate(r.date);
      return d !== null && d.getTime() <= today.getTime();
    });
  } else if (isCurrentQ2(now, month)) {
    branch = "projection-current";
    const today = startOfDay(now);
    result = all.filter((r) => {
      if (r.source === "PROJECTION") return true;
      const d = parseLocalDate(r.date);
      return d !== null && d.getTime() <= today.getTime();
    });
  } else {
    branch = "projection-passthrough";
    result = all;
  }

  if (typeof window !== "undefined") {
    console.log("[FIN] filterRevenueRows", {
      month,
      mode,
      branch,
      now: now.toISOString(),
      currentQ2: getCurrentQ2Month(now),
      totalRevenueRows: data.revenue.length,
      monthMatchCount: all.length,
      afterFilterCount: result.length,
      monthMatchCities: [...new Set(all.map((r) => r.city))],
      resultCities: [...new Set(result.map((r) => r.city))],
      droppedRows:
        all.length !== result.length
          ? all
              .filter((r) => !result.includes(r))
              .slice(0, 5)
              .map((r) => ({
                city: r.city,
                source: r.source,
                date: r.date,
                net: r.net,
              }))
          : [],
    });
  }

  return result;
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
  const rows = filterRevenueRows(data, month, mode, now);
  const factor =
    mode === "projection" ? dppExtrapolationFactor(month, now) : 1;

  const byCity = new Map<string, number>();
  for (const r of rows) {
    const isExtrap = factor !== 1 && r.source !== "PROJECTION" && r.type === "DPP";
    const value = isExtrap ? r.net * factor : r.net;
    byCity.set(r.city, (byCity.get(r.city) ?? 0) + value);
  }

  if (typeof window !== "undefined") {
    console.log("[FIN] netRevenueByCityFor", {
      month,
      mode,
      factor,
      rowCount: rows.length,
      byCity: Object.fromEntries(byCity),
    });
  }

  return byCity;
}

function filterExpenseRows(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date,
) {
  const all = data.expenses.filter((r) => r.month === month);
  if (mode === "mtd") {
    const today = startOfDay(now);
    return all.filter((r) => {
      const d = parseLocalDate(r.date);
      return d !== null && d.getTime() <= today.getTime();
    });
  }
  return all;
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
  return data.managerPay
    .filter((r) => r.month === month)
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

export function totalExpensesFor(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date = new Date(),
): number {
  return (
    otherExpensesFor(data, month, mode, now) +
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
  return [...cats].sort();
}

export function distinctCitiesFromRevenue(data: FinanceData): string[] {
  const cities = new Set<string>();
  let matched = 0;
  let unmatched = 0;
  const unmatchedMonths = new Set<string>();
  for (const r of data.revenue) {
    if ((Q2_MONTHS as readonly string[]).includes(r.month)) {
      cities.add(r.city);
      matched++;
    } else {
      unmatched++;
      unmatchedMonths.add(JSON.stringify(r.month));
    }
  }
  const list = [...cities].sort();

  if (typeof window !== "undefined") {
    console.log("[FIN] distinctCitiesFromRevenue", {
      matched,
      unmatched,
      cities: list,
      Q2_MONTHS,
      unmatchedMonthValues: [...unmatchedMonths],
    });
  }

  return list;
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

export function projectedEndingCash(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return startingCash(data) + q2NetPLProjected(data, now);
}
