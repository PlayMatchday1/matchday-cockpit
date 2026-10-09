// FIELD COSTS — the computed figure split at now: "$540 ran so far · $900 scheduled".
//   npx tsx scripts/field-cost-split-test.ts
//
// WHAT THIS GUARDS. The Field Costs page keeps the month's cost as the full scheduled bill (what
// the venue will invoice; OpEx projects from it) and adds a line saying how much of it has been
// played. Two things can go wrong silently, and both are arithmetic, so they are checked here on
// computed values rather than by reading the page:
//
//   1. THE PARTS DO NOT ADD UP. A reservation slot holding one played and one future match, a
//      weekday rate, a charged cancellation — each is a way for "ran" + "scheduled" to drift off
//      the computed figure. For EVERY row below the two parts must equal autoAmount to the cent,
//      and the displayed line must add up to the displayed figure to the dollar.
//
//   2. THE CUT READS THE WALL CLOCK. match_date / match_time wear a Z they do not mean. The
//      future match below has a wall clock that reads as already past; a split keyed on it would
//      call tonight's fixture played. The cut must go through hasKickedOff on start_utc_ms.

import { buildFieldCostRows, capacitySplitOf, fieldCostMatchLines, fieldCostSplit, fieldCostSplitText } from "../src/lib/financeCosts";
import { hasKickedOff } from "../src/lib/fieldEconomics";
import { costPerMatchOn } from "../src/lib/venuePay";
import { readFileSync } from "node:fs";
import { emptyMdapiMemberSpotIndex } from "../src/lib/financeStats";
import type { FinanceData, FinMasterSchedule } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  got === want ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// 3pm Central on Saturday 3 Oct 2026. Tonight's 7pm fixture's wall clock reads "19:00Z" — an hour
// AGO as an instant — while its true start is four hours out.
const NOW = Date.parse("2026-10-03T20:00:00Z");
const kicked = (s: FinMasterSchedule) => hasKickedOff({ startUtcMs: s.start_utc_ms }, NOW);
const MONTH = "Oct 2026" as never;

let n = 0;
const sched = (venueId: number, ymd: string, utcIso: string | null, time = `7:00 PM ${++n}`, fieldId = 1) => ({
  id: `m${++n}`, venue_id: venueId, month: "Oct 2026", category: "regular",
  start_utc_ms: utcIso == null ? null : Date.parse(utcIso),
  mdapi_field_id: fieldId, match_date: ymd, match_time: time,
});

