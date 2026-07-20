// Correctness tests for the OpEx calendar source builder — focused on the
// load-bearing invariant: dating field costs must never change the Field
// Costs subtotal (it only moves money across days), and venues without
// captured timing must land in the undated remainder, not on day 1.
//
// Run: npx tsx --test src/lib/opexSources.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildOpexCalendar } from "./opexSources";
import { buildFieldCostRows, fieldCostsFor } from "./financeCosts";
import type {
  FinanceData,
  FinVenue,
  FinMasterSchedule,
  FinVenueCostOverride,
  FinExpense,
} from "./useFinanceData";

const MONTH = "Jul 2026";
const YEAR = 2026;
const M0 = 6; // July

function venue(over: Partial<FinVenue> & Pick<FinVenue, "id" | "venue_name" | "city" | "billing_type">): FinVenue {
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

function match(id: string, venueId: number, city: string, day: number): FinMasterSchedule {
  const dd = String(day).padStart(2, "0");
  return {
    id,
    city,
    venue: `v${venueId}`,
    match_date: `2026-07-${dd}`,
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

function expense(o: Partial<FinExpense> & Pick<FinExpense, "id" | "date" | "category" | "amount">): FinExpense {
  return {
    month: MONTH,
    city: "Austin",
    vendor: null,
    notes: null,
    manual_entry: true,
    ...o,
  } as FinExpense;
}

function makeData(): FinanceData {
  const venues: FinVenue[] = [
    // per_match — dated by its matches. 2 alive + 1 charged cancellation.
    venue({ id: 1, venue_name: "Alpha Park", city: "Austin", billing_type: "per_match", per_match_rate: 90 }),
    // monthly_flat with billing_day → single dated lump.
    venue({ id: 2, venue_name: "Beta Fields", city: "Austin", billing_type: "monthly_flat", billing_day: 10 }),
    // monthly_flat WITHOUT billing_day → undated remainder.
    venue({ id: 3, venue_name: "Gamma Turf", city: "Dallas", billing_type: "monthly_flat" }),
  ];
  const masterSchedule = [match("m1", 1, "Austin", 3), match("m2", 1, "Austin", 17)];
  const cancelledSchedule = [match("c1", 1, "Austin", 24)]; // charged (charge_on_cancel true)
  const overrides = [override(2, 900), override(3, 500)];
  const expenses: FinExpense[] = [
    expense({ id: 11, date: "2026-07-01", city: "Houston", category: "City Manager", notes: "Yara", amount: 500 }),
    expense({ id: 12, date: "2026-07-15", city: "Dallas", category: "City Manager", notes: "Chris", amount: 800 }),
    // Match Manager Pay — two Thursdays, same city aggregates.
    expense({ id: 21, date: "2026-07-02", city: "Austin", category: "Match Manager Pay", amount: 1090 }),
    expense({ id: 22, date: "2026-07-09", city: "Austin", category: "Match Manager Pay", amount: 760 }),
  ];

  return {
    revenue: [],
    expenses,
    managerPay: [],
    schedule: [],
    masterSchedule,
    cancelledSchedule,
    venues,
    memberSpots: [],
    members: [],
    pricing: [],
    overrides,
    venueAliases: new Map(),
    venueFields: new Map(),
    config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [],
    partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
}

test("field-cost subtotal equals buildFieldCostRows sum (dating never changes the total)", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const field = cal.groups.find((g) => g.key === "field");
  assert.ok(field, "field group present");

  const fcSum = buildFieldCostRows(data, MONTH).reduce((s, r) => s + r.amount, 0);
  // Alpha 3×90=270 + Beta 900 + Gamma 500 = 1670
  assert.equal(fcSum, 1670);
  assert.equal(field!.subtotal, fcSum, "subtotal equals Field Costs tab total");
});

test("per-match venue is dated on its real match days (incl. charged cancellation)", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const field = cal.groups.find((g) => g.key === "field")!;
  const alpha = field.rows.find((r) => r.label === "Alpha Park")!;
  assert.deepEqual(
    Object.entries(alpha.cells).map(([d, v]) => [Number(d), v]).sort((a, b) => a[0] - b[0]),
    [[3, 90], [17, 90], [24, 90]],
  );
  assert.equal(alpha.tag, "per-match");
});

test("flat venue with billing_day lands on that day; without one it is undated (never day 1)", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const field = cal.groups.find((g) => g.key === "field")!;

  const beta = field.rows.find((r) => r.label === "Beta Fields")!;
  assert.deepEqual(beta.cells, { 10: 900 });

  // Gamma has no billing_day → no dated row, folded into undated.
  assert.ok(!field.rows.some((r) => r.label === "Gamma Turf"));
  assert.equal(field.undated, 500);
  // Nothing was smeared onto day 1.
  assert.ok(!field.agg[1]);
});

test("Match Manager Pay aggregates per city on Thursday pay dates", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const match = cal.groups.find((g) => g.key === "match")!;
  const austin = match.rows.find((r) => r.label === "Austin")!;
  assert.deepEqual(austin.cells, { 2: 1090, 9: 760 });
  assert.equal(match.subtotal, 1850);
});

