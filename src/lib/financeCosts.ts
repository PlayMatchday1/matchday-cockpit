// Shared, override-aware venue cost helpers. The Field Costs page, Monthly
// Cash Flow, City P&L cards, Field Ranking and hero metrics all derive
// venue-side cost numbers from here so an override flips a single source of
// truth.

import type {
  FinanceData,
  FinVenue,
  FinVenueCostOverride,
} from "./useFinanceData";
import type { Q2Month } from "./financeStats";

export type VenueCostKind =
  | "override"
  | "per_match"
  | "monthly_flat"
  | "per_hour_no_fee"
  | "per_hour_metered"
  | "unknown";

export type VenueCostInfo = {
  amount: number;
  kind: VenueCostKind;
  matchCount: number;
  totalHours: number;
  formula: string;
  source: string;
  override: FinVenueCostOverride | null;
};

const VENUE_RENTAL_RX = /venue\s*rental/i;

export function findOverride(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): FinVenueCostOverride | null {
  return (
    data.overrides.find((o) => o.venue_id === venueId && o.month === month) ??
    null
  );
}

function venueMatchCount(
  data: FinanceData,
  venue: FinVenue,
  month: Q2Month,
): number {
  return data.schedule
    .filter((s) => s.venue === venue.venue_name && s.month === month)
    .reduce((sum, s) => sum + (s.match_count ?? 0), 0);
}

function venueTotalHours(
  data: FinanceData,
  venue: FinVenue,
  month: Q2Month,
): number {
  return data.schedule
    .filter((s) => s.venue === venue.venue_name && s.month === month)
    .reduce((sum, s) => sum + (s.total_hours ?? 0), 0);
}

function monthlyFlatExpenseSum(
  data: FinanceData,
  venue: FinVenue,
  month: Q2Month,
): number {
  return data.expenses
    .filter(
      (e) =>
        e.month === month &&
        VENUE_RENTAL_RX.test(e.category) &&
        (e.vendor ?? "") === venue.venue_name,
    )
    .reduce((sum, e) => sum + e.amount, 0);
}

function autoCost(
  data: FinanceData,
  venue: FinVenue,
  month: Q2Month,
): VenueCostInfo {
  if (venue.billing_type === "per_match") {
    const matchCount = venueMatchCount(data, venue, month);
    const rate = venue.per_match_rate ?? 0;
    const amount = matchCount * rate;
    return {
      amount,
      kind: "per_match",
      matchCount,
      totalHours: 0,
      formula:
        matchCount > 0
          ? `${matchCount} ${matchCount === 1 ? "match" : "matches"} × $${rate}`
          : "No matches scheduled",
      source: "Auto from schedule",
      override: null,
    };
  }
  if (venue.billing_type === "monthly_flat") {
    const amount = monthlyFlatExpenseSum(data, venue, month);
    return {
      amount,
      kind: "monthly_flat",
      matchCount: venueMatchCount(data, venue, month),
      totalHours: 0,
      formula:
        amount > 0
          ? `Monthly flat (from fin_expenses · vendor=${venue.venue_name})`
          : "No matching fin_expenses entry",
      source: "fin_expenses · Venue Rental",
      override: null,
    };
  }
  if (venue.billing_type === "per_hour") {
    const totalHours = venueTotalHours(data, venue, month);
    if (!venue.hourly_rate || venue.hourly_rate <= 0) {
      return {
        amount: 0,
        kind: "per_hour_no_fee",
        matchCount: venueMatchCount(data, venue, month),
        totalHours,
        formula: "No venue fee",
        source: venue.notes ?? "Per-hour with no rate",
        override: null,
      };
    }
    const amount = totalHours * venue.hourly_rate;
    return {
      amount,
      kind: "per_hour_metered",
      matchCount: venueMatchCount(data, venue, month),
      totalHours,
      formula: `${totalHours} hr × $${venue.hourly_rate}`,
      source: "Auto from schedule",
      override: null,
    };
  }
  return {
    amount: 0,
    kind: "unknown",
    matchCount: 0,
    totalHours: 0,
    formula: "No billing model on file",
    source: "—",
    override: null,
  };
}