function financeData(): FinanceData {
  const venue = (id: number, name: string, billing: string, extra: Record<string, unknown> = {}) => ({
    id, venue_name: name, raw_venue_name: name, city: "Austin", billing_type: billing,
    per_match_rate: 100, cost_per_match: 40, charge_on_cancel: false, bills_per_reservation: false,
    is_active: true, hourly_rate: null, monthly_flat: null, max_spots: 20, dpp_price: 12,
    member_price: null, notes: null, launch_date: null, rate_days: null, pay_schedule: null, ...extra,
  });
  // Mon–Sat $140, Sun $160 (ATH Katy's shape). 4 Oct 2026 is a Sunday.
  const weekdayRates = [{ days: [0, 1, 2, 3, 4, 5], v: 140 }, { days: [6], v: 160 }];
  return {
    venues: [
      venue(1, "Plain Pitch", "per_match", { per_match_rate: 90 }),
      venue(2, "Weekday Pitch", "per_match", { per_match_rate: 140, rate_days: weekdayRates }),
      venue(3, "Slot Pitch", "per_match", { per_match_rate: 75, bills_per_reservation: true }),
      venue(4, "Cancel Pitch", "per_match", { per_match_rate: 60, charge_on_cancel: true }),
      venue(5, "Twin Pitch", "per_match", { per_match_rate: 50 }),
      venue(6, "Twin Pitch", "per_match", { per_match_rate: 120 }),
      venue(7, "Share Pitch", "profit_share", { per_match_rate: null }),
      venue(8, "Idle Pitch", "per_match", { per_match_rate: 80 }),
      venue(9, "Odd Rate Pitch", "per_match", { per_match_rate: 33.33 }),
    ],
    masterSchedule: [
      sched(1, "2026-10-01", "2026-10-01T15:00:00Z"),
      sched(1, "2026-10-02", "2026-10-02T15:00:00Z"),
      // THE TRAP: tonight 7pm Central. Wall clock "19:00Z" is past; the instant (00:00Z on the 4th) is not.
      sched(1, "2026-10-03", "2026-10-04T00:00:00Z", "7:00 PM - 8:00 PM"),
      sched(1, "2026-10-10", "2026-10-10T15:00:00Z"),
      sched(1, "2026-10-11", null), // no instant known: not yet, never "already"
      sched(2, "2026-10-02", "2026-10-02T15:00:00Z"),          // Fri $140, ran
      sched(2, "2026-10-04", "2026-10-04T15:00:00Z"),          // Sun $160, scheduled
      sched(2, "2026-09-27", "2026-09-27T15:00:00Z"),          // other month — not counted
      sched(2, "2026-10-25", "2026-10-25T15:00:00Z"),          // Sun $160, scheduled
      // One slot, two matches — one kicked off, one not (a 30-min stagger on one booking).
      sched(3, "2026-10-03", "2026-10-03T19:30:00Z", "2:00 PM"),
      sched(3, "2026-10-03", "2026-10-03T20:30:00Z", "2:00 PM"),
      sched(3, "2026-10-20", "2026-10-20T15:00:00Z", "10:00 AM"),
      sched(4, "2026-10-01", "2026-10-01T15:00:00Z"),
      sched(5, "2026-10-01", "2026-10-01T15:00:00Z"),
      sched(6, "2026-10-30", "2026-10-30T15:00:00Z"),
      sched(7, "2026-10-01", "2026-10-01T15:00:00Z"),
      sched(7, "2026-10-21", "2026-10-21T15:00:00Z"),
      sched(9, "2026-10-01", "2026-10-01T15:00:00Z"),
      sched(9, "2026-10-02", "2026-10-02T15:00:00Z"),
      sched(9, "2026-10-12", "2026-10-12T15:00:00Z"),
    ].map((s) => ({ ...s, month: s.match_date.startsWith("2026-09") ? "Sep 2026" : s.month })),
    cancelledSchedule: [
      sched(4, "2026-10-02", "2026-10-02T15:00:00Z"),   // cancelled, charged
      sched(4, "2026-10-29", "2026-10-29T15:00:00Z"),   // cancelled, will be charged
      sched(1, "2026-10-02", "2026-10-02T15:00:00Z"),   // venue 1 does not charge on cancel
    ],
    // A hand-set amount must not move the COMPUTED split (it splits autoAmount).
    overrides: [{ id: 1, venue_id: 1, month: "Oct 2026", override_amount: 5000, reason: "x", created_at: "", created_by: "" }],
    partnerDashboards: [{ venueId: 7, revenueSharePct: 50, revenueModel: "flat_percentage", enabled: true }],
    partnerPayoutsByVenueMonth: new Map([["7|Oct 2026", 250]]),
    revenue: [], expenses: [], managerPay: [], pricing: [], memberSpots: [], members: [],
    venueAliases: new Map(), venueFields: new Map(), venueFieldLinks: [], config: {},
    mdapiMemberSpots: emptyMdapiMemberSpotIndex(),
  } as unknown as FinanceData;
}

const data = financeData();
const rows = buildFieldCostRows(data, MONTH);
const row = (name: string) => rows.find((r) => r.displayName === name)!;
const split = (name: string) => fieldCostSplit(data, row(name), MONTH, kicked);

console.log("\nPOSITIVE CONTROL — the fixture has the rows the checks below are about");
{
  is("nine venues → eight rows (the two Twin Pitch legs combine)", rows.length, 8);
  is("Twin Pitch is one combined row", row("Twin Pitch").secondaryVenueIds.length, 1);
  is("the trap row's wall clock reads as past at NOW",
     Date.parse("2026-10-03T19:00:00Z") < NOW, true);
}

