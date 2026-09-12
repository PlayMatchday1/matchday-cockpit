/* THE MEMBER-SPOT RATE — the month it comes from, and what happens when there isn't one.
 *
 * THE BUG THIS PINS. Both halves of the allocation used to come from the match's OWN month:
 * (memberSpots / cityTotal_thisMonth) x cityMembershipRevenue_thisMonth. Measured on San Antonio,
 * membership revenue lands at the START of the month — 78%, 93% and 87% of it in the first three
 * days across Jun, Jul and Aug 2026, with day 1 alone carrying 70-78% — while member spots
 * accumulate evenly all month. Evaluated the way the page would have computed it on each day, the
 * rate fell 93% from day 2 to month end, three months running: $77.90 -> $5.79, $100.84 -> $7.43,
 * $116.09 -> $8.11. A match's member revenue depended on when you looked at it.
 *
 * The rate is now the PRIOR COMPLETE MONTH's, which has both halves settled.
 */
import { readFileSync } from "node:fs";
import {
  priorMonthKey, memberSpotRateFor,
  matchAllocatedMemberRevenueFor, venueAllocatedMemberRevenueFor,
  type FinanceData, type Q2Month,
} from "../src/lib/financeStats";
import { fullyCoveredMonths } from "../src/lib/quarters";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const near = (m: string, got: number | null, want: number, tol = 0.01) =>
  got != null && Math.abs(got - want) <= tol ? ok(m) : bad(m, `got ${got} want ~${want}`);
const yes = (m: string, c: boolean, d = "") => (c ? ok(m) : bad(m, d));

/* A city with a settled prior month and a half-finished current one — the shape the bug lived in.
 * Aug: $4,240.29 pre-tax over 569 member spots = $7.4522/spot.
 * Sep so far: most of the month's revenue already in, only 123 spots played. */
const MONTHS: Q2Month[] = ["Jul 2026", "Aug 2026", "Sep 2026"];
const mk = (over: Partial<FinanceData> = {}): FinanceData => ({
  revenue: [
    { id: 1, date: "2026-08-01", month: "Aug 2026", city: "San Antonio", venue: "", type: "Membership", gross: 4590.11, fees: 0, net: 4590.11, source: "Stripe", notes: "", manual_entry: false },
    { id: 2, date: "2026-09-01", month: "Sep 2026", city: "San Antonio", venue: "", type: "Membership", gross: 4675.56, fees: 0, net: 4675.56, source: "Stripe", notes: "", manual_entry: false },
  ],
  venues: [{ id: 10, venue_name: "Soccer Central", raw_venue_name: "Soccer Central", city: "San Antonio",
    billing_type: "per_match", hourly_rate: null, monthly_flat: null, per_match_rate: null, max_spots: null,
    dpp_price: null, member_price: null, cost_per_match: null, notes: null, launch_date: null, is_active: true }],
  mdapiMemberSpots: {
    byVenueMonth: new Map([["10|Aug 2026", { member: 300, dpp: 0, other: 0 }], ["10|Sep 2026", { member: 60, dpp: 0, other: 0 }]]),
    byCityMonth: new Map([["Aug 2026", 569], ["Sep 2026", 123]].map(([m, n]) => [`San Antonio|${m}`, { member: n as number, dpp: 0, other: 0 }])),
    coveredMonths: new Set(MONTHS),
  },
  config: { "tax.San Antonio": "8.25" },
  ...over,
} as unknown as FinanceData);

console.log("\nthe window reaches back far enough to have a prior month");
{
  /* THE QUARTER'S FIRST MONTH NEEDS THE MONTH BEFORE THE QUARTER, IN FULL. The fetch used to
   * start 14 days before the quarter, which is half a month of member spots against a whole
   * month of revenue — a short denominator is an inflated rate, and it would have looked like a
   * number rather than an artefact. */
  is("a window from the 1st of the prior month covers it",
    fullyCoveredMonths("2026-06-01", "2026-10-14"), ["Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"]);
  is("…and a 14-day buffer does NOT, which is why the window was widened",
    fullyCoveredMonths("2026-06-17", "2026-10-14").includes("Jun 2026"), false);
  is("a partial month at the end is not covered either",
    fullyCoveredMonths("2026-06-01", "2026-10-14").includes("Oct 2026"), false);
}

