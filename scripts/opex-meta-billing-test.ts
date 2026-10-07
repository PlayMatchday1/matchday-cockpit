// OPEX — Meta ad charges from Meta's record (rebuilt 2026-10-07), against the real builders.
//   npx tsx scripts/opex-meta-billing-test.ts
//
// Replaces opex-meta-charges-test.ts, which guarded the reproduction from daily spend — retired by
// Ryan on 2026-10-07 ("Don't work out any charges from spend"). Its OpEx assertions are carried
// here unchanged in substance; its reproduction and 28-day-average assertions are gone with the code.
//
// WHAT THIS GUARDS:
//   · paid charges are exactly Meta's record (a refund stays negative), nothing invented
//   · the projection: from Meta's balance, at the daily budget, $900 threshold charges, the rest on
//     the 6th; integer cents; nothing past the horizon
//   · RULE 1 (Ryan): a real charge replaces the projected one it matches — never paid AND projected
//   · RULE 2 (Ryan): a projected charge whose moment passes with no charge moves to now, never stays
//     in the past
//   · OpEx: loaded → no month-end Meta row, the charges instead; "pending" → no Meta money at all and
//     metaPending; null (every other caller) → the month-end rows; Expenses and the Cost report
//     untouched; July keeps its hand rows; projections only with "Show projections", never paid

import { metaCashFromRecord, chicagoYmdOf, META_BILLING_THRESHOLD_CENTS, type PaidCharge } from "../src/lib/metaCharges";
import { buildOpexCalendarAsOf } from "../src/lib/opexSources";
import { paymentsOf, sumOf } from "../src/lib/opexLedger";
import { monthlyExpenseCategoryFor } from "../src/lib/financeStats";
import type { FinanceData } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const BUDGET = { cents: 19_000, from: "2026-10-07" };
const HORIZON = Date.UTC(2027, 0, 1, 6);                      // through Dec 31, Central
const paid: PaidCharge[] = [
  { at: "2026-09-27T23:12:22.000Z", cents: 90_000 },
  { at: "2026-10-02T17:16:28.000Z", cents: 90_000 },
  { at: "2026-10-05T02:00:30.000Z", cents: 48_800 },
  { at: "2026-10-06T18:40:58.000Z", cents: 12_793 },
  { at: "2026-10-06T19:53:12.000Z", cents: 171 },
];
const READ = { at: "2026-10-07T10:00:54.000Z", cents: 11_584 };   // $115.84, read by the sync
const NOW = new Date("2026-10-07T20:00:00.000Z");                // 3 PM Central, Oct 7
const model = metaCashFromRecord({ paid, balance: READ, now: NOW, horizonEndMs: HORIZON, budget: BUDGET });
const auto = model.charges.filter((c) => c.source === "auto");

console.log("\nPAID — exactly Meta's record");
{
  const mine = model.charges.filter((c) => c.source === "meta");
  is("every paid charge is on the list with its time and amount", mine.map((c) => [c.at, c.cents]), paid.map((c) => [c.at, c.cents]));
  const r = metaCashFromRecord({ paid: [...paid, { at: "2026-10-03T12:00:00.000Z", cents: -5_000 }], balance: READ, now: NOW, horizonEndMs: HORIZON, budget: BUDGET });
  is("a refund stays negative, as Meta's", r.charges.filter((c) => c.source === "meta" && c.cents < 0).map((c) => c.cents), [-5_000]);
  is("CONTROL — there are projected charges at all", auto.length > 0, true);
}

console.log("\nTHE PROJECTION — Meta's balance + $190/day, $900 at the threshold, the rest on the 6th");
{
  is("threshold charges are exactly $900", auto.filter((c) => c.kind === "threshold").every((c) => c.cents === META_BILLING_THRESHOLD_CENTS), true);
  // $115.84 + $190/day reaches $900 after (900 − 115.84) / 190 = 4.13 days: Oct 11, ~13:00 UTC.
  is("the first $900 lands on Oct 11 (Central)", chicagoYmdOf(auto[0].at), "2026-10-11");
  is("a bill-date charge on Nov 6 and Dec 6, nothing else on the 6ths' bill hour", auto.filter((c) => c.kind === "bill").map((c) => c.at.slice(0, 13)), ["2026-11-06T08", "2026-12-06T08"]);
  is("nothing past the horizon", auto.every((c) => Date.parse(c.at) < HORIZON), true);
  // THE BOOKKEEPING: the Nov 6 bill takes the whole balance, so everything projected through it =
  // Meta's balance + the budget for every hour from the read to the bill. $190/day = 24 hourly parts
  // of 791¢ with the first 16 of each Bogota day (from 00:00, 05:00 UTC) at 792¢.
  let budgetCents = 0;
  for (let h = Date.parse("2026-10-07T11:00:00Z"); h <= Date.parse("2026-11-06T08:00:00Z"); h += 3_600_000) {
    const bogotaHour = (new Date(h).getUTCHours() + 19) % 24;
    budgetCents += bogotaHour < 16 ? 792 : 791;
  }
  const toNov6 = auto.filter((c) => c.at <= "2026-11-06T08:00:00.000Z").reduce((s, c) => s + c.cents, 0);
  is(`through the Nov 6 bill, projected = $115.84 + the budget hours, to the cent ($${(READ.cents + budgetCents) / 100})`, toNov6, READ.cents + budgetCents);
  const oct = auto.filter((c) => chicagoYmdOf(c.at).startsWith("2026-10"));
  // $900 every 900 / 190 = 4.74 days after the first: Oct 11 ~9 AM, Oct 16 ~2 AM, Oct 20 ~8 PM, Oct 25 ~2 PM, Oct 30 ~7 AM (Central).
  is("October: five $900 charges after today (Oct 11, 16, 20, 25, 30)", oct.map((c) => [chicagoYmdOf(c.at).slice(8), c.cents]), [["11", 90_000], ["16", 90_000], ["20", 90_000], ["25", 90_000], ["30", 90_000]]);
}