export function canonicalVenueCost(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): VenueCostInfo {
  const venue = data.venues.find((v) => v.id === venueId);
  if (!venue) {
    return {
      amount: 0,
      kind: "unknown",
      matchCount: 0,
      totalHours: 0,
      formula: "Venue not found",
      source: "—",
      override: null,
    };
  }
  const override = findOverride(data, venueId, month);
  if (override) {
    return {
      amount: override.override_amount,
      kind: "override",
      matchCount: venueMatchCount(data, venue, month),
      totalHours: venueTotalHours(data, venue, month),
      formula: override.reason ?? "Override (no reason given)",
      source: `Override · set by ${override.created_by} on ${override.created_at.slice(0, 10)}`,
      override,
    };
  }
  return autoCost(data, venue, month);
}

// Sums per-billing-type, override-aware. Used by Cash Flow + hero metrics +
// reconciliation.

export function perMatchTotalFor(
  data: FinanceData,
  month: Q2Month,
): number {
  let total = 0;
  for (const v of data.venues) {
    if (v.billing_type !== "per_match") continue;
    total += canonicalVenueCost(data, v.id, month).amount;
  }
  return total;
}

export function monthlyFlatTotalFor(
  data: FinanceData,
  month: Q2Month,
): number {
  let total = 0;
  for (const v of data.venues) {
    if (v.billing_type !== "monthly_flat") continue;
    total += canonicalVenueCost(data, v.id, month).amount;
  }
  return total;
}

export function perHourTotalFor(
  data: FinanceData,
  month: Q2Month,
): number {
  let total = 0;
  for (const v of data.venues) {
    if (v.billing_type !== "per_hour") continue;
    total += canonicalVenueCost(data, v.id, month).amount;
  }
  return total;
}

// "Venue Rental" line for Cash Flow, override-aware:
//   sum of canonical cost for monthly_flat venues (override-aware)
//   + fin_expenses category=Venue Rental rows that are NOT for a monthly_flat
//     venue (one-off field charges entered manually)
export function venueRentalLineFor(
  data: FinanceData,
  month: Q2Month,
): number {
  const monthlyFlatVendors = new Set(
    data.venues
      .filter((v) => v.billing_type === "monthly_flat")
      .map((v) => v.venue_name),
  );
  const oneOffSum = data.expenses
    .filter(
      (e) =>
        e.month === month &&
        VENUE_RENTAL_RX.test(e.category) &&
        !monthlyFlatVendors.has(e.vendor ?? ""),
    )
    .reduce((s, e) => s + e.amount, 0);
  return monthlyFlatTotalFor(data, month) + oneOffSum;
}

// One-off field charges = fin_expenses · category Venue Rental NOT for any
// monthly_flat venue. Used by the Field Costs reconciliation footer.
export function oneOffFieldCostsFor(
  data: FinanceData,
  month: Q2Month,
): number {
  const monthlyFlatVendors = new Set(
    data.venues
      .filter((v) => v.billing_type === "monthly_flat")
      .map((v) => v.venue_name),
  );
  return data.expenses
    .filter(
      (e) =>
        e.month === month &&
        VENUE_RENTAL_RX.test(e.category) &&
        !monthlyFlatVendors.has(e.vendor ?? ""),
    )
    .reduce((s, e) => s + e.amount, 0);
}

export function totalOverrideAmountFor(
  data: FinanceData,
  month: Q2Month,
): { amount: number; venueCount: number } {
  let amount = 0;
  const venueIds = new Set<number>();
  for (const o of data.overrides) {
    if (o.month !== month) continue;
    amount += o.override_amount;
    venueIds.add(o.venue_id);
  }
  return { amount, venueCount: venueIds.size };
}

// ATH Katy combine helpers — used only by the Field Costs page UI. Other
// pages keep treating ATH Katy + ATH Katy Sunday as separate venues so the
// company-wide aggregation stays correct.

export const ATH_KATY_PRIMARY_NAME = "ATH Katy";
export const ATH_KATY_SUNDAY_NAME = "ATH Katy Sunday";