console.log("\nthe basis month is the one before");
{
  is("Sep 2026 prices off Aug 2026", priorMonthKey("Sep 2026"), "Aug 2026");
  is("…and January reaches back a year", priorMonthKey("Jan 2027"), "Dec 2026");
  is("a malformed key has no prior month", priorMonthKey("nonsense" as Q2Month), null);
  const data = mk();
  const r = memberSpotRateFor(data, "San Antonio", "Sep 2026");
  is("the rate's basis month is August, not September", r?.basisMonth, "Aug 2026");
  near("…and it is August's pre-tax revenue over August's spots", r?.rate ?? null, 4590.11 / 1.0825 / 569);
}

console.log("\nthe same match is the same number whenever you look at it");
{
  /* THE PROOF, as a function of the CURRENT month's progress: September's own totals change all
   * month, so anything reading them changes with them. The rate does not read them. */
  const early = mk();                                   // as of the 7th: 123 spots played
  const late = mk({ mdapiMemberSpots: { ...mk().mdapiMemberSpots,
    byCityMonth: new Map([["San Antonio|Aug 2026", { member: 569, dpp: 0, other: 0 }],
                          ["San Antonio|Sep 2026", { member: 540, dpp: 0, other: 0 }]]) } } as Partial<FinanceData>);
  const args = { city: "San Antonio", venueName: "Soccer Central", matchStartIso: "2026-09-06T20:00:00.000Z", memberSpots: 10 };
  const a = matchAllocatedMemberRevenueFor(early, args);
  const b = matchAllocatedMemberRevenueFor(late, args);
  is("evaluated on the 7th and on the 27th, the Sep 6 match is identical", a, b);
  near("…and it is ten spots at August's rate", a, 10 * (4590.11 / 1.0825 / 569));
  /* THE CONTROL: the old rule really did move. Same inputs, the old algebra. */
  const oldEarly = (10 / 123) * (4675.56 / 1.0825);
  const oldLate = (10 / 540) * (4675.56 / 1.0825);
  yes(`control: the old rule moved from $${oldEarly.toFixed(2)} to $${oldLate.toFixed(2)} on the same match`,
    Math.abs(oldEarly - oldLate) > 100);
}

console.log("\nvenue and match agree, because both are spots x one rate");
{
  const data = mk();
  const venue = venueAllocatedMemberRevenueFor(data, 10, "Sep 2026");
  // the venue's 60 member spots, split across four matches
  const parts = [20, 15, 15, 10].map((n) => matchAllocatedMemberRevenueFor(data, {
    city: "San Antonio", venueName: "Soccer Central", matchStartIso: "2026-09-06T20:00:00.000Z", memberSpots: n }) ?? 0);
  near("the venue-month figure equals its matches summed", parts.reduce((a, x) => a + x, 0), venue ?? -1, 0.0001);
}