console.log("\nEVERY ROW: ran + scheduled === the computed figure (cents), and the line adds up (dollars)");
{
  let priced = 0;
  for (const r of rows) {
    const s = fieldCostSplit(data, r, MONTH, kicked);
    if (!s.priced) continue;
    priced += 1;
    is(`${r.displayName}: ${s.ran} + ${s.scheduled} = autoAmount ${r.autoAmount}`,
       Math.round((s.ran + s.scheduled) * 100), Math.round(r.autoAmount * 100));
    const m = fieldCostSplitText(s, r.autoAmount).match(/^\$([\d,]+) ran so far · \$([\d,-]+) scheduled$/);
    const num = (x: string) => Number(x.replace(/,/g, ""));
    is(`${r.displayName}: displayed parts add to the displayed figure $${Math.round(r.autoAmount)}`,
       m ? num(m[1]) + num(m[2]) : NaN, Math.round(r.autoAmount));
  }
  is("...and that loop checked every per-match row (7), not none", priced, 7);
}

console.log("\nTHE CUT IS THE TRUE INSTANT");
{
  const s = split("Plain Pitch");
  is("Plain Pitch: 2 ran (1st, 2nd)", s.ranUnits, 2);
  is("...3 scheduled: tonight's trap, the 10th, and the null-instant 11th", s.scheduledUnits, 3);
  is("...$180 ran so far", s.ran, 180);
  is("...$270 scheduled", s.scheduled, 270);
  is("...the hand-set $5,000 is not what is split", row("Plain Pitch").autoAmount, 450);
  is("...and venue 1's cancellation is not counted (no charge_on_cancel)", s.ranUnits + s.scheduledUnits, 5);
}

console.log("\nWEEKDAY RATES, SLOTS, CANCELLATIONS, COMBINED LEGS");
{
  const w = split("Weekday Pitch");
  is("Weekday Pitch ran: one Friday at $140", w.ran, 140);
  is("...scheduled: two Sundays at $160", w.scheduled, 320);
  const sl = split("Slot Pitch");
  is("Slot Pitch: a slot with one kicked-off match is ONE reservation, ran", sl.ranUnits, 1);
  is("...the other slot is scheduled", sl.scheduledUnits, 1);
  is("...$75 + $75, never $150 ran by counting the slot on both sides", sl.ran + sl.scheduled, 150);
  const c = split("Cancel Pitch");
  is("Cancel Pitch: played + charged-past-cancellation ran", c.ranUnits, 2);
  is("...the future charged cancellation is scheduled", c.scheduledUnits, 1);
  const t = split("Twin Pitch");
  is("Twin Pitch sums its legs: $50 ran", t.ran, 50);
  is("...$120 scheduled", t.scheduled, 120);
}

console.log("\nPAYOUT VENUES SPLIT IN MATCHES, NOT DOLLARS");
{
  const s = split("Share Pitch");
  is("Share Pitch is not priced per match", s.priced, false);
  is("...1 ran, 1 scheduled", `${s.ranUnits}/${s.scheduledUnits}`, "1/1");
  is("...and reads in matches", fieldCostSplitText(s, row("Share Pitch").autoAmount), "1 ran so far · 1 scheduled");
}

console.log("\nROUNDING — the line adds up even when the parts round apart");
{
  const s = split("Odd Rate Pitch");
  is("Odd Rate Pitch: $66.66 ran, $33.33 scheduled", `${s.ran}/${s.scheduled}`, "66.66/33.33");
  is("...shown as $67 + $33 = $100, the figure as displayed (99.99 → $100)",
     fieldCostSplitText(s, row("Odd Rate Pitch").autoAmount), "$67 ran so far · $33 scheduled");
}

