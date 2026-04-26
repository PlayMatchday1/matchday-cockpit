import type { FinanceData } from "./useFinanceData";
import {
  canonicalVenueCost,
  perMatchTotalFor,
  venueRentalLineFor,
} from "./financeCosts";
import { groupVenues } from "./venueGroups";

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
  // Pull "Venue Rental" out of the generic expenses sum and replace with the
  // override-aware total, so hero metrics agree with the Field Costs page.
  const venueRentalRx = /venue\s*rental/i;
  const otherNonVenueRental = filterExpenseRows(data, month, mode, now)
    .filter((r) => !venueRentalRx.test(r.category))
    .reduce((s, r) => s + r.amount, 0);
  return (
    otherNonVenueRental +
    venueRentalLineFor(data, month) +
    managerPayFor(data, month) +
    monthlyExpenseCategoryFor(data, month, "city_manager") +
    monthlyExpenseCategoryFor(data, month, "marketing") +
    monthlyExpenseCategoryFor(data, month, "equipment") +
    perMatchVenueCostFor(data, month)
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

export function zeroCostWinners(rows: VenueInsightRow[]): VenueInsightRow[] {
  return rows
    .filter((r) => r.cost === 0 && r.dppRev + r.memberRev >= 1000)
    .sort((a, b) => b.dppRev + b.memberRev - (a.dppRev + a.memberRev));
}

export function memberHeavyFields(rows: VenueInsightRow[]): VenueInsightRow[] {
  return rows
    .filter((r) => {
      if (r.spots.total < 30) return false;
      const mix = r.spots.member / r.spots.total;
      return mix >= 0.5;
    })
    .sort(
      (a, b) =>
        b.spots.member / Math.max(1, b.spots.total) -
        a.spots.member / Math.max(1, a.spots.total),
    );
}

export function highPromoUsageFields(
  rows: VenueInsightRow[],
): VenueInsightRow[] {
  return rows
    .filter((r) => {
      if (r.spots.total < 30) return false;
      const mix = r.spots.other / r.spots.total;
      return mix > 0.2;
    })
    .sort(
      (a, b) =>
        b.spots.other / Math.max(1, b.spots.total) -
        a.spots.other / Math.max(1, a.spots.total),
    );
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

export type SpotMixSummary = {
  member: number;
  dpp: number;
  other: number;
  total: number;
  memberPct: number;
  dppPct: number;
  otherPct: number;
};

export function companySpotMix(
  data: FinanceData,
  month: Q2Month,
): SpotMixSummary {
  let member = 0;
  let dpp = 0;
  let other = 0;
  for (const r of data.memberSpots) {
    if (r.month !== month) continue;
    member += r.member_spots;
    dpp += r.dpp_spots;
    other += r.other_spots;
  }
  const total = member + dpp + other;
  return {
    member,
    dpp,
    other,
    total,
    memberPct: total > 0 ? member / total : 0,
    dppPct: total > 0 ? dpp / total : 0,
    otherPct: total > 0 ? other / total : 0,
  };
}

export type CashRunwayInfo = {
  state: "near_breakeven" | "burning" | "profitable";
  monthlyNet: number;
  currentCash: number;
  runwayMonths: number | null;
};

export function cashRunway(
  data: FinanceData,
  now: Date = new Date(),
): CashRunwayInfo {
  const netByMonth = Q2_MONTHS.map((m) => netPLFor(data, m, "projection", now));
  const monthlyNet = netByMonth.reduce((s, n) => s + n, 0) / Q2_MONTHS.length;
  const currentCash = startingCash(data) + q2NetPLProjected(data, now);
  if (Math.abs(monthlyNet) <= 500) {
    return {
      state: "near_breakeven",
      monthlyNet,
      currentCash,
      runwayMonths: null,
    };
  }
  if (monthlyNet > 0) {
    return {
      state: "profitable",
      monthlyNet,
      currentCash,
      runwayMonths: null,
    };
  }
  const burn = Math.abs(monthlyNet);
  const runway = currentCash > 0 ? currentCash / burn : 0;
  return {
    state: "burning",
    monthlyNet,
    currentCash,
    runwayMonths: runway,
  };
}

export type MembershipHealthVerdict =
  | "strong"
  | "break_even_plus"
  | "marginal"
  | "overpaying";

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
  return (
    data.members.length > 0 &&
    data.memberSpots.length > 0 &&
    data.pricing.length > 0
  );
}

export function buildMembershipHealthRows(
  data: FinanceData,
  month: Q2Month,
): MembershipHealthRow[] {
  if (!membershipHealthAvailable(data)) return [];

  const memberCountByCity = new Map<string, number>();
  const memberPriceTotalByCity = new Map<string, number>();
  for (const m of data.members) {
    if (m.status !== "ACTIVE") continue;
    if (m.price_cents <= 0) continue;
    memberCountByCity.set(m.city, (memberCountByCity.get(m.city) ?? 0) + 1);
    memberPriceTotalByCity.set(
      m.city,
      (memberPriceTotalByCity.get(m.city) ?? 0) + m.price_cents,
    );
  }

  const pricingByVenue = new Map<string, { dpp: number; member: number }>();
  for (const p of data.pricing) {
    pricingByVenue.set(p.venue_name, {
      dpp: p.dpp_price,
      member: p.member_price,
    });
  }

  const cities = [...memberCountByCity.keys()];
  const out: MembershipHealthRow[] = [];

  for (const city of cities) {
    const members = memberCountByCity.get(city) ?? 0;
    if (members < 5) continue;

    let weightedDppNumer = 0;
    let weightedDppDenom = 0;
    let cityMemberSpots = 0;

    for (const s of data.memberSpots) {
      if (s.city !== city || s.month !== month) continue;
      const venueSpots = s.member_spots;
      if (venueSpots <= 0) continue;
      cityMemberSpots += venueSpots;
      const venuePricing = pricingByVenue.get(s.venue);
      if (venuePricing && venuePricing.dpp > 0) {
        weightedDppNumer += venuePricing.dpp * venueSpots;
        weightedDppDenom += venueSpots;
      }
    }

    const weightedDpp =
      weightedDppDenom > 0 ? weightedDppNumer / weightedDppDenom : 0;
    const memberPriceCents = (memberPriceTotalByCity.get(city) ?? 0) / members;
    const memberPriceDollars = memberPriceCents / 100;
    const breakEven = weightedDpp > 0 ? memberPriceDollars / weightedDpp : 0;
    const actualMatchesPerMember = members > 0 ? cityMemberSpots / members : 0;
    const ratio = breakEven > 0 ? actualMatchesPerMember / breakEven : 0;

    let verdict: MembershipHealthVerdict;
    if (ratio >= 1.5) verdict = "strong";
    else if (ratio >= 1) verdict = "break_even_plus";
    else if (ratio >= 0.7) verdict = "marginal";
    else verdict = "overpaying";

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

  return out.sort((a, b) => b.ratio - a.ratio);
}