console.log("\nRULE 1 — a real charge replaces the projected one it matches");
{
  // Oct 10, 10:00 UTC: Meta's balance is $880. The projection puts a $900 charge ~2.5 hours later.
  const dayA = metaCashFromRecord({ paid, balance: { at: "2026-10-10T10:00:00.000Z", cents: 88_000 }, now: new Date("2026-10-10T11:00:00Z"), horizonEndMs: HORIZON, budget: BUDGET });
  const projA = dayA.charges.filter((c) => c.source === "auto" && chicagoYmdOf(c.at) === "2026-10-10");
  is("CONTROL — before the charge, Oct 10 has one projected $900", projA.map((c) => c.cents), [90_000]);
  // Next morning's sync saved the real charge (12:31 UTC) and read a balance of $170.
  const real = { at: "2026-10-10T12:31:00.000Z", cents: 90_000 };
  const dayB = metaCashFromRecord({ paid: [...paid, real], balance: { at: "2026-10-11T10:00:00.000Z", cents: 17_000 }, now: new Date("2026-10-11T11:00:00Z"), horizonEndMs: HORIZON, budget: BUDGET });
  const oct10 = dayB.charges.filter((c) => chicagoYmdOf(c.at) === "2026-10-10");
  is("after it posts, Oct 10 has the paid $900 only — not paid AND projected", oct10.map((c) => [c.source, c.cents]), [["meta", 90_000]]);
  // A balance read that is OLDER than a saved charge (that day's balance read failed): the charge is
  // taken off the stale balance, so it is not projected again.
  const stale = metaCashFromRecord({ paid: [...paid, real], balance: { at: "2026-10-10T10:00:00.000Z", cents: 88_000 }, now: new Date("2026-10-11T11:00:00Z"), horizonEndMs: HORIZON, budget: BUDGET });
  is("with a stale balance read, the saved charge comes off it", stale.afterReadCents, 90_000);
  is("...so nothing is projected for Oct 10 or Oct 11 on top of the paid $900", stale.charges.filter((c) => c.source === "auto" && chicagoYmdOf(c.at) <= "2026-10-11").length, 0);
  is("CONTROL — the paid $900 is still there", stale.charges.filter((c) => c.source === "meta" && c.at === real.at).length, 1);
}

console.log("\nRULE 2 — a projected charge whose moment passes moves to now");
{
  // The balance read was already $950 (Meta had not charged yet): due at the read, but that is past.
  const nowA = new Date("2026-10-10T18:00:00Z");
  const a = metaCashFromRecord({ paid, balance: { at: "2026-10-10T10:00:00.000Z", cents: 95_000 }, now: nowA, horizonEndMs: HORIZON, budget: BUDGET });
  const firstA = a.charges.find((c) => c.source === "auto")!;
  is("a balance over the threshold projects $900 at now, not at the read", [firstA.at, firstA.cents], [nowA.toISOString(), 90_000]);
  // Two days later, still no sync (no charge saved, same read): the charge has not stayed on Oct 10.
  const nowB = new Date("2026-10-12T15:00:00Z");
  const b = metaCashFromRecord({ paid, balance: { at: "2026-10-10T10:00:00.000Z", cents: 95_000 }, now: nowB, horizonEndMs: HORIZON, budget: BUDGET });
  is("two days on, every projected charge is at or after now", b.charges.filter((c) => c.source === "auto").every((c) => Date.parse(c.at) >= nowB.getTime()), true);
  is("...the overdue ones are on today (Oct 12), none on Oct 10 or 11", b.charges.filter((c) => c.source === "auto" && chicagoYmdOf(c.at) < "2026-10-12").length, 0);
  // $950 + 2.2 days × $190 ≈ $1,368 by now: one $900 is due, the next is ~2.2 days off.
  is("...Oct 12 carries the one $900 that was due", b.charges.filter((c) => c.source === "auto" && chicagoYmdOf(c.at) === "2026-10-12").map((c) => c.cents), [90_000]);
  const total = (m: typeof a) => m.charges.filter((c) => c.source === "auto").reduce((s, c) => s + c.cents, 0);
  is("...and moving it loses nothing: the same total is projected as on Oct 10", total(b), total(a));
  is("CONTROL — across the whole model, nothing projected sits before now", model.charges.filter((c) => c.source === "auto").every((c) => Date.parse(c.at) >= NOW.getTime()), true);
}

