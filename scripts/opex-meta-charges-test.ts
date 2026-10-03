// OPEX — Meta ad charges on their real days (option B), against the real builders.
//   npx tsx scripts/opex-meta-charges-test.ts
//
// WHAT THIS GUARDS (Ryan, 2026-10-03):
//   · charges + the unbilled balance = spend to date, to the cent — the reproduction's bookkeeping
//   · every charge Meta logged keeps its real time and amount; a gap between two logged bill-date
//     charges closes exactly (the cash between them is the spend between them)
//   · OpEx shows NO month-end Meta row once it shows the charges — ad spend never twice — while a
//     non-Meta marketing row stays
//   · the Cost report's monthly marketing figure is unchanged (it reads spend from Expenses, and
//     nothing here touches Expenses)
//   · the automatic projection: the 28-day average, $900 charges, only with "Show projections",
//     never on a day that is over; the threshold follows Meta's last two charges when they agree

import { buildMetaCash, chicagoYmdOf, thresholdInUse, META_BILLING_THRESHOLD_CENTS, type DailySpend, type LoggedCharge } from "../src/lib/metaCharges";
import { buildOpexCalendarAsOf } from "../src/lib/opexSources";
import { paymentsOf, sumOf } from "../src/lib/opexLedger";
import { monthlyExpenseCategoryFor } from "../src/lib/financeStats";
import type { FinanceData } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── the fixture: $200.00 of spend every Bogota day from Aug 1 to Oct 2, and $110 so far on Oct 3
const daily: DailySpend[] = [];
for (let t = Date.UTC(2026, 7, 1); t <= Date.UTC(2026, 9, 2); t += 86_400_000) daily.push({ date: new Date(t).toISOString().slice(0, 10), cents: 20_000 });
daily.push({ date: "2026-10-03", cents: 11_000 });
// What Meta logged — incomplete on purpose: a bill on Aug 6, one threshold charge, a bill on Sep 9,
// then two threshold charges. The Aug 6 → Sep 9 window is missing charges.
const logged: LoggedCharge[] = [
  { at: "2026-08-06T08:07:00.000Z", cents: 61_300 },
  { at: "2026-08-15T02:41:00.000Z", cents: 90_000 },
  { at: "2026-09-09T02:15:00.000Z", cents: 80_400 },
  { at: "2026-09-13T20:35:00.000Z", cents: 90_000 },
  { at: "2026-09-18T05:11:00.000Z", cents: 90_000 },
];
const NOW = new Date("2026-10-03T20:00:00.000Z");            // 3 PM Central, Oct 3
const HORIZON = Date.UTC(2027, 0, 1, 6);                      // through Dec 31, Central
const model = buildMetaCash({ daily, logged, now: NOW, horizonEndMs: HORIZON });

console.log("\nTHE BOOKKEEPING — charges + unbilled = spend, to the cent");
{
  is(`$${model.chargedToDateCents / 100} charged + $${model.unbilledCents / 100} unbilled = $${model.spendToDateCents / 100} spent`, model.chargedToDateCents + model.unbilledCents, model.spendToDateCents);
  is("CONTROL — spend to date is real (Aug 6 08:00 UTC → now, about $11,520)", model.spendToDateCents > 1_100_000 && model.spendToDateCents < 1_200_000, true);
  is("the unbilled balance is below the threshold (else a charge would have been taken)", model.unbilledCents >= 0 && model.unbilledCents < META_BILLING_THRESHOLD_CENTS, true);
}

