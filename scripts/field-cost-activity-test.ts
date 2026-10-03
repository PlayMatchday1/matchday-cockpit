// FIELD COSTS — "Show inactive": which venues are hidden, and that hiding them moves no figure.
//   npx tsx scripts/field-cost-activity-test.ts
//
// WHAT THIS GUARDS. Field Costs hides a venue with nothing happening in the month. Two ways that
// goes wrong, neither visible on the page that caused it:
//
//   1. HIDING A VENUE THAT IS DUE MONEY. The riskiest part of the rule is "no payment leaving". The
//      OpEx calendar shows only the bank for days already past, so a venue that prepays on the 1st
//      for next month's matches, with the bank feed not loaded yet, looks idle there. The fixture
//      builds exactly that venue and proves (a) the calendar alone misses it — the trap is real —
//      and (b) fieldCostPayeesIn still keeps it.
//
//   2. A TOTAL THAT CHANGES WITH THE TOGGLE. The footer must read the same with inactive venues
//      shown or hidden. Asserted on the computed totals, both ways.

import { buildFieldCostRows } from "../src/lib/financeCosts";
import { fieldCostTotals, inactiveFieldCostKeys, isInactiveFieldCostRow, rateMismatches } from "../src/lib/fieldCostActivity";
import { BANK_SOURCE, buildOpexCalendarAsOf, fieldCostPayeesIn } from "../src/lib/opexSources";
import type { FinanceData, FinVenue } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// Saturday 3 Oct 2026, mid-afternoon Central. Oct 1 has passed.
const NOW = new Date(2026, 9, 3, 15, 0, 0);
const MONTH = "Oct 2026";

function venue(id: number, name: string, over: Partial<FinVenue> = {}): FinVenue {
  return {
    id, venue_name: name, raw_venue_name: name, city: "Austin", billing_type: "per_match",
    per_match_rate: 100, cost_per_match: 100, hourly_rate: null, monthly_flat: null, max_spots: 20,
    dpp_price: null, member_price: null, notes: null, launch_date: null, is_active: true,
    charge_on_cancel: false, bills_per_reservation: false, billing_cadence: "monthly",
    billing_day: null, billing_anchor_month: null, billing_weekday: null, billing_custom_days: {},
    pay_schedule: { mode: "dates", dates: [{ d: 15 }], prepaid: false }, rate_days: null,
    ...over,
  } as FinVenue;
}
let n = 0;
const match = (venueId: number, ymd: string) => ({
  id: `m${++n}`, city: "Austin", venue: `v${venueId}`, match_date: ymd, match_time: "7:00 PM - 8:00 PM",
  month: ymd.startsWith("2026-11") ? "Nov 2026" : "Oct 2026", max_spots: 20, mdapi_field_id: 1,
  venue_id: venueId, duration_hours: 1, category: "regular", start_utc_ms: Date.parse(`${ymd}T23:00:00Z`),
});
const ov = (id: number, venueId: number, amount: number, by = "rmancuso@playmatchday.com") =>
  ({ id, venue_id: venueId, month: MONTH, override_amount: amount, reason: null, created_at: "", created_by: by });