console.log("\nno prior month means no rate, and never a fallback");
{
  const noPrior = mk({ mdapiMemberSpots: { ...mk().mdapiMemberSpots, coveredMonths: new Set(["Sep 2026"]) } } as Partial<FinanceData>);
  is("a month whose prior month was not loaded has NO rate", memberSpotRateFor(noPrior, "San Antonio", "Sep 2026"), null);
  is("…and the allocator withholds rather than returning 0", matchAllocatedMemberRevenueFor(noPrior, {
    city: "San Antonio", venueName: "Soccer Central", matchStartIso: "2026-09-06T20:00:00.000Z", memberSpots: 10 }), null);
  is("…and so does the venue allocator", venueAllocatedMemberRevenueFor(noPrior, 10, "Sep 2026"), null);
  /* THREE memberAllocationReconFor CASES WERE HERE AND ARE GONE with that function: that it
   * reported allocated as unknown rather than zero, that its reason named the month, and that it
   * still reported what was billed. They tested the reconciliation's vocabulary, and the
   * reconciliation was removed with the allocated-vs-billed table that was its only caller.
   *
   * WHAT THEY WERE REACHING THROUGH IS STILL ASSERTED, directly and above: memberSpotRateFor
   * returns null, and both allocators withhold rather than returning 0. That is the behaviour that
   * matters — a 0 would be a claim that the city earned nothing per member spot. */
  const newCity = mk({ mdapiMemberSpots: { ...mk().mdapiMemberSpots,
    byCityMonth: new Map([["San Antonio|Sep 2026", { member: 123, dpp: 0, other: 0 }]]) } } as Partial<FinanceData>);
  is("a city with no member spots last month has no rate either",
    memberSpotRateFor(newCity, "San Antonio", "Sep 2026"), null);
  is("…and its allocator withholds too, rather than printing a zero",
    matchAllocatedMemberRevenueFor(newCity, {
      city: "San Antonio", venueName: "Soccer Central", matchStartIso: "2026-09-06T20:00:00.000Z", memberSpots: 10 }), null);
}

/* ── "THE GAP IS PUBLISHED, NOT HIDDEN" WAS HERE, AND THE GAP IS NO LONGER PUBLISHED ───────────
 * Six assertions went with the allocated-vs-billed table: that allocated was this month's spots at
 * last month's rate, that billed was pre-tax, that the gap was the signed difference, that it was
 * big enough mid-month to be worth printing, that the model took billed pre-tax, and that the view
 * rendered the model's row rather than recomputing it.
 *
 * THE FIRST IS STILL ASSERTED, one section up and better: the same multiplication is checked
 * through matchAllocatedMemberRevenueFor, which is what actually prices a match. The rest were
 * about a table.
 *
 * WHAT REPLACES THE LAST ONE. That assertion existed to stop the view reaching for the PRE-TAX
 * helper and putting two bases in one file. The view no longer references it at all — but the
 * opposite mistake is now the live risk, because the removed table is what made the difference
 * visible: Austin printed $6,546 under MEMBERSHIP REVENUE and $6,047 under MEMBERSHIP BILLED on
 * one screen, and the 8.25% between them was sales tax with nothing saying so. The tempting "fix"
 * is to make the main table pre-tax so the two agree. It is wrong: that column is money billed and
 * is deliberately tax-inclusive. So the assertion is inverted and kept. */
console.log("\nthe main table's membership column stays tax-inclusive");
{
  const view = readFileSync("src/components/finance/RevenueSection.tsx", "utf8");
  yes("the view prices its membership column with the TAX-INCLUSIVE helper",
    /cityMembershipRevenueFor\(/.test(view));
  yes("…and never reaches for the pre-tax one",
    !/cityMembershipRevenuePreTaxFor/.test(view));
  /* AND THE PRE-TAX HELPER IS STILL ALIVE where it belongs — inside the rate, whose two halves
   * must both be pre-tax. A grep that passed because the function had been deleted everywhere
   * would prove nothing. */
  const model = readFileSync("src/lib/financeStats.ts", "utf8");
  const rate = model.slice(model.indexOf("export function memberSpotRateFor"),
    model.indexOf("export function venueAllocatedMemberRevenueFor"));
  yes("control: the rate itself still takes revenue pre-tax",
    /cityMembershipRevenuePreTaxFor/.test(rate));
  /* NO DEAD EXPORT LEFT BEHIND. The table is gone; so is the model function that fed it. */
  yes("memberAllocationReconFor is gone from the model", !/export function memberAllocationReconFor/.test(model));
  yes("…and MemberReconRow with it", !/export type MemberReconRow/.test(model));
  yes("…and nothing in the view renders a member-recon node", !/member-recon/.test(view));
}

console.log(`\nmember-rate: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
