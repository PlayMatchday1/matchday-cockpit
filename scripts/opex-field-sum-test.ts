// OPEX — every field venue's days add up to its Field Costs figure, whatever day it is.
//   npx tsx scripts/opex-field-sum-test.ts
//
// THE RULE (Ryan, 2026-10-03). OpEx follows each venue's pay schedule, past and future: a payment
// sits on its scheduled day at its scheduled amount, paid once the day has passed, expected before.
// There is no bank feed, so a past day no longer waits for a bank row. An amount typed in by hand
// or loaded for the month is the month's total and the days follow it.
//
// WHAT THIS GUARDS. "A venue's daily amounts for a month must sum to its Field Costs figure." Two
// pages, two code paths (buildFieldCostRows / buildOpexCalendarAsOf), and a "today" that moves every
// day — so the sum is checked for EVERY day of the month as "today", plus the day before the month
// and the day after it, for every venue shape: picked dates, every 2 weeks, each match (Soccer
// Central's two rates by size), prepaid, hand-set, bank-loaded, and a legacy row with no schedule.
//
// PREPAID is the one timing twist: its cash for a month leaves the month BEFORE, marked "for
// <month>", so its Field Costs figure for November is checked against October's "for November" row.

import { buildFieldCostRows } from "../src/lib/financeCosts";
import { BANK_SOURCE, buildOpexCalendarAsOf, rowTotal } from "../src/lib/opexSources";
import type { FinanceData, FinVenue } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

function venue(id: number, name: string, over: Partial<FinVenue> = {}): FinVenue {
  return {
    id, venue_name: name, raw_venue_name: name, city: "San Antonio", billing_type: "per_match",
    per_match_rate: 100, cost_per_match: 100, hourly_rate: null, monthly_flat: null, max_spots: 20,
    dpp_price: null, member_price: null, notes: null, launch_date: null, is_active: true,
    charge_on_cancel: false, bills_per_reservation: false, billing_cadence: "monthly",
    billing_day: null, billing_anchor_month: null, billing_weekday: null, billing_custom_days: {},
    pay_schedule: { mode: "dates", dates: [{ d: 15 }], prepaid: false }, rate_days: null,
    ...over,
  } as FinVenue;
}
let n = 0;
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const match = (venueId: number, ymd: string, maxSpots = 20) => ({
  id: `m${++n}`, city: "San Antonio", venue: `v${venueId}`, match_date: ymd, match_time: `7:00 PM ${n}`,
  month: `${MON[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`, max_spots: maxSpots, mdapi_field_id: 1,
  venue_id: venueId, duration_hours: 1, category: "regular", start_utc_ms: Date.parse(`${ymd}T23:00:00Z`),
});
const ov = (id: number, venueId: number, month: string, amount: number, by = "rmancuso@playmatchday.com") =>
  ({ id, venue_id: venueId, month, override_amount: amount, reason: null, created_at: "2026-10-01", created_by: by });

const oct = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const nov = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;

