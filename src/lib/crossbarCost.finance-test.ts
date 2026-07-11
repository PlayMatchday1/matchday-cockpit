// Run via tsx (finance module graph uses extensionless imports that
// node --test cannot resolve): `npm test` runs this through tsx.
// Standalone: `npx tsx --test src/lib/crossbarCost.finance-test.ts`
//
// Regression guard for the per_match_minus_manager cost routing
// (Crossbar Rowlett). Crossbar is stored as billing_type="per_match"
// with a null rate; its real cost is the partner-dashboard "owed"
// (match revenue minus a per-match manager fee, floored at $0/month),
// pre-computed into data.partnerPayoutsByVenueMonth by
// buildPartnerPayoutsByVenueMonth (which shares computeWeeklyPayments
// with the partner dashboard page). All four Finance Cities / Field
// Ranking cost lenses must read that owed, not matchCount × rate or
// cost_per_match × matches. If any lens regresses to the old $0
// behavior, these assertions fail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalVenueCost, perMatchMinusManagerOwed } from "./financeCosts.ts";
import {
  groupPerMatchCostFor,
  groupPerMatchCostRealizedFor,
  venueRealizedCostFor,
} from "./financeStats.ts";
import { groupVenues } from "./venueGroups.ts";
import type { FinanceData } from "./useFinanceData.ts";

const MONTH = "Jun 2026";
const OWED = 161; // matches the partner dashboard's computeWeeklyPayments

function makeData(opts: {
  hasPmmDashboard: boolean;
  perMatchRate?: number | null;
}): FinanceData {
  const crossbar = {
    id: 51,
    venue_name: "Crossbar Rowlett",
    city: "Dallas",
    billing_type: "per_match",
    per_match_rate: opts.perMatchRate ?? null,
    cost_per_match: 0,
    monthly_flat: null,
    hourly_rate: null,
    max_spots: 18,
    is_active: true,
    charge_on_cancel: false,
    dpp_price: null,
    member_price: null,
    notes: null,
    launch_date: null,
  };
  const dashboards = opts.hasPmmDashboard
    ? [
        {
          id: "dash-1",
          venueId: 51,
          partnerName: "Crossbar Rowlett",
          revenueSharePct: 50,
          paymentStartDate: "2026-05-01",
          paymentDayOfWeek: 0,
          paymentCadence: "monthly",
          revenueModel: "per_match_minus_manager",
          managerPayBase: 20,
          managerPayHigh: 30,
          managerPayThreshold: 25,
        },
      ]
    : [];
  return {
    venues: [crossbar],
    partnerDashboards: dashboards,
    partnerPayoutsByVenueMonth: new Map([[`51|${MONTH}`, OWED]]),
    overrides: [],
    masterSchedule: [],
    cancelledSchedule: [],
  } as unknown as FinanceData;
}

function crossbarGroup(data: FinanceData) {
  const g = groupVenues(data.venues).find((grp) =>
    grp.legs.some((l) => l.id === 51),
  );
  assert.ok(g, "Crossbar venue group not found");
  return g;
}

// --- the four lenses all read the partner owed ---

test("As Billed lens (canonicalVenueCost) = partner owed", () => {
  const data = makeData({ hasPmmDashboard: true });
  assert.equal(canonicalVenueCost(data, 51, MONTH).amount, OWED);
  assert.equal(canonicalVenueCost(data, 51, MONTH).kind, "per_match_minus_manager");
});

test("Per-Match lens (groupPerMatchCostFor) = partner owed", () => {
  const data = makeData({ hasPmmDashboard: true });
  assert.equal(groupPerMatchCostFor(data, crossbarGroup(data), MONTH), OWED);
});

test("As Billed / Realized lens (venueRealizedCostFor) = partner owed", () => {
  const data = makeData({ hasPmmDashboard: true });
  const now = new Date("2026-08-15T12:00:00Z");
  assert.equal(venueRealizedCostFor(data, 51, MONTH, now), OWED);
});

test("Per-Match / Realized lens (groupPerMatchCostRealizedFor) = partner owed", () => {
  const data = makeData({ hasPmmDashboard: true });
  const now = new Date("2026-08-15T12:00:00Z");
  assert.equal(
    groupPerMatchCostRealizedFor(data, crossbarGroup(data), MONTH, now),
    OWED,
  );
});

// --- the branch must not over-fire on ordinary per_match venues ---

test("perMatchMinusManagerOwed returns null without a pmm dashboard", () => {
  const data = makeData({ hasPmmDashboard: false });
  assert.equal(perMatchMinusManagerOwed(data, 51, MONTH), null);
});

test("ordinary per_match venue still uses matchCount x rate (not the owed)", () => {
  // No pmm dashboard, real per_match_rate, zero scheduled matches -> $0
  // via the normal per_match branch, NOT the $161 owed in the map.
  const data = makeData({ hasPmmDashboard: false, perMatchRate: 100 });
  assert.equal(canonicalVenueCost(data, 51, MONTH).amount, 0);
  assert.equal(canonicalVenueCost(data, 51, MONTH).kind, "per_match");
});