console.log("\nUNDERLYING MATCHES — each line at the rate it is charged; the lines add up to the computed figure");
{
  let lined = 0;
  for (const r of rows) {
    if (!fieldCostSplit(data, r, MONTH, kicked).priced) continue;
    lined += 1;
    const lines = fieldCostMatchLines(data, r, MONTH);
    const total = Math.round(lines.reduce((a, l) => a + l.cost, 0) * 100);
    is(`${r.displayName}: Σ line cost (${total / 100}) === computed ${r.autoAmount}`, total, Math.round(r.autoAmount * 100));
  }
  is("...checked every per-match row (7)", lined, 7);
  const w = fieldCostMatchLines(data, row("Weekday Pitch"), MONTH);
  is("Weekday Pitch has its three October lines (Sep 27 is another month)", w.length, 3);
  is("a Sunday line reads the Sunday rate, $160", w.find((l) => l.date === "2026-10-04")?.rate, 160);
  is("CONTROL — the Friday line reads the base rate, $140", w.find((l) => l.date === "2026-10-02")?.rate, 140);
  const sl = fieldCostMatchLines(data, row("Slot Pitch"), MONTH);
  is("Slot Pitch shows all three matches", sl.length, 3);
  is("...one of them is the second match in a slot", sl.filter((l) => l.sameSlot).length, 1);
  is("...and it costs $0 while still showing the slot's rate", JSON.stringify(sl.filter((l) => l.sameSlot).map((l) => [l.rate, l.cost])), "[[75,0]]");
  const c = fieldCostMatchLines(data, row("Cancel Pitch"), MONTH);
  is("Cancel Pitch lists its two charged cancellations", c.filter((l) => l.cancelled).length, 2);
  is("Plain Pitch does not list a cancellation it is not charged for", fieldCostMatchLines(data, row("Plain Pitch"), MONTH).some((l) => l.cancelled), false);
  is("Twin Pitch lists both legs, each at its own rate", JSON.stringify(fieldCostMatchLines(data, row("Twin Pitch"), MONTH).map((l) => l.rate).sort()), "[120,50]");
  is("a payout venue has no per-match lines", fieldCostMatchLines(data, row("Share Pitch"), MONTH).length, 0);
}

console.log("\nMATCH P&L — cost per match: ONE RATE PER FIELD, weekday-aware (Field Costs rates; an override wins)");
{
  /* ITEMISED (2026-10-09) — BEHAVIOUR CHANGED BY RYAN'S DECISION: "one rate per field; Field Costs is
   * the single source for cost per match", the retired cost_per_match is no longer read, and an
   * optional override (0219) wins on every day. The old assertions here pinned the opposite ruling
   * (2026-10-03: "a weekday stays $114, never the $135 invoice rate"); they are replaced, not edited
   * to pass. Each still holds a CONTROL on a day that must differ. */
  const katy = { cost_per_match: 140, per_match_rate: 140, rate_days: [{ days: [0, 1, 2, 3, 4, 5], v: 140 }, { days: [6], v: 160 }] };
  is("ATH Katy on a Sunday (2026-10-04): $160", costPerMatchOn(katy, "2026-10-04"), 160);
  is("CONTROL — ATH Katy on a Monday (2026-10-05): $140", costPerMatchOn(katy, "2026-10-05"), 140);
  const split = { cost_per_match: 114, per_match_rate: 135, rate_days: [{ days: [0, 1, 2, 3, 4, 5], v: 135 }, { days: [6], v: 150 }] };
  is("a stale cost_per_match ($114) is ignored: the Sunday rate is $150", costPerMatchOn(split, "2026-10-04"), 150);
  is("...and a weekday is the $135 Field Costs rate", costPerMatchOn(split, "2026-10-05"), 135);
  is("no rate_days: the per-match rate, whatever cost_per_match says", costPerMatchOn({ cost_per_match: 125, per_match_rate: 105, rate_days: null }, "2026-10-04"), 105);
  is("no cost_per_match: the rate still prices it (Stony Point read $0 before)", costPerMatchOn({ cost_per_match: null, per_match_rate: 140, rate_days: katy.rate_days }, "2026-10-04"), 160);
  is("no rate at all: null, never $0", costPerMatchOn({ cost_per_match: 140, per_match_rate: null, rate_days: null }, "2026-10-04"), null);
  const ov = { ...split, cost_override_per_match: 110 };
  is("an override wins on a Sunday", costPerMatchOn(ov, "2026-10-04"), 110);
  is("...and on a weekday", costPerMatchOn(ov, "2026-10-05"), 110);
  is("CONTROL — cleared, the weekday rate is back", costPerMatchOn({ ...ov, cost_override_per_match: null }, "2026-10-05"), 135);

  // SOURCE PAIRING, because fetchWeekMatchPnL sits behind Supabase and cannot run in the gate: both
  // of Match P&L's cost reads (played and cancelled) go through the weekday-aware helper with the
  // match's own wall-clock start, and neither reads a venue's flat cost_per_match by id any more.
  const src = readFileSync(new URL("../src/lib/matchPnL.ts", import.meta.url), "utf8");
  is("Match P&L prices both passes with venueCostPerMatch(venues, baseVenueId, r.match_start)", (src.match(/venueCostPerMatch\(venues, baseVenueId, r\.match_start\)/g) ?? []).length, 2);
  is("...the helper goes through costPerMatchOn", /costPerMatchOn\(v, matchStartWall\.slice\(0, 10\)\)/.test(src), true);
  is("NEGATIVE — no two-argument (day-blind) call is left", /venueCostPerMatch\(venues, baseVenueId\)/.test(src), false);
}