function makeData(): FinanceData {
  return {
    venues: [
      // Soccer Central: normal $90 / tournament $160 by size, paid on each match date.
      venue(11, "Soccer Central", { per_match_rate: 90, pay_schedule: { mode: "match" } }),
      venue(53, "Soccer Central Tournament", { per_match_rate: 160, is_active: false, charge_on_cancel: true, pay_schedule: { mode: "match" } }),
      venue(2, "Dates Pitch", { pay_schedule: { mode: "dates", dates: [{ d: 1, v: 150 }, { d: 20 }], prepaid: false } }),
      venue(3, "Biweekly Pitch", { pay_schedule: { mode: "biweekly", anchor: "2026-10-02" } as never }),
      venue(4, "Prepaid Pitch", { pay_schedule: { mode: "dates", dates: [{ d: 10 }], prepaid: true } }),
      venue(5, "Hand Set Pitch", { pay_schedule: { mode: "dates", dates: [{ d: 1 }], prepaid: false } }),
      venue(6, "Bank Pitch", { pay_schedule: { mode: "dates", dates: [{ d: 5 }], prepaid: false } }),
      venue(7, "Legacy Pitch", { pay_schedule: null, billing_day: 12 }),
    ],
    masterSchedule: [
      match(11, oct(1)), match(11, oct(2), 30), match(11, oct(9)), match(11, oct(9), 30), match(11, oct(23), 30),
      match(2, oct(3)), match(2, oct(17)), match(2, oct(30)),
      match(3, oct(6)), match(3, oct(13)),
      match(4, oct(8)), match(4, nov(5)), match(4, nov(12)),
      match(5, oct(14)), match(5, oct(21)),
      match(6, oct(7)),
      match(7, oct(4)), match(7, oct(25)),
    ].map((s) => ({ ...s, venue_id: s.venue_id === 11 && s.max_spots > 22 ? 53 : s.venue_id })),
    cancelledSchedule: [],
    overrides: [ov(1, 5, "Oct 2026", 640), ov(2, 6, "Oct 2026", 275, BANK_SOURCE)],
    revenue: [], expenses: [], managerPay: [], schedule: [], memberSpots: [], members: [], pricing: [],
    venueAliases: new Map(), venueFields: new Map(), config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [], partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
}

const data = makeData();
const rowsOct = buildFieldCostRows(data, "Oct 2026" as never);
const rowsNov = buildFieldCostRows(data, "Nov 2026" as never);
const fcOct = (id: number) => rowsOct.find((r) => r.primaryVenueId === id)!.amount;
const fcNov = (id: number) => rowsNov.find((r) => r.primaryVenueId === id)!.amount;

console.log("\nPOSITIVE CONTROL — the fixture's Field Costs figures");
{
  is("Soccer Central: 2 normal × $90 + 3 tournament × $160 = $660", fcOct(11), 660);
  is("Hand Set Pitch: the $640 typed in, not 2 × $100", fcOct(5), 640);
  is("Bank Pitch: the $275 loaded, not 1 × $100", fcOct(6), 275);
  is("Prepaid Pitch, November: 2 × $100 = $200 (its cash leaves in October)", fcNov(4), 200);
}

// Every "today" across October, plus Sep 30 (October in the future) and Nov 1 (October past).
const todays: Date[] = [new Date(2026, 8, 30, 12)];
for (let d = 1; d <= 31; d++) todays.push(new Date(2026, 9, d, 12));
todays.push(new Date(2026, 10, 1, 12));

console.log(`\nEVERY VENUE, EVERY DAY: October's OpEx days sum to its Field Costs figure (${todays.length} "todays")`);
{
  const ids = [11, 2, 3, 5, 6, 7];
  let checked = 0, mismatches = 0, paidMoves = 0;
  let prevPaid = -1;
  for (const now of todays) {
    const cal = buildOpexCalendarAsOf(data, 2026, 9, now);
    const field = cal.groups.find((g) => g.key === "field")!;
    const own = (id: number) => field.rows.filter((r) => r.lock?.kind === "field-cost" && r.lock.venueId === id && !r.forMonth);
    for (const id of ids) {
      checked++;
      const sum = Math.round(own(id).reduce((s, r) => s + rowTotal(r), 0) * 100) / 100;
      if (Math.abs(sum - fcOct(id)) >= 0.005) { mismatches++; bad(`${now.toDateString()}: venue ${id} OpEx ${sum} vs Field Costs ${fcOct(id)}`); }
    }
    const pre = field.rows.filter((r) => r.lock?.kind === "field-cost" && r.lock.venueId === 4 && r.forMonth);
    checked++;
    const preSum = Math.round(pre.reduce((s, r) => s + rowTotal(r), 0) * 100) / 100;
    if (Math.abs(preSum - fcNov(4)) >= 0.005) { mismatches++; bad(`${now.toDateString()}: prepaid "for November" ${preSum} vs Field Costs Nov ${fcNov(4)}`); }
    is(`${now.toDateString()}: Prepaid Pitch draws nothing for October in October (its October cash left in September)`, own(4).length, 0);
    if (cal.paidTotal !== prevPaid) paidMoves++;
    prevPaid = cal.paidTotal;
  }
  is(`all ${checked} venue-days add up (0 mismatches)`, mismatches, 0);
  is("...and the paid figure really moved as 'today' advanced (the loop is not checking one frozen state)", paidMoves > 5, true);
}

console.log("\nPAID AND EXPECTED — a past day is paid, a later day expected; no bank row needed");
{
  const cal = buildOpexCalendarAsOf(data, 2026, 9, new Date(2026, 9, 3, 12));
  const field = cal.groups.find((g) => g.key === "field")!;
  const sc = field.rows.find((r) => r.lock?.kind === "field-cost" && r.lock.venueId === 11)!;
  is("Soccer Central on Oct 1: one normal match, $90 — shown though there is no bank row", sc.cells[1], 90);
  is("...Oct 2: one tournament match, $160", sc.cells[2], 160);
  const bi = field.rows.find((r) => r.lock?.kind === "field-cost" && r.lock.venueId === 3)!;
  is("an every-2-weeks $200 splits $66.67 + $66.67 + $66.66 — to the cent, not $200.01", JSON.stringify(Object.values(bi.cells)), "[66.67,66.67,66.66]");
  is("...Oct 9: one of each, $250", sc.cells[9], 250);
  is("on Oct 3, everything up to Oct 3 counts as paid", cal.paidThrough, 3);
  const before = buildOpexCalendarAsOf(data, 2026, 9, new Date(2026, 8, 30, 12));
  is("CONTROL — on Sep 30, nothing in October is paid yet", before.paidTotal, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