test("City Manager Pay is itemized on real pay dates from fin_expenses", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const city = cal.groups.find((g) => g.key === "city")!;
  assert.equal(city.subtotal, 1300);
  const chris = city.rows.find((r) => r.label === "Chris")!;
  assert.deepEqual(chris.cells, { 15: 800 });
});

test("month total = sum of subtotals; dated total excludes the undated remainder", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  // city 1300 + match 1850 + field 1670 = 4820
  assert.equal(cal.monthTotal, 4820);
  assert.equal(cal.undatedFieldCosts, 500);
  assert.equal(cal.datedTotal, 4320);
  // Daily totals sum to the dated total (undated sits on no day).
  const daySum = cal.dayTotal.reduce((s, v) => s + v, 0);
  assert.equal(daySum, cal.datedTotal);
});

// A per-match-PRICED venue can be invoiced on a fixed day (ATH Katy /
// Pearland billed monthly). billing_day set routes it through the collapse
// path: the month's per-match total lands on one day instead of spreading
// over match days. The amount is unchanged, so the Field Costs subtotal
// still equals buildFieldCostRows.
function makePerMatchBilledMonthly(): FinanceData {
  const venues: FinVenue[] = [
    venue({
      id: 1,
      venue_name: "ATH Katy",
      city: "Houston",
      billing_type: "per_match",
      per_match_rate: 90,
      billing_day: 10, // invoiced on the 10th, not per match day
      charge_on_cancel: false,
    }),
  ];
  // Three matches on days 3, 17, 24 → 3 × 90 = 270 for the month.
  const masterSchedule = [
    match("m1", 1, "Houston", 3),
    match("m2", 1, "Houston", 17),
    match("m3", 1, "Houston", 24),
  ];
  return {
    revenue: [],
    expenses: [],
    managerPay: [],
    schedule: [],
    masterSchedule,
    cancelledSchedule: [],
    venues,
    memberSpots: [],
    members: [],
    pricing: [],
    overrides: [],
    venueAliases: new Map(),
    venueFields: new Map(),
    config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [],
    partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
}

test("per-match venue with billing_day collapses to one chip on that day; subtotal unchanged", () => {
  const data = makePerMatchBilledMonthly();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const field = cal.groups.find((g) => g.key === "field")!;

  const katy = field.rows.find((r) => r.label === "ATH Katy")!;
  // Collapsed onto the billing day (10), NOT spread over match days 3/17/24.
  assert.deepEqual(katy.cells, { 10: 270 });
  assert.equal(katy.tag, "monthly");
  assert.ok(!field.agg[3] && !field.agg[17] && !field.agg[24], "no per-match day cells");

  // Subtotal still equals the Field Costs tab total (dating never changes it).
  const fcSum = buildFieldCostRows(data, MONTH).reduce((s, r) => s + r.amount, 0);
  assert.equal(fcSum, 270);
  assert.equal(field.subtotal, fcSum);
  assert.equal(field.undated, 0);
});

test("biggest hit finds the largest single-day outflow", () => {
  const data = makeData();
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  // Jul 2: match Austin 1090 is the largest single day here.
  assert.equal(cal.biggestHit?.day, 2);
  assert.equal(cal.biggestHit?.amount, 1090);
});

// ---- WEEKLY + CUSTOM cadences (migration 0070) ----

// Minimal FinanceData shell so each cadence test can declare only the
// venues / schedule / overrides it needs.
function wrap(over: Partial<FinanceData>): FinanceData {
  return {
    revenue: [],
    expenses: [],
    managerPay: [],
    schedule: [],
    masterSchedule: [],
    cancelledSchedule: [],
    venues: [],
    memberSpots: [],
    members: [],
    pricing: [],
    overrides: [],
    venueAliases: new Map(),
    venueFields: new Map(),
    config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [],
    partnerPayoutsByVenueMonth: new Map(),
    ...over,
  } as unknown as FinanceData;
}

// July 2026 Thursdays (weekday 4) are the 2nd, 9th, 16th, 23rd, 30th.
const JUL_THURSDAYS = [2, 9, 16, 23, 30];

function fieldOf(data: FinanceData) {
  const cal = buildOpexCalendar(data, [], YEAR, M0);
  const field = cal.groups.find((g) => g.key === "field")!;
  const fcSum = buildFieldCostRows(data, MONTH).reduce((s, r) => s + r.amount, 0);
  const cellSum = field.rows.reduce(
    (s, r) => s + Object.values(r.cells).reduce((a, b) => a + b, 0),
    0,
  );
  return { field, fcSum, cellSum };
}

// Integer-cents view of a cells map, to compare exact splits without
// floating-point fragility (200.03 etc. aren't exactly representable).
function cents(cells: Record<number, number>): Record<number, number> {
  return Object.fromEntries(
    Object.entries(cells).map(([d, v]) => [d, Math.round(v * 100)]),
  );
}

test("weekly flat: month total splits evenly across the weekday's hits, remainder on last", () => {
  const data = wrap({
    venues: [
      venue({
        id: 1,
        venue_name: "Weekly Turf",
        city: "Austin",
        billing_type: "monthly_flat",
        billing_cadence: "weekly",
        billing_weekday: 4, // Thursday
      }),
    ],
    overrides: [override(1, 1000.03)],
  });
  const { field, fcSum, cellSum } = fieldOf(data);
  const row = field.rows.find((r) => r.label === "Weekly Turf")!;

  // Five Thursdays: $200.00 x4, remainder cent on the last → $200.03.
  assert.deepEqual(
    Object.keys(row.cells).map(Number).sort((a, b) => a - b),
    JUL_THURSDAYS,
  );
  assert.deepEqual(cents(row.cells), { 2: 20000, 9: 20000, 16: 20000, 23: 20000, 30: 20003 });
  assert.equal(row.tag, "weekly");
  // Invariant: placement preserves the total exactly, subtotal unchanged.
  assert.ok(Math.abs(cellSum - 1000.03) < 1e-9, "cells sum to the month total");
  assert.equal(field.subtotal, fcSum);
  assert.equal(field.undated, 0);
});

test("weekly per-match: each match accrues onto the next weekly billing day", () => {
  const data = wrap({
    venues: [
      venue({
        id: 1,
        venue_name: "Weekly Match Park",
        city: "Austin",
        billing_type: "per_match",
        per_match_rate: 90,
        billing_cadence: "weekly",
        billing_weekday: 4, // Thursday
        charge_on_cancel: false,
      }),
    ],
    // Matches on Jul 3, 10, 17 → next Thursday on/after each: 9, 16, 23.
    masterSchedule: [
      match("m1", 1, "Austin", 3),
      match("m2", 1, "Austin", 10),
      match("m3", 1, "Austin", 17),
    ],
  });
  const { field, fcSum, cellSum } = fieldOf(data);
  const row = field.rows.find((r) => r.label === "Weekly Match Park")!;
  assert.deepEqual(
    Object.entries(row.cells).map(([d, v]) => [Number(d), v]).sort((a, b) => a[0] - b[0]),
    [[9, 90], [16, 90], [23, 90]],
  );
  assert.equal(row.tag, "weekly");
  assert.equal(cellSum, 270);
  assert.equal(field.subtotal, fcSum);
  assert.equal(field.undated, 0);
});

test("custom flat (NEMP): payment month lands on the captured day; amount is the override", () => {
  const data = wrap({
    venues: [
      venue({
        id: 1,
        venue_name: "NEMP",
        city: "Austin",
        billing_type: "monthly_flat",
        billing_cadence: "custom",
        billing_custom_days: { "2026-07": [20], "2026-11": [15] },
      }),
    ],
    overrides: [override(1, 2000)],
  });
  const { field, fcSum } = fieldOf(data);
  const row = field.rows.find((r) => r.label === "NEMP")!;
  assert.deepEqual(row.cells, { 20: 2000 });
  assert.equal(row.tag, "custom");
  assert.equal(field.subtotal, fcSum);
  assert.equal(field.subtotal, 2000);
  assert.equal(field.undated, 0);
});

test("custom multi-day splits evenly with remainder on the last date", () => {
  const data = wrap({
    venues: [
      venue({
        id: 1,
        venue_name: "Custom Split",
        city: "Austin",
        billing_type: "monthly_flat",
        billing_cadence: "custom",
        billing_custom_days: { "2026-07": [10, 20, 31] },
      }),
    ],
    overrides: [override(1, 100)],
  });
  const { field, cellSum } = fieldOf(data);
  const row = field.rows.find((r) => r.label === "Custom Split")!;
  assert.deepEqual(cents(row.cells), { 10: 3333, 20: 3333, 31: 3334 });
  assert.ok(Math.abs(cellSum - 100) < 1e-9);
  assert.equal(field.undated, 0);
});

test("per-match override applies everywhere (Field Costs, Cash Flow, OpEx) and reverts to auto when cleared", () => {
  const venues = [
    venue({
      id: 1,
      venue_name: "Katy Custom",
      city: "Houston",
      billing_type: "per_match",
      per_match_rate: 90,
      billing_cadence: "custom",
      billing_custom_days: { "2026-07": [20] },
      charge_on_cancel: false,
    }),
  ];
  // 3 matches → auto = 3 × 90 = 270.
  const masterSchedule = [
    match("m1", 1, "Houston", 3),
    match("m2", 1, "Houston", 10),
    match("m3", 1, "Houston", 17),
  ];

  // --- overridden month: 500 replaces the 270 auto EVERYWHERE ---
  const withOverride = wrap({ venues, masterSchedule, overrides: [override(1, 500)] });
  const rowO = buildFieldCostRows(withOverride, MONTH).find((r) => r.displayName === "Katy Custom")!;
  assert.equal(rowO.amount, 500, "Field Costs row uses the override");
  assert.equal(rowO.autoAmount, 270, "auto still exposed as the override baseline");
  assert.ok(rowO.override, "row flagged as overridden");
  assert.equal(fieldCostsFor(withOverride, MONTH), 500, "Cash Flow uses the override");
  const fieldO = buildOpexCalendar(withOverride, [], YEAR, M0).groups.find((g) => g.key === "field")!;
  const chipO = fieldO.rows.find((r) => r.label === "Katy Custom")!;
  assert.deepEqual(chipO.cells, { 20: 500 }, "OpEx dates the override on the custom day");
  assert.equal(fieldO.subtotal, 500);
  assert.equal(fieldO.undated, 0);

  // --- cleared: back to the 270 auto EVERYWHERE ---
  const noOverride = wrap({ venues, masterSchedule });
  const rowA = buildFieldCostRows(noOverride, MONTH).find((r) => r.displayName === "Katy Custom")!;
  assert.equal(rowA.amount, 270, "reverts to matches × rate");
  assert.equal(rowA.override, null);
  assert.equal(fieldCostsFor(noOverride, MONTH), 270);
  const fieldA = buildOpexCalendar(noOverride, [], YEAR, M0).groups.find((g) => g.key === "field")!;
  const chipA = fieldA.rows.find((r) => r.label === "Katy Custom")!;
  assert.deepEqual(chipA.cells, { 20: 270 }, "OpEx dates the auto amount on the custom day");
  assert.equal(fieldA.subtotal, 270);
});

test("custom month with a cost but no day set → undated remainder, never day 1", () => {
  const data = wrap({
    venues: [
      venue({
        id: 1,
        venue_name: "Custom NoDay",
        city: "Austin",
        billing_type: "monthly_flat",
        billing_cadence: "custom",
        billing_custom_days: { "2026-11": [15] }, // nothing for July
      }),
    ],
    overrides: [override(1, 500)],
  });
  const { field, fcSum } = fieldOf(data);
  // No dated row for July, folded into the undated remainder.
  assert.ok(!field.rows.some((r) => r.label === "Custom NoDay"));
  assert.equal(field.undated, 500);
  assert.equal(field.subtotal, fcSum);
  assert.ok(!field.agg[1], "nothing smeared onto day 1");
});