console.log("\nMETA'S OWN RECORD — every logged charge keeps its time and amount");
{
  for (const c of logged) {
    is(`${c.at.slice(0, 16)} $${c.cents / 100} is on the list as Meta's`, model.charges.some((x) => x.at === c.at && x.cents === c.cents && x.source === "meta"), true);
  }
  // The closed segment Aug 6 → Sep 9: everything charged in it, plus the closing bill, is its spend.
  const a = Date.parse(logged[0].at), b = Date.parse(logged[2].at);
  const inSeg = model.charges.filter((c) => Date.parse(c.at) > a && Date.parse(c.at) <= b).reduce((s, c) => s + c.cents, 0);
  const hourA = Math.floor(a / 3_600_000) * 3_600_000 + 3_600_000, hourB = Math.floor(b / 3_600_000) * 3_600_000 + 3_600_000;
  const segSpend = daily.reduce((s, d) => {
    const d0 = Date.parse(`${d.date}T05:00:00Z`);
    let x = 0;
    // The model's split: whole cents per hour, the remainder on the first hours (20000 → 8 × 834 + 16 × 833).
    const base = Math.floor(d.cents / 24), rest = d.cents - base * 24;
    for (let h = 0; h < 24; h++) { const t = d0 + h * 3_600_000; if (t >= hourA && t < hourB) x += base + (h < rest ? 1 : 0); }
    return s + x;
  }, 0);
  is(`the Aug 6 → Sep 9 gap closes exactly: $${inSeg / 100} charged = $${Math.round(segSpend) / 100} spent`, inSeg, Math.round(segSpend));
  const filled = model.charges.filter((c) => c.source === "spend" && Date.parse(c.at) > a && Date.parse(c.at) < b);
  is("...the missing ones are worked out from spend (not invented as Meta's)", filled.length >= 1 && filled.every((c) => c.cents <= META_BILLING_THRESHOLD_CENTS), true);
  is("after Sep 18, with nothing logged, charges are worked out from spend at the threshold", model.charges.filter((c) => c.source === "spend" && c.at > "2026-09-18T06" && c.at < NOW.toISOString()).every((c) => c.cents === 90_000 || c.kind === "bill"), true);
}

console.log("\nOPEX — the charges replace the month-end Meta row; spend stays in Expenses");
{
  const exp = (id: number, date: string, vendor: string, amount: number, manual: boolean) =>
    ({ id, date, month: "Sep 2026", city: "Austin", category: "Marketing", vendor, notes: "Ads", amount, manual_entry: manual });
  const data = {
    venues: [], masterSchedule: [], cancelledSchedule: [], overrides: [],
    expenses: [exp(1, "2026-09-30", "Meta", 4_500, false), exp(2, "2026-09-30", "Meta", 1_284.13, false), exp(3, "2026-09-12", "Billboard Co", 300, true)],
    revenue: [], managerPay: [], schedule: [], memberSpots: [], members: [], pricing: [],
    venueAliases: new Map(), venueFields: new Map(), config: {},
    mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"],
    partnerDashboards: [], partnerPayoutsByVenueMonth: new Map(),
  } as unknown as FinanceData;
  const before = JSON.stringify(data.expenses);
  const costBefore = monthlyExpenseCategoryFor(data, "Sep 2026" as never, "marketing");

  const without = paymentsOf(buildOpexCalendarAsOf(data, 2026, 8, NOW));
  const withMeta = paymentsOf(buildOpexCalendarAsOf(data, 2026, 8, NOW, [], false, model));
  is("CONTROL — without the charges, September shows the month-end Meta rows on the 30th", without.filter((p) => p.payee === "Meta" && p.day === 30).length, 2);
  is("with the charges, OpEx shows NO month-end Meta row", withMeta.some((p) => p.payee === "Meta"), false);
  const sepCharges = model.charges.filter((c) => c.source !== "auto" && chicagoYmdOf(c.at).startsWith("2026-09"));
  is("...it shows September's charges instead, one ledger row each", withMeta.filter((p) => p.payee === "Meta ads").length, sepCharges.length);
  is("...on their days", withMeta.filter((p) => p.payee === "Meta ads").map((p) => p.day).sort((x, y) => (x ?? 0) - (y ?? 0)), sepCharges.map((c) => Number(chicagoYmdOf(c.at).slice(8, 10))).sort((x, y) => x - y));
  is("...each saying where it came from", [...new Set(withMeta.filter((p) => p.payee === "Meta ads").map((p) => p.sub))].sort(), ["From Meta's record", "Worked out from spend"]);
  is("...and they are paid (September is over)", withMeta.filter((p) => p.payee === "Meta ads").every((p) => p.paid), true);
  is("a non-Meta marketing row stays (Billboard Co, Sep 12)", withMeta.some((p) => p.payee === "Billboard Co" && p.day === 12), true);
  is("Expenses itself is untouched", JSON.stringify(data.expenses), before);
  is(`the Cost report's monthly marketing figure is unchanged: $${costBefore}`, monthlyExpenseCategoryFor(data, "Sep 2026" as never, "marketing"), costBefore);
  is("CONTROL — and it is the SPEND ($6,084.13), not the cash charged", costBefore, 6_084.13);
  const july = paymentsOf(buildOpexCalendarAsOf({ ...data, expenses: [{ ...exp(9, "2026-07-31", "Meta", 2_000, true), month: "Jul 2026" }] } as FinanceData, 2026, 6, NOW, [], false, model));
  is("a month before August keeps its own ad rows (the hand-entered July one) and gets no charges", [july.some((p) => p.payee === "Meta"), july.some((p) => p.payee === "Meta ads")], [true, false]);
}

