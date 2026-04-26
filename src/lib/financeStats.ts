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

function monthStartFor(month: Q2Month): Date {
  return new Date(2026, MONTH_NUMBER[month], 1);
}

function isFutureMonth(month: Q2Month, now: Date): boolean {
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
  const future = isFutureMonth(month, now);

  if (mode === "mtd") {
    if (future) return [];
    return all.filter((r) => r.source !== "PROJECTION");
  }
  // Projection mode: keep everything for the requested month, regardless of
  // the row's specific date. Dates in this dataset are end-of-month buckets,
  // not transaction dates — month membership is what makes a row "realized".
  return all;
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
  return byCity;
}

function filterExpenseRows(
  data: FinanceData,
  month: Q2Month,
  mode: Mode,
  now: Date,
) {
  const all = data.expenses.filter((r) => r.month === month);
  if (mode === "mtd" && isFutureMonth(month, now)) return [];
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
  for (const r of data.revenue) {
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

export function projectedEndingCash(
  data: FinanceData,
  now: Date = new Date(),
): number {
  return startingCash(data) + q2NetPLProjected(data, now);
}

// ===== Phase 3 helpers: city cards + field ranking =====

export const CITY_DISPLAY_ORDER = [
  "Austin",
  "Houston",
  "San Antonio",
  "Dallas",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
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
    const mp = data.managerPay
      .filter((r) => r.city === city && r.month === m)
      .reduce((s, r) => s + r.amount, 0);
    if (mp !== 0) return true;
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
  total: number;
};

export function cityOverheadFor(
  data: FinanceData,
  city: string,
  month: Q2Month,
): CityOverhead {
  const matchManagerPay = data.managerPay
    .filter((r) => r.city === city && r.month === month)
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
    total: matchManagerPay + cityManager + marketing + equipment,
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
  for (const v of data.venues) {
    const dppRev = venueDppRevenueFor(data, v.city, v.venue_name, month);
    const memberRev = venueAllocatedMemberRevenueFor(
      data,
      v.city,
      v.venue_name,
      month,
    );
    const cost = venueCostFor(data, v.city, v.venue_name, month);
    const matchCount = venueMatchCountFor(data, v.city, v.venue_name, month);

    if (dppRev === 0 && memberRev === 0 && cost === 0) continue;

    const spots = venueMemberSpotsFor(data, v.city, v.venue_name, month);
    const cityTotalMember = cityTotalMemberSpotsFor(data, v.city, month);
    const cityMbrPct = cityTotalMember > 0 ? spots.member / cityTotalMember : 0;
    const mbrMixPct = spots.total > 0 ? spots.member / spots.total : 0;
    const dppMixPct = spots.total > 0 ? spots.dpp / spots.total : 0;
    const totalRev = dppRev + memberRev;
    const netPL = totalRev - cost;
    const margin = totalRev > 0 ? netPL / totalRev : 0;

    let launchedMs = Number.POSITIVE_INFINITY;
    if (v.launch_date) {
      const d = new Date(v.launch_date);
      if (!Number.isNaN(d.getTime())) launchedMs = d.getTime();
    }

    out.push({
      venue: v.venue_name,
      city: v.city,
      launchDate: v.launch_date,
      launchedMs,
      dppRev,
      memberRev,
      cityMbrPct,
      mbrMixPct,
      dppMixPct,
      cost,
      matchCount,
      billingType: v.billing_type ?? null,
      perMatchRate: v.per_match_rate,
      monthlyFlat: v.monthly_flat,
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
