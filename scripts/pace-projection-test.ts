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
const D1 = 16468, D2 = 2918, D3 = 3135, ORD = 2500, TODAY = 585;
const EX = 1;   // the window, as shipped: day 1 only

console.log("day 1 and today are out of the rate, in revenue-so-far:");
{
  // 20 days elapsed: day 1 real, days 2-19 at $2,500, day 20 a part-day at $585.
  const soFar = D1 + 18 * ORD + TODAY;
  const r = projectMonthEnd({
    soFar, excludedRevenue: D1, currentDayRevenue: TODAY,
    daysElapsed: 20, daysInMonth: 31, excludedDays: EX, isCurrentMonth: true,
  });
  eq("a rate exists", r.ok, true);
  if (r.ok) {
    // THE DIVISOR, EXPLICITLY. elapsed 20, minus day 1, minus today = 18. An off-by-one here is
    // invisible in the output — the rate just comes out slightly wrong.
    eq("the divisor is elapsed − day 1 − today", r.rateDays, 18);
    eq("the rate is the middle days' mean", Math.round(r.rate), ORD);
    eq("  …and NOT dragged down by the part-day", Math.round((soFar - D1) / 19) < ORD, true);
    eq("today is reported as excluded", r.todayExcluded, true);
    eq("days remaining is unaffected by excluding today from the rate", r.remaining, 11);
    eq("the projection adds the rate only to the remaining days",
       Math.round(r.projection), Math.round(soFar + 11 * ORD));
  }
}

console.log("\nrevenue-so-far is the FULL elapsed total — the half that hides a cancelling error:");
{
  const soFar = D1 + 18 * ORD + TODAY;
  const r = projectMonthEnd({
    soFar, excludedRevenue: D1, currentDayRevenue: TODAY,
    daysElapsed: 20, daysInMonth: 31, excludedDays: EX, isCurrentMonth: true,
  });
  if (r.ok) {
    eq("the projection starts from the full total, day 1 and today included",
       Math.round(r.projection - 11 * r.rate), Math.round(soFar));
    // If soFar had been windowed too, the projection would be lower by day 1 + today.
    eq("  …and NOT from the windowed figure",
       Math.round(r.projection - 11 * r.rate) === Math.round(soFar - D1 - TODAY), false);
  }
}

console.log("\nthe first days of a month have no window:");
{
  const d1 = projectMonthEnd({ soFar: D1, excludedRevenue: D1, currentDayRevenue: D1, daysElapsed: 1, daysInMonth: 31, excludedDays: EX, isCurrentMonth: true });
  eq("day 1 — nothing to compute a rate from", d1.ok, false);
  eq("  …and today is not double-subtracted, because it IS day 1", d1.ok === false, true);
  const d2 = projectMonthEnd({ soFar: D1 + D2, excludedRevenue: D1, currentDayRevenue: D2, daysElapsed: 2, daysInMonth: 31, excludedDays: EX, isCurrentMonth: true });
  eq("day 2 — day 1 out, today out, zero days left in the window", d2.ok, false);
  const d3 = projectMonthEnd({ soFar: D1 + D2 + D3, excludedRevenue: D1, currentDayRevenue: D3, daysElapsed: 3, daysInMonth: 31, excludedDays: EX, isCurrentMonth: true });
  eq("day 3 — exactly one day in the window, and it computes", d3.ok, true);
  if (d3.ok) {
    eq("  …from one day", d3.rateDays, 1);
    eq("  …that day being day 2", Math.round(d3.rate), D2);
  }
}

console.log("\nthe last day of the month — nothing remains to project:");
{
  const soFar = D1 + 29 * ORD + TODAY;
  const r = projectMonthEnd({ soFar, excludedRevenue: D1, currentDayRevenue: TODAY, daysElapsed: 31, daysInMonth: 31, excludedDays: EX, isCurrentMonth: true });
  eq("remaining is zero", r.ok && r.remaining, 0);
  // NOT soFar + one more day. This is where an off-by-one looks entirely plausible.
  eq("the projection is EXACTLY revenue so far", r.ok && r.projection, soFar);
  if (r.ok) eq("  …and not so far plus a day", r.projection === soFar + r.rate, false);
}

console.log("\na CLOSED month — no current day at all:");
{
  const actual = D1 + 29 * ORD;
  const r = projectMonthEnd({ soFar: actual, excludedRevenue: D1, currentDayRevenue: 0, daysElapsed: 30, daysInMonth: 30, excludedDays: EX, isCurrentMonth: false });
  eq("projects to the month's actual total exactly", r.ok && r.projection, actual);
  eq("  …and reports no current-day exclusion", r.ok && r.todayExcluded, false);
  // The divisor uses every day except day 1 — today is not taken off a month that has no today.
  eq("  …with a divisor of elapsed − day 1 only", r.ok && r.rateDays, 29);
}

console.log("\nthe window is a parameter, and it is wired:");
{
  const soFar = D1 + D2 + D3 + 7 * ORD;
  const one = projectMonthEnd({ soFar, excludedRevenue: D1, daysElapsed: 10, daysInMonth: 31, excludedDays: 1 });
  const three = projectMonthEnd({ soFar, excludedRevenue: D1 + D2 + D3, daysElapsed: 10, daysInMonth: 31, excludedDays: 3 });
  eq("1 and 3 produce different rates", one.ok && three.ok && Math.round(one.rate) !== Math.round(three.rate), true);
  eq("  …and different divisors", [one.ok && one.rateDays, three.ok && three.rateDays], [9, 7]);
  eq("  …so the constant is wired, not decoration",
     one.ok && three.ok && Math.round(one.projection) !== Math.round(three.projection), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
