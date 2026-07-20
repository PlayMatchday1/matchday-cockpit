// Combined-venue cost reconciliation: the Field Costs tab (buildFieldCostRows)
// must agree with Cash Flow (fieldCostsFor) for combined groups. A primary
// leg's override covers the primary leg ONLY — each secondary leg still bills
// its own canonical cost (its own override if set, else auto). This is the
// Soccer Central case: #11 flat override + #53 tournament per-match on top.
//
// Run: npx tsx --test src/lib/financeCosts.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFieldCostRows, fieldCostsFor } from "./financeCosts";
import type {
  FinanceData,
  FinVenue,
  FinMasterSchedule,
  FinVenueCostOverride,
} from "./useFinanceData";

const MONTH = "Jul 2026";

function venue(
  over: Partial<FinVenue> & Pick<FinVenue, "id" | "venue_name" | "city" | "billing_type">,
): FinVenue {
  return {
    raw_venue_name: over.venue_name,
    hourly_rate: null,
    monthly_flat: null,
    per_match_rate: null,
    max_spots: null,
    dpp_price: null,
    member_price: null,
    cost_per_match: null,
    notes: null,
    launch_date: null,
    is_active: true,
    charge_on_cancel: true,
    billing_cadence: "monthly",
    billing_day: null,
    billing_anchor_month: null,
    billing_weekday: null,
    billing_custom_days: {},
    ...over,
  } as FinVenue;
}

let seq = 0;
function sched(venueId: number): FinMasterSchedule {
  seq += 1;
  return {
    id: `m${seq}`,
    city: "",
    venue: "",
    match_date: "2026-07-10",
    match_time: "7:00 PM",
    month: MONTH,
    max_spots: 22,
    mdapi_field_id: null,
    venue_id: venueId,
    duration_hours: 1,
  };
}

function override(venueId: number, amount: number): FinVenueCostOverride {
  return {
    id: venueId * 100,
    venue_id: venueId,
    month: MONTH,
    override_amount: amount,
    reason: null,
    created_at: "2026-07-01",
    created_by: "test",
  };
}

function makeData(opts: {
  venues: FinVenue[];
  masterSchedule: FinMasterSchedule[];
  overrides?: FinVenueCostOverride[];
}): FinanceData {
  return {
    revenue: [],
    expenses: [],
    managerPay: [],
    schedule: [],
    masterSchedule: opts.masterSchedule,
    cancelledSchedule: [],
    venues: opts.venues,
    memberSpots: [],
    members: [],
    pricing: [],
    overrides: opts.overrides ?? [],
    venueAliases: new Map(),
    venueFields: new Map(),
    config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [],
    partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
}

const rep = (n: number, venueId: number) =>
  Array.from({ length: n }, () => sched(venueId));

test("combined group: overridden primary + unoverridden secondary sums BOTH legs (tab == Cash Flow)", () => {
  // Soccer Central: #11 normal ($60) with a flat monthly override ($5,600);
  // #53 tournament ($120) with no override → 3 matches bill $360 on top.
  const data = makeData({
    venues: [
      venue({ id: 11, venue_name: "Soccer Central", city: "San Antonio", billing_type: "per_match", per_match_rate: 60 }),
      venue({ id: 53, venue_name: "Soccer Central Tournament", city: "San Antonio", billing_type: "per_match", per_match_rate: 120 }),
    ],
    masterSchedule: [...rep(9, 11), ...rep(3, 53)],
    overrides: [override(11, 5600)],
  });

  const rows = buildFieldCostRows(data, MONTH);
  const sc = rows.find((r) => r.displayName === "Soccer Central")!;
  assert.ok(sc, "combined Soccer Central row present");
  assert.deepEqual(sc.secondaryVenueIds, [53], "#53 is the secondary leg");
  // primary override 5600 + secondary auto (3 × 120 = 360) = 5960 — NOT just
  // the 5600 override.
  assert.equal(sc.amount, 5960);

  // Reconciliation clears: Field Costs tab total == Cash Flow total.
  const tabTotal = rows.reduce((s, r) => s + r.amount, 0);
  assert.equal(tabTotal, fieldCostsFor(data, MONTH));
  assert.equal(fieldCostsFor(data, MONTH), 5960);
});

test("combined group: a $0 secondary override nets to the primary (explicit one-invoice case)", () => {
  // ATH Katy one-invoice: the Sunday leg carries an EXPLICIT $0 override, so
  // the primary override covers the whole group and the secondary adds nothing.
  const data = makeData({
    venues: [
      venue({ id: 7, venue_name: "ATH Katy", city: "Houston", billing_type: "per_match", per_match_rate: 140 }),
      venue({ id: 23, venue_name: "ATH Katy Sunday", city: "Houston", billing_type: "per_match", per_match_rate: 160 }),
    ],
    masterSchedule: [...rep(4, 7), ...rep(2, 23)],
    overrides: [override(7, 3000), override(23, 0)],
  });

  const rows = buildFieldCostRows(data, MONTH);
  const katy = rows.find((r) => r.displayName === "ATH Katy")!;
  // 3000 primary override + 0 secondary override = 3000.
  assert.equal(katy.amount, 3000);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), fieldCostsFor(data, MONTH));
});

test("combined group with no overrides sums both legs' auto cost (unchanged behavior)", () => {
  const data = makeData({
    venues: [
      venue({ id: 11, venue_name: "Soccer Central", city: "San Antonio", billing_type: "per_match", per_match_rate: 60 }),
      venue({ id: 53, venue_name: "Soccer Central Tournament", city: "San Antonio", billing_type: "per_match", per_match_rate: 120 }),
    ],
    masterSchedule: [...rep(5, 11), ...rep(2, 53)],
  });
  const rows = buildFieldCostRows(data, MONTH);
  const sc = rows.find((r) => r.displayName === "Soccer Central")!;
  // 5 × 60 + 2 × 120 = 540.
  assert.equal(sc.amount, 540);
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), fieldCostsFor(data, MONTH));
});