export function findAthKatyPair(
  data: FinanceData,
): { primary: FinVenue; sunday: FinVenue } | null {
  const primary = data.venues.find(
    (v) => v.venue_name === ATH_KATY_PRIMARY_NAME,
  );
  const sunday = data.venues.find(
    (v) => v.venue_name === ATH_KATY_SUNDAY_NAME,
  );
  if (!primary || !sunday) return null;
  return { primary, sunday };
}

export type FieldCostRow = {
  key: string;
  displayName: string;
  city: string;
  billingType: FinVenue["billing_type"] | null;
  primaryVenueId: number;
  secondaryVenueIds: number[];
  amount: number;
  matchCount: number;
  totalHours: number;
  formula: string;
  source: string;
  override: FinVenueCostOverride | null;
  autoAmount: number;
  autoFormula: string;
  // Per-leg auto-cost detail for the ATH Katy combined row (and any future
  // multi-leg combines): used both for the formula and for the click-expand
  // schedule breakdown.
  legs: Array<{
    venueId: number;
    venueName: string;
    matchCount: number;
    rate: number;
    autoAmount: number;
  }>;
};

export function buildFieldCostRows(
  data: FinanceData,
  month: Q2Month,
): FieldCostRow[] {
  const rows: FieldCostRow[] = [];
  const skip = new Set<number>();
  const pair = findAthKatyPair(data);

  for (const v of data.venues) {
    if (skip.has(v.id)) continue;

    if (pair && v.id === pair.primary.id) {
      // ATH Katy combine
      skip.add(pair.sunday.id);
      const primaryAuto = autoCost(data, pair.primary, month);
      const sundayAuto = autoCost(data, pair.sunday, month);
      const override = findOverride(data, pair.primary.id, month);
      const autoAmount = primaryAuto.amount + sundayAuto.amount;
      const matchCount = primaryAuto.matchCount + sundayAuto.matchCount;
      const autoFormula =
        primaryAuto.matchCount > 0 || sundayAuto.matchCount > 0
          ? `${primaryAuto.matchCount} weekday × $${pair.primary.per_match_rate ?? 0} + ${sundayAuto.matchCount} Sunday × $${pair.sunday.per_match_rate ?? 0} = $${autoAmount.toLocaleString("en-US")}`
          : "No matches scheduled";
      rows.push({
        key: `combined-${pair.primary.id}`,
        displayName: ATH_KATY_PRIMARY_NAME,
        city: pair.primary.city,
        billingType: pair.primary.billing_type,
        primaryVenueId: pair.primary.id,
        secondaryVenueIds: [pair.sunday.id],
        amount: override ? override.override_amount : autoAmount,
        matchCount,
        totalHours: 0,
        formula: override
          ? (override.reason ?? "Override (no reason given)")
          : autoFormula,
        source: override
          ? `Override · set by ${override.created_by} on ${override.created_at.slice(0, 10)}`
          : "Auto from schedule",
        override,
        autoAmount,
        autoFormula,
        legs: [
          {
            venueId: pair.primary.id,
            venueName: pair.primary.venue_name,
            matchCount: primaryAuto.matchCount,
            rate: pair.primary.per_match_rate ?? 0,
            autoAmount: primaryAuto.amount,
          },
          {
            venueId: pair.sunday.id,
            venueName: pair.sunday.venue_name,
            matchCount: sundayAuto.matchCount,
            rate: pair.sunday.per_match_rate ?? 0,
            autoAmount: sundayAuto.amount,
          },
        ],
      });
      continue;
    }

    const info = canonicalVenueCost(data, v.id, month);
    const autoOnly = autoCost(data, v, month);
    rows.push({
      key: `single-${v.id}`,
      displayName: v.venue_name,
      city: v.city,
      billingType: v.billing_type,
      primaryVenueId: v.id,
      secondaryVenueIds: [],
      amount: info.amount,
      matchCount: info.matchCount,
      totalHours: info.totalHours,
      formula: info.formula,
      source: info.source,
      override: info.override,
      autoAmount: autoOnly.amount,
      autoFormula: autoOnly.formula,
      legs:
        v.billing_type === "per_match"
          ? [
              {
                venueId: v.id,
                venueName: v.venue_name,
                matchCount: autoOnly.matchCount,
                rate: v.per_match_rate ?? 0,
                autoAmount: autoOnly.amount,
              },
            ]
          : [],
    });
  }

  return rows;
}
