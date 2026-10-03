// OPEX — Sunday-start weeks, the page's own header, and projections, against the real builders.
//   npx tsx scripts/opex-projections-test.ts
//
// WHAT THIS GUARDS (Ryan, 2026-10-03):
//   1. THE WEEK STARTS ON SUNDAY on OpEx and the Master Schedule, from ONE constant
//      (src/lib/weekStart.ts) — and the pages that keep Monday (Match Promotion, the Veo dashboard)
//      still get Monday from the same helpers when they do not pass it.
//   2. OpEx draws its own header: the shell leaves the FINANCE title and period bar out there only.
//   3. PROJECTIONS — money that might leave, added by hand on OpEx:
//        · with "Show projections" off, every figure equals the build without projections
//        · paid + expected + projected = the header total, with them on
//        · a weekly projection from the 5th lands on the 5th, 12th, 19th and 26th
//        · a projection whose day is over is not shown and not counted (was: "still projected")
//   4. THE AUTOMATIC MATCH MANAGER PAY PROJECTION: the mean of the four closed weeks it shows; none on a
//      Tuesday that has real match manager pay rows; every Tuesday through two months out.
// The mock assert (scripts/mocks/opex-calendar-v3.assert.mjs) is left to the session editing it.

import { buildOpexCalendarAsOf } from "../src/lib/opexSources";
import { paymentsOf, sumOf } from "../src/lib/opexLedger";
import { projectionDatesIn, type OpexProjection } from "../src/lib/opexProjectionModel";
import { WEEK_START, isWeekendColumn, monthLayout, weekdayHeaders, weekEndOnOrAfter, weekStartOf, weekStartOnOrBefore } from "../src/lib/weekStart";
import { drawsOwnHeader } from "../src/lib/financeChrome";
import { autoMatchManagerPay } from "../src/lib/opexAutoProjection";
import type { FinanceData, FinVenue } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("\n1. THE WEEK STARTS ON SUNDAY — one constant, both pages");
{
  is("WEEK_START is Sunday (getDay() 0)", WEEK_START, 0);
  is("column labels run Sun to Sat", weekdayHeaders(), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  is("the weekend columns are the first and the last", [0, 1, 2, 3, 4, 5, 6].filter((i) => isWeekendColumn(i)), [0, 6]);
  const oct = monthLayout(2026, 9);
  is("October 2026 (1st is a Thursday): 4 leading blank days, Sun 27 – Wed 30 Sep", oct.lead, 4);
  is("...5 week rows", oct.weeks, 5);
  is("week 1 is Oct 1–3, week 2 starts Sunday Oct 4", [oct.rangeOf(0), oct.rangeOf(1)], [[1, 3], [4, 10]]);
  is("Oct 4 (Sun) and Oct 10 (Sat) are in the same week; Oct 11 starts the next", [oct.weekOf(4), oct.weekOf(10), oct.weekOf(11)], [1, 1, 2]);
  is("the week containing Wed Oct 7 starts Sun Oct 4", weekStartOf(new Date(2026, 9, 7)).getDate(), 4);
  is("Master Schedule month grid bounds: Sun on or before Thu Oct 1 is Sep 27", weekStartOnOrBefore("2026-10-01"), "2026-09-27");
  is("...and the Sat on or after Sat Oct 31 is itself", weekEndOnOrAfter("2026-10-31"), "2026-10-31");
  // POSITIVE CONTROL for the pages that keep Monday: the same helper, asked for Monday, gives Monday.
  is("CONTROL — Match Promotion / Veo dashboard still get Monday weeks (ws = 1): Wed Oct 7 → Mon Oct 5", weekStartOf(new Date(2026, 9, 7), 1).getDate(), 5);
  is("CONTROL — ws = 1 column labels still run Mon to Sun", weekdayHeaders(1), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
}

console.log("\n2. OPEX DRAWS ITS OWN HEADER — and only OpEx");
{
  is("OpEx: no FINANCE title, no period bar", drawsOwnHeader("/admin/finance/opex"), true);
  for (const p of ["/admin/finance/cost", "/admin/finance/cities", "/admin/finance/revenue", "/admin/finance/cash-flow", "/admin/finance/ledger/field-costs"]) {
    is(`${p} keeps the Finance title and period bar`, drawsOwnHeader(p), false);
  }
}

// ── a fixture month: real money of three kinds (paid, expected) and projections ─────────────────
function venue(id: number, name: string, over: Partial<FinVenue> = {}): FinVenue {
  return {
    id, venue_name: name, raw_venue_name: name, city: "Austin", billing_type: "per_match",
    per_match_rate: 100, cost_per_match: 100, hourly_rate: null, monthly_flat: null, max_spots: 20,
    dpp_price: null, member_price: null, notes: null, launch_date: null, is_active: true,
    charge_on_cancel: false, bills_per_reservation: false, billing_cadence: "monthly",
    billing_day: null, billing_anchor_month: null, billing_weekday: null, billing_custom_days: {},
    pay_schedule: { mode: "dates", dates: [{ d: 15 }], prepaid: false }, rate_days: null, ...over,
  } as FinVenue;
}
let n = 0;
const match = (venueId: number, d: number) => {
  const ymd = `2026-10-${String(d).padStart(2, "0")}`;
  return { id: `m${++n}`, city: "Austin", venue: `v${venueId}`, match_date: ymd, match_time: `7:00 PM ${n}`, month: "Oct 2026",
    max_spots: 20, mdapi_field_id: 1, venue_id: venueId, duration_hours: 1, category: "regular", start_utc_ms: Date.parse(`${ymd}T23:00:00Z`) };
};
const expense = (id: number, date: string, category: string, amount: number) =>
  ({ id, date, month: "Oct 2026", city: "Austin", category, vendor: `v${id}`, notes: null, amount, manual_entry: true });
const data = {
  venues: [venue(1, "Match Pitch", { pay_schedule: { mode: "match" } }), venue(2, "Dated Pitch")],
  masterSchedule: [match(1, 2), match(1, 9), match(1, 23), match(2, 6), match(2, 20)],
  cancelledSchedule: [], overrides: [],
  expenses: [expense(11, "2026-10-01", "City Manager", 500), expense(12, "2026-10-28", "Subscriptions", 99)],
  revenue: [], managerPay: [], schedule: [], memberSpots: [], members: [], pricing: [],
  venueAliases: new Map(), venueFields: new Map(), config: {},
  mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
  partnerDashboards: [], partnerPayoutsByVenueMonth: new Map(),
} as unknown as FinanceData;

const proj = (id: number, over: Partial<OpexProjection>): OpexProjection => ({
  id, category: "misc", description: `Projection ${id}`, amount: 100, first_date: "2026-10-05", repeat: "once", end_date: null, skipped_dates: [], ...over,
});
const PROJ: OpexProjection[] = [
  proj(1, { category: "pers", description: "A new city manager", amount: 400, first_date: "2026-10-05", repeat: "weekly" }),
  proj(2, { category: "field", description: "A field we might open", amount: 1500, first_date: "2026-10-01", repeat: "once" }),   // in the PAST on Oct 20
  proj(3, { category: "equip", description: "Goals", amount: 250, first_date: "2026-09-16", repeat: "biweekly", end_date: "2026-10-31" }),
  proj(4, { category: "subs", description: "A tool", amount: 49.99, first_date: "2026-01-31", repeat: "monthly" }),
];
const NOW = new Date(2026, 9, 20, 12);   // Oct 20: the 1st–20th have passed

console.log("\n3a. \"SHOW PROJECTIONS\" OFF EQUALS THE BUILD WITHOUT PROJECTIONS");
{
  const without = buildOpexCalendarAsOf(data, 2026, 9, NOW);
  const off = buildOpexCalendarAsOf(data, 2026, 9, NOW, []);    // what the page builds with the box off
  is("every figure — groups, day totals, cumulative, month, paid — is identical", JSON.stringify(off), JSON.stringify(without));
  is("...and so is every ledger payment", JSON.stringify(paymentsOf(off)), JSON.stringify(paymentsOf(without)));
  const on = buildOpexCalendarAsOf(data, 2026, 9, NOW, PROJ);
  is("CONTROL — with them on the month really is different (the check above is not comparing two empty builds)", on.monthTotal !== without.monthTotal && without.monthTotal > 0, true);
  const real = (ps: ReturnType<typeof paymentsOf>) => JSON.stringify(ps.filter((p) => !p.projected));
  is("with them on, the REAL payments are untouched — projections only add their own", real(paymentsOf(on)), real(paymentsOf(without)));
  is("...and the paid figure does not move", on.paidTotal, without.paidTotal);
}

console.log("\n3b. PAID + EXPECTED + PROJECTED = THE HEADER TOTAL");
{
  const on = buildOpexCalendarAsOf(data, 2026, 9, NOW, PROJ);
  const ps = paymentsOf(on);
  const paid = sumOf(ps.filter((p) => p.paid));
  const projected = sumOf(ps.filter((p) => p.projected));
  const expected = sumOf(ps.filter((p) => !p.paid && !p.projected));
  is(`${paid} + ${expected} + ${projected} = ${sumOf(ps)}`, Math.round((paid + expected + projected) * 100), Math.round(sumOf(ps) * 100));
  is("...and that total is the builder's month total", sumOf(ps), on.monthTotal);
  is("CONTROL — all three parts are non-zero here", paid > 0 && expected > 0 && projected > 0, true);
  // Day and week totals carry projections too, and still add up.
  const days = Object.values(on.dayTotal).reduce((s, v) => s + v, 0);
  is("the day totals add up to the month total (nothing undated in this fixture)", Math.round(days * 100), Math.round(on.monthTotal * 100));
  const layout = monthLayout(2026, 9);
  const weekly = new Array(layout.weeks).fill(0);
  for (const p of ps) if (p.day != null) weekly[layout.weekOf(p.day)] += p.amount;
  is("the Sunday-to-Saturday week totals add up to the month", Math.round(weekly.reduce((s, v) => s + v, 0) * 100), Math.round(on.monthTotal * 100));
  const w2 = sumOf(ps.filter((p) => p.day != null && p.day >= 4 && p.day <= 10));
  is("the week of Sun Oct 4 – Sat Oct 10 is exactly those seven days", Math.round(weekly[1] * 100), Math.round(w2 * 100));
}

console.log("\n3c. A WEEKLY PROJECTION FROM THE 5TH: THE 5TH, 12TH, 19TH AND 26TH");
{
  is("dates", projectionDatesIn(PROJ[0], 2026, 9), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  // Seen on Oct 1, before its first date, so none of the four has passed (a passed one now drops off
  // — 3d). Was seen on Oct 20 before that rule.
  const on = buildOpexCalendarAsOf(data, 2026, 9, new Date(2026, 9, 1, 9), PROJ);
  const days = paymentsOf(on).filter((p) => p.projected?.id === 1).map((p) => p.day).sort((a, b) => (a ?? 0) - (b ?? 0));
  is("...and those are the calendar days its payments land on", days, [5, 12, 19, 26]);
  is("it carries forward: November's are the 2nd, 9th, 16th, 23rd and 30th", projectionDatesIn(PROJ[0], 2026, 10).map((d) => +d.slice(8)), [2, 9, 16, 23, 30]);
  is("every 2 weeks from Sep 16, ending Oct 31: Oct 14 and Oct 28", projectionDatesIn(PROJ[2], 2026, 9), ["2026-10-14", "2026-10-28"]);
  is("...and nothing in November, after its end date", projectionDatesIn(PROJ[2], 2026, 10), []);
  is("monthly from Jan 31: Oct 31, and Nov 30 where November has no 31st", [projectionDatesIn(PROJ[3], 2026, 9), projectionDatesIn(PROJ[3], 2026, 10)], [["2026-10-31"], ["2026-11-30"]]);
  is("a payment removed on its own is gone, the rest stay", projectionDatesIn({ ...PROJ[0], skipped_dates: ["2026-10-12"] }, 2026, 9).map((d) => +d.slice(8)), [5, 19, 26]);
  is("nothing before the first date", projectionDatesIn(PROJ[0], 2026, 8), []);
}

console.log("\n3d. A PROJECTION WHOSE DAY IS OVER IS NOT SHOWN AND NOT COUNTED (rule changed 2026-10-03)");
{
  // Was: "a projection dated in the past is still projected, not paid". Ryan replaced that rule: once
  // its day is over a projection drops off; for a repeating one only the passed dates go.
  const on = buildOpexCalendarAsOf(data, 2026, 9, NOW, PROJ);   // NOW = Oct 20
  const ps = paymentsOf(on);
  is("the one-off Oct 1 projection is not shown on Oct 20", ps.some((p) => p.projected?.id === 2), false);
  is("the weekly one keeps only its days from today on: Oct 26 (5th, 12th and 19th have passed)", ps.filter((p) => p.projected?.id === 1).map((p) => p.day), [26]);
  is("...the stored row is untouched — its dates are still all four", projectionDatesIn(PROJ[0], 2026, 9).length, 4);
  const today = buildOpexCalendarAsOf(data, 2026, 9, new Date(2026, 9, 26, 9), PROJ);
  is("today's own date still shows (Oct 26, seen on Oct 26)", paymentsOf(today).some((p) => p.projected?.id === 1 && p.day === 26), true);
  const without = buildOpexCalendarAsOf(data, 2026, 9, NOW);
  const proj = sumOf(ps.filter((p) => p.projected));
  is("passed projections are not counted: month total = the build without + only the open ones", Math.round(on.monthTotal * 100), Math.round((without.monthTotal + proj) * 100));
  is("CONTROL — the open projections really are there (Oct 26 weekly, Oct 28 goals, Oct 31 tool)", ps.filter((p) => p.projected).map((p) => p.day).sort((a, b) => (a ?? 0) - (b ?? 0)), [26, 28, 31]);
  const past = buildOpexCalendarAsOf(data, 2026, 8, NOW, PROJ);   // September, entirely over
  is("a month that is over shows no projections at all", paymentsOf(past).some((p) => p.projected), false);
  const future = buildOpexCalendarAsOf(data, 2026, 10, NOW, PROJ);
  is("CONTROL — a future month shows them all (November's weekly: 5 dates)", paymentsOf(future).filter((p) => p.projected?.id === 1).length, 5);
}

console.log("\n4. THE AUTOMATIC MATCH MANAGER PAY PROJECTION");
{
  // Real rows for the last six Tuesdays, two cities each — Sep 8–29 as on 2026-10-03 — plus the
  // week in progress (Oct 6, $2,000) which must NOT be averaged and must keep its real amount.
  const mm = (id: number, date: string, city: string, amount: number) =>
    ({ id, date, month: `${["Sep", "Oct"][Number(date.slice(5, 7)) - 9]} 2026`, city, category: "Match Manager Pay", vendor: "Weekly payroll", notes: null, amount, manual_entry: false });
  const weeks: [string, number][] = [["2026-09-01", 2215], ["2026-09-08", 2110], ["2026-09-15", 2160], ["2026-09-22", 2525], ["2026-09-29", 2165], ["2026-10-06", 2000]];
  let id = 100;
  const expenses = weeks.flatMap(([d, t]) => [mm(id++, d, "Austin", t - 500), mm(id++, d, "Dallas", 500)]);
  const d2 = { ...data, expenses } as unknown as FinanceData;
  const OCT3 = new Date(2026, 9, 3, 12);
  const auto = autoMatchManagerPay(expenses as never, OCT3);
  is("the four weeks are the last four CLOSED ones: Sep 29, 22, 15, 8 (not Oct 6, in progress)", auto.basis.map((w) => w.tuesday), ["2026-09-29", "2026-09-22", "2026-09-15", "2026-09-08"]);
  is("...each with its real total across cities", auto.basis.map((w) => w.total), [2165, 2525, 2160, 2110]);
  is("...and its work week (Monday, eight days before)", auto.basis[0].weekStart, "2026-09-21");
  const mean = Math.round(auto.basis.reduce((s, w) => s + w.total, 0) / auto.basis.length * 100) / 100;
  is(`the projected amount is the mean of the four weeks shown: $${mean}`, auto.amount, mean);
  is("...which is $2,240 here", auto.amount, 2240);
  is("Tuesdays projected: Oct 13 through Dec 1 (Oct 6 has real rows; Dec 8 is past two months)", auto.tuesdays, ["2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24", "2026-12-01"]);

  const on = buildOpexCalendarAsOf(d2, 2026, 9, OCT3, [], true);
  const ps = paymentsOf(on);
  const autoPs = ps.filter((p) => p.projected?.auto);
  is("on the calendar: Oct 13, 20 and 27, each $2,240", autoPs.map((p) => [p.day, p.amount]), [[13, 2240], [20, 2240], [27, 2240]]);
  is("a Tuesday with real match manager pay rows shows no automatic projection (Oct 6)", autoPs.some((p) => p.day === 6), false);
  is("...and shows its real amount instead: $2,000, not projected", sumOf(ps.filter((p) => p.day === 6 && p.sub === "Match manager pay" && !p.projected)), 2000);
  is("the auto rows are Personnel and counted as projected, never paid", autoPs.every((p) => p.cat === "pers" && !p.paid), true);
  const off = buildOpexCalendarAsOf(d2, 2026, 9, OCT3, [], false);
  is("\"Show projections\" off: every figure equals the build without projections", JSON.stringify(off), JSON.stringify(buildOpexCalendarAsOf(d2, 2026, 9, OCT3)));
  is("CONTROL — on, the month really is $6,720 more (3 × $2,240)", Math.round((on.monthTotal - off.monthTotal) * 100), 672000);
  const nov = paymentsOf(buildOpexCalendarAsOf(d2, 2026, 10, OCT3, [], true)).filter((p) => p.projected?.auto).map((p) => p.day);
  is("it rolls into November: the 3rd, 10th, 17th and 24th", nov, [3, 10, 17, 24]);
  const late = autoMatchManagerPay(expenses as never, new Date(2026, 9, 10, 12));
  is("the window rolls: on Oct 10 the closed weeks are Oct 6, Sep 29, 22, 15", late.basis.map((w) => w.tuesday), ["2026-10-06", "2026-09-29", "2026-09-22", "2026-09-15"]);
  is("with fewer than four closed weeks there is no automatic projection", autoMatchManagerPay(expenses.slice(0, 6) as never, OCT3).tuesdays, []);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
