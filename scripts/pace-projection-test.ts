// PACE TO MONTH END — the edges, which a live page cannot reach.
//
// Day 3 of a month, day 4, and the last day are all "what does the card do on a date that is not
// today". They are the cases most likely to be wrong and least likely to be noticed, so they are
// asserted against the pure function the card calls.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/pace-projection-test.ts
import { projectMonthEnd } from "../src/lib/financePeriod";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? (pass++, console.log(`  ✓ ${n}`))
    : (fail++, console.log(`  ✗ ${n} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// August 2026's real shape: a $16,468 day 1, then ordinary days.
const D1 = 16468, D2 = 2918, D3 = 3135, ORD = 2500;

console.log("the excluded days are in revenue, out of the rate:");
{
  // 10 days elapsed: days 1-3 real, days 4-10 at $2,500.
  const soFar = D1 + D2 + D3 + 7 * ORD;
  const r = projectMonthEnd({ soFar, excludedRevenue: D1 + D2 + D3, daysElapsed: 10, daysInMonth: 31, excludedDays: 3 });
  eq("a rate exists", r.ok, true);
  if (r.ok) {
    eq("the rate is the days-4-onward mean, not the plain mean", Math.round(r.rate), ORD);
    eq("  …and the plain mean would have been much higher", Math.round(soFar / 10) > ORD + 500, true);
    eq("the rate covers elapsed − 3 days", r.rateDays, 7);
    eq("remaining is the days that have not happened", r.remaining, 21);
    // soFar is the FULL figure including days 1-3 — that is the half a total-only test cannot see.
    eq("the projection adds the rate only to the remaining days",
       Math.round(r.projection), Math.round(soFar + 21 * ORD));
  }
}

console.log("\nfewer than four elapsed days — there is no rate:");
for (const elapsed of [1, 2, 3]) {
  const r = projectMonthEnd({ soFar: D1, excludedRevenue: D1, daysElapsed: elapsed, daysInMonth: 31, excludedDays: 3 });
  eq(`  day ${elapsed} has no projection`, r.ok, false);
  if (!r.ok) eq(`  day ${elapsed} still reports the days remaining`, r.remaining, 31 - elapsed);
}

console.log("\nexactly four elapsed days — the rate is one day, and it computes:");
{
  const r = projectMonthEnd({ soFar: D1 + D2 + D3 + ORD, excludedRevenue: D1 + D2 + D3, daysElapsed: 4, daysInMonth: 31, excludedDays: 3 });
  eq("day 4 DOES produce a projection", r.ok, true);
  if (r.ok) {
    eq("  …from exactly one day", r.rateDays, 1);
    eq("  …at that day's own figure", Math.round(r.rate), ORD);
  }
}

console.log("\nthe last day of the month — nothing remains to project:");
{
  const soFar = D1 + D2 + D3 + 28 * ORD;
  const r = projectMonthEnd({ soFar, excludedRevenue: D1 + D2 + D3, daysElapsed: 31, daysInMonth: 31, excludedDays: 3 });
  eq("remaining is zero", r.ok && r.remaining, 0);
  // NOT soFar + one more day. This is the case where an off-by-one is a plausible-looking number.
  eq("the projection is EXACTLY revenue so far", r.ok && r.projection, soFar);
  if (r.ok) eq("  …and not so far plus a day", r.projection === soFar + r.rate, false);
}

console.log("\na complete past month — the same formula, and it must not drift a cent:");
{
  const actual = D1 + D2 + D3 + 27 * ORD;
  const r = projectMonthEnd({ soFar: actual, excludedRevenue: D1 + D2 + D3, daysElapsed: 30, daysInMonth: 30, excludedDays: 3 });
  eq("projects to the month's actual total exactly", r.ok && r.projection, actual);
}

console.log("\nthe excluded window is a parameter, not a hardcoded 3:");
{
  const soFar = D1 + D2 + D3 + 7 * ORD;
  const one = projectMonthEnd({ soFar, excludedRevenue: D1, daysElapsed: 10, daysInMonth: 31, excludedDays: 1 });
  const three = projectMonthEnd({ soFar, excludedRevenue: D1 + D2 + D3, daysElapsed: 10, daysInMonth: 31, excludedDays: 3 });
  eq("excluding day 1 only gives a different rate", one.ok && three.ok && Math.round(one.rate) !== Math.round(three.rate), true);
  // Measured: the spike is day 1 alone (5.8×-7.8× median); days 2-3 are ordinary. Narrowing the
  // window is a one-line change and this is what proves the function already supports it.
  if (one.ok) eq("  …and day-1-only is the higher rate, because days 2-3 are ordinary days",
                 one.rate > (three.ok ? three.rate : 0), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