console.log("\nTHE AUTOMATIC PROJECTION — 28-day average, threshold charges, only with Show projections");
{
  is("the daily average is the mean of the last 28 complete days ($200.00)", model.dailyAvgCents, 20_000);
  is("...over Sep 5 – Oct 2", [model.avgFrom, model.avgTo], ["2026-09-05", "2026-10-02"]);
  const auto = model.charges.filter((c) => c.source === "auto");
  is("projected charges are all after now", auto.every((c) => Date.parse(c.at) >= NOW.getTime()), true);
  is("...threshold charges are exactly $900; the 6th takes the rest", auto.every((c) => c.kind === "bill" || c.cents === 90_000), true);
  is("...a bill-date charge on Nov 6 and Dec 6", auto.filter((c) => c.kind === "bill").map((c) => c.at.slice(0, 10)), ["2026-10-06", "2026-11-06", "2026-12-06"]);
  is("...and nothing past the two months after this one", auto.every((c) => c.at < "2027-01-01T06"), true);
  const data = { venues: [], masterSchedule: [], cancelledSchedule: [], overrides: [], expenses: [], revenue: [], managerPay: [], schedule: [], memberSpots: [], members: [], pricing: [], venueAliases: new Map(), venueFields: new Map(), config: {}, mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"], partnerDashboards: [], partnerPayoutsByVenueMonth: new Map() } as unknown as FinanceData;
  const on = paymentsOf(buildOpexCalendarAsOf(data, 2026, 9, NOW, [], true, model));
  const off = buildOpexCalendarAsOf(data, 2026, 9, NOW, [], false, model);
  is("with Show projections ON, October has auto Meta charges", on.filter((p) => p.projected?.autoMeta).length > 0, true);
  is("...tagged as Marketing, never paid", on.filter((p) => p.projected?.autoMeta).every((p) => p.cat === "mkt" && !p.paid), true);
  is("...none on a day that is over (before Oct 3)", on.filter((p) => p.projected?.autoMeta).every((p) => (p.day ?? 0) >= 3), true);
  is("with it OFF, no projected Meta charge at all", paymentsOf(off).some((p) => p.projected), false);
  const octPast = model.charges.filter((c) => c.source !== "auto" && chicagoYmdOf(c.at).startsWith("2026-10"));
  is("CONTROL — the model has a charge in October already (worked out from spend)", octPast.length >= 1, true);
  is("...and with projections OFF October still shows it, paid, on its day", paymentsOf(off).filter((p) => p.payee === "Meta ads" && p.paid).map((p) => p.day), octPast.map((c) => Number(chicagoYmdOf(c.at).slice(8, 10))));
  const projected = sumOf(on.filter((p) => p.projected));
  is("the projected figure is the auto charges' total", Math.round(projected * 100), on.filter((p) => p.projected?.autoMeta).reduce((s, p) => s + Math.round(p.amount * 100), 0));
}

console.log("\nTHE THRESHOLD — $900 on file, unless Meta's last two charges agree on another");
{
  is("last two $900 → $900, not flagged", thresholdInUse(logged.slice(-2)), { stored: 90_000, inUse: 90_000, changed: false });
  is("last two $1,200 → $1,200, flagged as changed", thresholdInUse([...logged, { at: "2026-10-01T00:00:00.000Z", cents: 120_000 }, { at: "2026-10-02T00:00:00.000Z", cents: 120_000 }]), { stored: 90_000, inUse: 120_000, changed: true });
  is("last two that disagree → the stored $900", thresholdInUse([{ at: "2026-10-01T00:00:00.000Z", cents: 61_300 }, { at: "2026-10-02T00:00:00.000Z", cents: 120_000 }]).inUse, 90_000);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (pass === 0 || fail > 0) process.exit(1);