function makeData(): FinanceData {
  return {
    venues: [
      venue(1, "Busy Pitch"),
      venue(2, "Zero Rate Pitch", { per_match_rate: 0 }),            // matches, $0 — stays
      venue(3, "Idle Pitch"),                                          // nothing at all — hidden
      venue(4, "Hand Set Pitch"),                                      // $0 set by hand — stays
      venue(5, "Prepaid Pitch", { pay_schedule: { mode: "dates", dates: [{ d: 1 }], prepaid: true } }),
      venue(6, "Bank Pitch"),                                          // bank-loaded amount — stays
      venue(7, "Idle Pitch Two", { city: "Dallas", pay_schedule: null }), // nothing, legacy cadence — hidden
    ],
    masterSchedule: [
      match(1, "2026-10-10"), match(1, "2026-10-17"),
      match(2, "2026-10-12"),
      // Prepaid Pitch plays only in November; its cash for November leaves on Oct 1 — a day past.
      match(5, "2026-11-05"), match(5, "2026-11-12"),
    ],
    cancelledSchedule: [],
    overrides: [ov(1, 4, 0), ov(2, 6, 450, BANK_SOURCE)],
    revenue: [], expenses: [], managerPay: [], schedule: [], memberSpots: [], members: [], pricing: [],
    venueAliases: new Map(), venueFields: new Map(), config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [], partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
}

const data = makeData();
const rows = buildFieldCostRows(data, MONTH as never);
const payees = fieldCostPayeesIn(data, 2026, 9, NOW);
const inactive = rows.filter((r) => isInactiveFieldCostRow(data, r, MONTH, payees));
const name = (id: number) => rows.find((r) => r.primaryVenueId === id)!;

console.log("\nPOSITIVE CONTROL — the fixture has every case");
{
  is("seven venues → seven rows", rows.length, 7);
  is("Busy Pitch has 2 October matches", name(1).matchCount, 2);
  is("Prepaid Pitch has 0 October matches (it plays in November)", name(5).matchCount, 0);
}

console.log("\nTHE TRAP — a prepaid payment on a day already past, with no bank record");
{
  const cal = buildOpexCalendarAsOf(data, 2026, 9, NOW);
  const calOnly = new Set<number>();
  for (const g of cal.groups) if (g.key === "field") for (const r of g.rows) if (r.lock?.kind === "field-cost") calOnly.add(r.lock.venueId);
  is("the OpEx calendar alone does NOT show Prepaid Pitch (Oct 1 is past; no bank row)", calOnly.has(5), false);
  is("...CONTROL — the calendar does show Bank Pitch, from its bank amount", calOnly.has(6), true);
  is("fieldCostPayeesIn DOES include Prepaid Pitch: the whole-month schedule sees its Oct 1 payment", payees.has(5), true);
  is("...so Prepaid Pitch is not hidden", isInactiveFieldCostRow(data, name(5), MONTH, payees), false);
}

console.log("\nWHO IS HIDDEN");
{
  is("exactly the two idle venues are inactive", JSON.stringify(inactive.map((r) => r.primaryVenueId).sort()), "[3,7]");
  is("a venue with matches and a $0 cost stays", isInactiveFieldCostRow(data, name(2), MONTH, payees), false);
  is("a venue with $0 set by hand stays", isInactiveFieldCostRow(data, name(4), MONTH, payees), false);
  is("a venue with a bank-loaded amount stays", isInactiveFieldCostRow(data, name(6), MONTH, payees), false);
  is("CONTROL — Idle Pitch is not a payee", payees.has(3), false);
}

console.log("\nTHE TOGGLE MOVES NO FIGURE");
{
  const on = fieldCostTotals(rows);
  const off = fieldCostTotals(rows.filter((r) => !inactive.includes(r)));
  is("matches: identical with inactive shown and hidden", off.matches, on.matches);
  is("cost: identical with inactive shown and hidden", off.amount, on.amount);
  is("...and the toggle really removes rows here (2 of 7)", rows.length - inactive.length, 5);
  is("...and the totals are not trivially zero", on.matches > 0 && on.amount > 0, true);
}

console.log("\nA FUTURE MONTH HIDES ONLY WHAT IS ALSO IDLE NOW (matches there are mostly not created yet)");
{
  // December: no venue has a December match in the fixture — exactly what the live table looks like.
  const dec = buildFieldCostRows(data, "Dec 2026" as never);
  const decPayees = fieldCostPayeesIn(data, 2026, 11, NOW);
  const fourTests = dec.filter((r) => isInactiveFieldCostRow(data, r, "Dec 2026", decPayees)).map((r) => r.primaryVenueId).sort();
  is("CONTROL — the four tests alone would hide Busy Pitch in December (no December matches yet)", fourTests.includes(1), true);
  const hidden = [...inactiveFieldCostKeys(data, dec, "Dec 2026", NOW)].map((k) => dec.find((r) => r.key === k)!.primaryVenueId).sort();
  is("December hides only the venues that are idle in October too: Idle Pitch and Idle Pitch Two", JSON.stringify(hidden), "[3,7]");
  is("...so Busy Pitch, which plays in October, stays visible in December", hidden.includes(1), false);
  const decOn = fieldCostTotals(dec), decOff = fieldCostTotals(dec.filter((r) => !hidden.includes(r.primaryVenueId)));
  is("December's totals are identical with the toggle on and off", JSON.stringify(decOff), JSON.stringify(decOn));

  // A PAST month keeps the four tests alone: Busy Pitch has no September matches and nothing to pay.
  const sep = buildFieldCostRows(data, "Sep 2026" as never);
  const sepHidden = [...inactiveFieldCostKeys(data, sep, "Sep 2026", NOW)].map((k) => sep.find((r) => r.key === k)!.primaryVenueId);
  is("a past month (September) uses the rule as built: Busy Pitch, idle in September, is hidden", sepHidden.includes(1), true);
  const oct = [...inactiveFieldCostKeys(data, rows, MONTH, NOW)].map((k) => rows.find((r) => r.key === k)!.primaryVenueId).sort();
  is("the current month (October) is unchanged: [3,7]", JSON.stringify(oct), "[3,7]");
}

console.log("\n\"RATES DIFFER\" — per-match venues whose cost per match and invoice rate disagree");
{
  const d = makeData();
  d.venues = [
    venue(11, "Westlake Like", { cost_per_match: 114, per_match_rate: 135 }),
    venue(12, "Katy Like", { cost_per_match: 140, per_match_rate: 140 }),
    venue(13, "Share Like", { billing_type: "profit_share", cost_per_match: 32, per_match_rate: null }),
    venue(14, "Flat Like", { billing_type: "monthly_flat", cost_per_match: 32, per_match_rate: 90 }),
    venue(15, "No Rate Like", { cost_per_match: 40, per_match_rate: null }),
  ];
  const rs = buildFieldCostRows(d, MONTH as never);
  const flag = (id: number) => rateMismatches(d, rs.find((r) => r.primaryVenueId === id)!);
  is("a per-match venue at $114 cost vs $135 invoice is flagged, with both numbers", JSON.stringify(flag(11).map((m) => [m.cost, m.invoice])), "[[114,135]]");
  is("CONTROL — equal cost and invoice raise nothing", flag(12).length, 0);
  is("a profit-share venue is exempt", flag(13).length, 0);
  is("a flat-rate venue is exempt", flag(14).length, 0);
  is("a missing invoice rate is not 'differ' (that is the no-rate flag)", flag(15).length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
