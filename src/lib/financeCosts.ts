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
import { getLegLabel, groupVenues, type VenueGroup } from "./venueGroups";

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
  // Filter on venue_raw / raw_venue_name so split-rate venues (e.g. ATH Katy
  // weekday + ATH Katy Sunday) are accounted per-leg even when an alias
  // collapses their canonical names. For non-split venues raw and canonical
  // are identical, so this is a no-op in the common case.
  return data.schedule
    .filter(
      (s) => s.venue_raw === venue.raw_venue_name && s.month === month,
    )
    .reduce((sum, s) => sum + (s.match_count ?? 0), 0);
}

function venueTotalHours(
  data: FinanceData,
  venue: FinVenue,
  month: Q2Month,
): number {
  return data.schedule
    .filter(
      (s) => s.venue_raw === venue.raw_venue_name && s.month === month,
    )
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

// Field Costs row builder — one row per VenueGroup (ATH Katy + ATH Katy
// Sunday merge into a single "ATH Katy" row via groupVenues). Per-leg
// breakdown is preserved on the row for the formula text and the click-
// expand schedule view.

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
  legs: Array<{
    venueId: number;
    venueName: string;       // canonical (post-alias)
    rawVenueName: string;    // pre-alias — keys schedule rows back to the
                             // correct leg when aliases collapse the names.
    matchCount: number;
    rate: number;
    autoAmount: number;
  }>;
};

function combinedAutoFormula(
  group: VenueGroup,
  legAutos: ReturnType<typeof autoCost>[],
): string {
  const parts: string[] = [];
  let total = 0;
  for (let i = 0; i < group.legs.length; i++) {
    const leg = group.legs[i];
    const auto = legAutos[i];
    const rate = leg.per_match_rate ?? 0;
    total += auto.amount;
    if (auto.matchCount > 0) {
      parts.push(
        `${auto.matchCount} ${getLegLabel(group, i)} × $${rate}`,
      );
    }
  }
  if (parts.length === 0) return "No matches scheduled";
  return `${parts.join(" + ")} = $${total.toLocaleString("en-US")}`;
}

export function buildFieldCostRows(
  data: FinanceData,
  month: Q2Month,
): FieldCostRow[] {
  const groups = groupVenues(data.venues);
  const rows: FieldCostRow[] = [];

  for (const g of groups) {
    const primary = g.legs[0];

    if (g.isCombined) {
      const legAutos = g.legs.map((l) => autoCost(data, l, month));
      const autoAmount = legAutos.reduce((s, a) => s + a.amount, 0);
      const matchCount = legAutos.reduce((s, a) => s + a.matchCount, 0);
      const totalHours = legAutos.reduce((s, a) => s + a.totalHours, 0);
      const autoFormula = combinedAutoFormula(g, legAutos);
      // The combined row's override target is the primary leg. Wave 2.5's
      // override-write logic mirrors $0 onto the secondary legs so summed
      // canonicalVenueCost stays correct everywhere.
      const override = findOverride(data, primary.id, month);
      rows.push({
        key: `combined-${primary.id}`,
        displayName: g.displayName,
        city: g.city,
        billingType: primary.billing_type,
        primaryVenueId: primary.id,
        secondaryVenueIds: g.legs.slice(1).map((l) => l.id),
        amount: override ? override.override_amount : autoAmount,
        matchCount,
        totalHours,
        formula: override
          ? (override.reason ?? "Override (no reason given)")
          : autoFormula,
        source: override
          ? `Override · set by ${override.created_by} on ${override.created_at.slice(0, 10)}`
          : "Auto from schedule",
        override,
        autoAmount,
        autoFormula,
        legs: g.legs.map((leg, i) => ({
          venueId: leg.id,
          venueName: leg.venue_name,
          rawVenueName: leg.raw_venue_name,
          matchCount: legAutos[i].matchCount,
          rate: leg.per_match_rate ?? 0,
          autoAmount: legAutos[i].amount,
        })),
      });
      continue;
    }

    const info = canonicalVenueCost(data, primary.id, month);
    const autoOnly = autoCost(data, primary, month);
    rows.push({
      key: `single-${primary.id}`,
      displayName: primary.venue_name,
      city: primary.city,
      billingType: primary.billing_type,
      primaryVenueId: primary.id,
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
        primary.billing_type === "per_match"
          ? [
              {
                venueId: primary.id,
                venueName: primary.venue_name,
                rawVenueName: primary.raw_venue_name,
                matchCount: autoOnly.matchCount,
                rate: primary.per_match_rate ?? 0,
                autoAmount: autoOnly.amount,
              },
            ]
          : [],
    });
  }

  return rows;
}
