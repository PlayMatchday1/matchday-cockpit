// Special-event matches carry NO venue cost, but they KEEP their venue_id (the
// venue link stays intact for every non-cost consumer). Cost is excluded by the
// category flag, not by making the match venue-less. Both alive and cancelled
// event matches are excluded (including-cancelled removal).
//
// Run: npx tsx --test src/lib/eventCostExclusion.finance-test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalVenueCost, isEventSchedule } from "./financeCosts";
import type { FinanceData, FinVenue, FinMasterSchedule } from "./useFinanceData";

const MONTH = "Jul 2026";
const RATE = 160;

const venue: FinVenue = {
  id: 8,
  venue_name: "ATH Pearland",
  raw_venue_name: "ATH Pearland",
  city: "Houston",
  billing_type: "per_match",
  hourly_rate: null,
  monthly_flat: null,
  per_match_rate: RATE,
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
};

function sched(id: string, category: "regular" | "event"): FinMasterSchedule {
  return {
    id,
    city: "Houston",
    venue: "ATH Pearland",
    match_date: "2026-07-10",
    match_time: "7:00 PM",
    month: MONTH,
    max_spots: 40,
    mdapi_field_id: null,
    venue_id: 8, // events KEEP their venue_id
    duration_hours: 1,
    category,
  };
}

function data(master: FinMasterSchedule[], cancelled: FinMasterSchedule[]): FinanceData {
  return {
    venues: [venue],
    masterSchedule: master,
    cancelledSchedule: cancelled,
    overrides: [],
    partnerDashboards: [],
    partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
}

test("isEventSchedule keys only on category", () => {
  assert.equal(isEventSchedule({ category: "event" }), true);
  assert.equal(isEventSchedule({ category: "regular" }), false);
});

test("per-match cost counts regular matches only — events excluded despite carrying venue_id", () => {
  // 1 regular + 3 event (alive) + 2 event (cancelled, charge_on_cancel=true).
  const d = data(
    [sched("reg1", "regular"), sched("ev1", "event"), sched("ev2", "event"), sched("ev3", "event")],
    [sched("cxEv1", "event"), sched("cxEv2", "event")],
  );
  // Every event still carries venue_id 8 — the venue link is intact.
  for (const s of [...d.masterSchedule, ...d.cancelledSchedule]) assert.equal(s.venue_id, 8);
  // Cost = 1 regular × $160 = $160. NOT 4×160 (alive events) and NOT 6×160
  // (incl cancelled events). Events contribute zero.
  assert.equal(canonicalVenueCost(d, 8, MONTH).amount, RATE);
});

test("a venue whose only matches are events costs zero", () => {
  const d = data([sched("ev1", "event"), sched("ev2", "event")], [sched("cxEv1", "event")]);
  assert.equal(canonicalVenueCost(d, 8, MONTH).amount, 0);
});