console.log("\nSOCCER CENTRAL — two rates by match size; the two lines add up to the amount; a set month covers both");
{
  const sc = (extra: Record<string, unknown> = {}) => {
    const d = financeData();
    (d as unknown as { venues: unknown[] }).venues = [
      { ...d.venues[0], id: 11, venue_name: "Soccer Central", raw_venue_name: "Soccer Central", per_match_rate: 90, rate_days: null, charge_on_cancel: false },
      { ...d.venues[0], id: 53, venue_name: "Soccer Central Tournament", raw_venue_name: "Soccer Central Tournament", per_match_rate: 160, rate_days: null, charge_on_cancel: true, is_active: false },
    ];
    (d as unknown as { masterSchedule: unknown[] }).masterSchedule = [
      ...[1, 2, 3, 4].map((k) => sched(11, `2026-10-0${k}`, "2026-10-01T15:00:00Z")),
      ...Array.from({ length: 55 }, (_, k) => sched(53, `2026-10-${String(5 + (k % 25)).padStart(2, "0")}`, "2026-10-30T15:00:00Z")),
    ];
    (d as unknown as { cancelledSchedule: unknown[] }).cancelledSchedule = [];
    (d as unknown as { overrides: unknown[] }).overrides = (extra.overrides as unknown[]) ?? [];
    return d;
  };
  const d = sc();
  const r = buildFieldCostRows(d, MONTH).find((x) => x.primaryVenueId === 11)!;
  const parts = capacitySplitOf(d, r)!;
  is("Soccer Central's row has a two-part split", parts?.length, 2);
  is("Normal: 4 × $90 = $360", JSON.stringify([parts[0].label, parts[0].count, parts[0].rate, parts[0].amount]), JSON.stringify(["Normal", 4, 90, 360]));
  is("Tournament: 55 × $160 = $8,800", JSON.stringify([parts[1].label, parts[1].count, parts[1].rate, parts[1].amount]), JSON.stringify(["Tournament", 55, 160, 8800]));
  is("the two lines add up to the amount: $9,160", parts[0].amount + parts[1].amount, r.amount);
  is("...and the amount is $9,160", r.amount, 9160);
  is("the rule text comes from the code's threshold", `${parts[0].rule} / ${parts[1].rule}`, "22 players or fewer / more than 22 players");
  is("CONTROL — an ordinary row has no split", capacitySplitOf(data, row("Plain Pitch")), null);
  const set = sc({ overrides: [{ id: 1, venue_id: 11, month: "Oct 2026", override_amount: 5600, reason: "invoice", created_at: "", created_by: "x" }] });
  const rs = buildFieldCostRows(set, MONTH).find((x) => x.primaryVenueId === 11)!;
  is("a month with an amount on the venue uses it for BOTH rates: $5,600, not $5,600 + $8,800", rs.amount, 5600);
  const bank53 = sc({ overrides: [{ id: 2, venue_id: 53, month: "Oct 2026", override_amount: 0, reason: "twin leg", created_at: "", created_by: "field-cost-2026-reconciliation" }, { id: 3, venue_id: 11, month: "Oct 2026", override_amount: 2340, reason: "bank", created_at: "", created_by: "field-cost-2026-reconciliation" }] });
  is("a loaded month on both rows ($2,340 + $0) stays $2,340", buildFieldCostRows(bank53, MONTH).find((x) => x.primaryVenueId === 11)!.amount, 2340);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
