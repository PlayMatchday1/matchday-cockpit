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
import { isCityHidden } from "./types";
import { partnerPaymentOwedForMonth } from "./partnerStats";

export type VenueCostKind =
  | "override"
  | "per_match"
  | "per_match_minus_manager"
  | "monthly_flat"
  | "profit_share"
  | "needs_override"
  | "unknown";

// Crossbar Rowlett's model: it's billed as `per_match` with a null rate,
// but its cost is the partner-dashboard "owed" — match revenue minus a
// per-match manager fee, floored at $0 monthly. That owed comes from the
// same computeWeeklyPayments the partner page renders (via
// partnerPaymentOwedForMonth), so Finance Cities / Field Ranking can't
// drift from the dashboard. Returns null when the venue has no
// per_match_minus_manager dashboard (i.e. every other venue), so callers
// fall through to their normal per_match / cost_per_match logic.
export function perMatchMinusManagerOwed(
  data: FinanceData,
  venueId: number,
  month: Q2Month,
): number | null {
  const dash = data.partnerDashboards.find((d) => d.venueId === venueId);
  if (dash?.revenueModel !== "per_match_minus_manager") return null;
  return (
    partnerPaymentOwedForMonth(
      data.partnerDashboards,
      data.partnerPayoutsByVenueMonth,
      venueId,
      month,
    ) ?? 0
  );
}

export type VenueCostInfo = {
  amount: number;
  kind: VenueCostKind;
  matchCount: number;
  totalHours: number;
  formula: string;
  source: string;
  override: FinVenueCostOverride | null;
};

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
  // Cost-driving count: alive matches in masterSchedule plus cancelled
  // matches the venue charges for (only when venue.charge_on_cancel is
  // true). venue_id pre-resolved on both arrays in useFinanceData,
  // split-rate routing included.
  let n = 0;
  for (const s of data.masterSchedule) {
    if (s.venue_id === venue.id && s.month === month) n += 1;
  }
  if (venue.charge_on_cancel) {
    for (const s of data.cancelledSchedule) {
      if (s.venue_id === venue.id && s.month === month) n += 1;
    }
  }
  return n;
}

function autoCost(
  data: FinanceData,
  venue: FinVenue,
  month: Q2Month,
): VenueCostInfo {
  // per_match_minus_manager (Crossbar Rowlett): cost is the partner
  // dashboard's owed, not matchCount × rate. Checked before billing_type
  // because the venue is stored as `per_match` (with a null rate) — the
  // model lives on its partner dashboard, not on billing_type.
  const pmm = perMatchMinusManagerOwed(data, venue.id, month);
  if (pmm != null) {
    return {
      amount: pmm,
      kind: "per_match_minus_manager",
      matchCount: venueMatchCount(data, venue, month),
      totalHours: 0,
      formula:
        pmm === 0
          ? "Match revenue below manager cost this month"
          : "Match revenue minus manager pay",
      source: "Partner dashboard payout",
      override: null,
    };
  }
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
  // profit_share — cost is the partner-dashboard "Payment Owed" for
  // this venue/month (qualifyingRevenue × revenueSharePct), computed
  // by the same computeWeeklyPayments call the partner page renders.
  // canonicalVenueCost still checks override first, so an override
  // (when present) wins as a manual correction lever; otherwise the
  // dashboard payout drives cost. No dashboard → null lookup →
  // surfaces as "needs override" with a clear "No partner dashboard"
  // hint rather than silently returning $0.
  if (venue.billing_type === "profit_share") {
    const owed = partnerPaymentOwedForMonth(
      data.partnerDashboards,
      data.partnerPayoutsByVenueMonth,
      venue.id,
      month,
    );
    if (owed == null) {
      return {
        amount: 0,
        kind: "needs_override",
        matchCount: venueMatchCount(data, venue, month),
        totalHours: 0,
        formula: "No partner dashboard configured",
        source: "—",
        override: null,
      };
    }
    const dash = data.partnerDashboards.find((d) => d.venueId === venue.id);
    const pct = dash?.revenueSharePct ?? 50;
    // owed = qualifyingRevenue × pct/100, so qualifyingRevenue = owed × (100/pct).
    const qualifyingRev = pct > 0 ? Math.round((owed * 100) / pct) : 0;
    return {
      amount: owed,
      kind: "profit_share",
      matchCount: venueMatchCount(data, venue, month),
      totalHours: 0,
      formula:
        owed === 0
          ? "No qualifying revenue this month"
          : `${pct}% of $${qualifyingRev.toLocaleString()} qualifying`,
      source: "Partner dashboard payout",
      override: null,
    };
  }
  // monthly_flat — cost lives entirely in fin_venue_cost_overrides per
  // (venue, month). canonicalVenueCost reads the override before
  // falling back to autoCost, so this branch only fires when an
  // override is missing for the month — surface that as a visible
  // "needs override" hint rather than silently returning $0.
  if (venue.billing_type === "monthly_flat") {
    return {
      amount: 0,
      kind: "needs_override",
      matchCount: venueMatchCount(data, venue, month),
      totalHours: 0,
      formula: `Set ${month} override below (monthly flat)`,
      source: "Override required",
      override: null,
    };
  }
  // Defensive fallback. The narrowed billing_type union makes this
  // unreachable in normal flow; a stale DB row carrying a retired
  // billing_type would land here and surface as $0 with a clear
  // "No billing model on file" instead of crashing.
  return {
    amount: 0,
    kind: "unknown",
    matchCount: venueMatchCount(data, venue, month),
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
      // Inert field on the result type — no current consumer reads it.
      // Returning 0 instead of computing keeps the VenueCostInfo shape
      // stable for callers that destructure it (e.g. compactCostBreakdown).
      totalHours: 0,
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

// Single Field Costs total for the month — sum of override-aware
// canonical cost across every venue. Replaces the prior
// venueRentalLineFor + perMatchVenueCostFor split now that both flow
// through fin_venue_cost_overrides as the only source of truth.
export function fieldCostsFor(data: FinanceData, month: Q2Month): number {
  let total = 0;
  for (const v of data.venues) {
    total += canonicalVenueCost(data, v.id, month).amount;
  }
  return total;
}

// Sum of override rows for the month. Used in the Field Costs
// reconciliation footer to show how much of fieldCostsFor came from
// manual overrides vs auto-computed per_match.
export function overrideOnlyTotalFor(
  data: FinanceData,
  month: Q2Month,
): number {
  return data.overrides
    .filter((o) => o.month === month)
    .reduce((s, o) => s + Number(o.override_amount || 0), 0);
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
    // Drop hidden-city venue groups (paused markets) from the forward-
    // facing Field Costs config table. Historical data is untouched.
    if (isCityHidden(g.city)) continue;
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