const empty = { venues: [], masterSchedule: [], cancelledSchedule: [], overrides: [], expenses: [], revenue: [], managerPay: [], schedule: [], memberSpots: [], members: [], pricing: [], venueAliases: new Map(), venueFields: new Map(), config: {}, mdapiMemberSpots: new Map() as unknown as FinanceData["mdapiMemberSpots"], partnerDashboards: [], partnerPayoutsByVenueMonth: new Map() } as unknown as FinanceData;

console.log("\nOPEX — the charges replace the month-end Meta rows; spend stays in Expenses");
{
  const exp = (id: number, date: string, vendor: string, amount: number, manual: boolean, month = "Oct 2026") =>
    ({ id, date, month, city: "Austin", category: "Marketing", vendor, notes: "Ads", amount, manual_entry: manual });
  const data = { ...empty, expenses: [exp(1, "2026-10-31", "Meta", 940.81, false), exp(2, "2026-10-31", "Meta", 208.23, false), exp(3, "2026-10-12", "Billboard Co", 300, true)] } as unknown as FinanceData;
  const before = JSON.stringify(data.expenses);
  const costBefore = monthlyExpenseCategoryFor(data, "Oct 2026" as never, "marketing");

  const plain = buildOpexCalendarAsOf(data, 2026, 9, NOW);
  is("CONTROL — every other caller (null) still gets the month-end Meta rows on the 31st", paymentsOf(plain).filter((p) => p.payee === "Meta" && p.day === 31).length, 2);

  const pend = buildOpexCalendarAsOf(data, 2026, 9, NOW, [], true, "pending");
  is("loading (\"pending\"): NO month-end Meta row", paymentsOf(pend).some((p) => p.payee === "Meta"), false);
  is("...and no Meta charge or projection either — no Meta money at all", paymentsOf(pend).some((p) => p.payee === "Meta ads"), false);
  is("...and the page is told to show its placeholder", pend.metaPending, true);
  is("...while a non-Meta marketing row stays (Billboard Co, Oct 12)", paymentsOf(pend).some((p) => p.payee === "Billboard Co" && p.day === 12), true);

  const loaded = paymentsOf(buildOpexCalendarAsOf(data, 2026, 9, NOW, [], true, model));
  is("loaded: NO month-end Meta row", loaded.some((p) => p.payee === "Meta"), false);
  const octPaid = paid.filter((c) => chicagoYmdOf(c.at).startsWith("2026-10"));
  is("...October's paid charges, one row each, on their days, paid", loaded.filter((p) => p.payee === "Meta ads" && !p.projected).map((p) => [p.day, Math.round(p.amount * 100), p.paid]), octPaid.map((c) => [Number(chicagoYmdOf(c.at).slice(8)), c.cents, true]));
  is("...each from Meta's record", [...new Set(loaded.filter((p) => p.payee === "Meta ads" && !p.projected).map((p) => p.sub))], ["From Meta's record"]);
  is("...and the projected ones, Marketing, never paid, never before today", loaded.filter((p) => p.projected?.autoMeta).every((p) => p.cat === "mkt" && !p.paid && (p.day ?? 0) >= 7), true);
  is("...$4,500 of them (five $900)", Math.round(sumOf(loaded.filter((p) => p.projected?.autoMeta)) * 100), 450_000);
  is("...not pending", buildOpexCalendarAsOf(data, 2026, 9, NOW, [], true, model).metaPending, false);
  const off = paymentsOf(buildOpexCalendarAsOf(data, 2026, 9, NOW, [], false, model));
  is("with Show projections OFF, no projected Meta charge", off.some((p) => p.projected), false);
  is("...and the paid ones still show", off.filter((p) => p.payee === "Meta ads").length, octPaid.length);
  is("Expenses itself is untouched", JSON.stringify(data.expenses), before);
  is(`the Cost report's monthly marketing figure is unchanged ($${costBefore}): spend, not cash`, monthlyExpenseCategoryFor(data, "Oct 2026" as never, "marketing"), costBefore);
  const july = paymentsOf(buildOpexCalendarAsOf({ ...data, expenses: [exp(9, "2026-07-31", "Meta", 2_000, true, "Jul 2026")] } as FinanceData, 2026, 6, NOW, [], false, model));
  is("a month before August keeps its own ad rows and gets no charges", [july.some((p) => p.payee === "Meta"), july.some((p) => p.payee === "Meta ads")], [true, false]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
