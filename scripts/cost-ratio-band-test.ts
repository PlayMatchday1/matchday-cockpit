// THE PILL'S THRESHOLDS, AT THE BOUNDARY.
//
// Green under 50%, amber 50–60%, red 60 and over — and the boundary belongs to the HIGHER band.
// These four cases are the whole point of the colour: a pill that says green beside a number
// reading 50.0% is worse than no pill, and an off-by-one here is invisible in a screenshot.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/cost-ratio-band-test.ts
import { ratioBand, COST_BASIS_LABEL, pooledRatio, priorMonthOf, priorQuarterOf } from "../src/lib/fieldEconomics";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? (pass++, console.log(`  ✓ ${n}`))
    : (fail++, console.log(`  ✗ ${n} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

console.log("the four boundaries:");
eq("49.9% is green", ratioBand(0.499), "good");
eq("50.0% is amber — the boundary belongs to the higher band", ratioBand(0.50), "warn");
eq("59.9% is amber", ratioBand(0.599), "warn");
eq("60.0% is red — likewise", ratioBand(0.60), "bad");
console.log("\naway from the boundaries:");
eq("0% is green", ratioBand(0), "good");
eq("204.2% is red", ratioBand(2.042), "bad");
eq("55% is amber", ratioBand(0.55), "warn");

console.log("\nthe labels match Field Costs:");
eq("per_match", COST_BASIS_LABEL.per_match, "Per match");
eq("profit_share reads the same word Field Costs uses", COST_BASIS_LABEL.profit_share, "Profit share");
eq("monthly_flat matches Field Costs too, though no venue carries it", COST_BASIS_LABEL.monthly_flat, "Monthly flat");

console.log("\nprior windows are anchored on the period's first month:");
eq("the month before Aug 2026", priorMonthOf("Aug 2026"), "Jul 2026");
eq("…across a year boundary", priorMonthOf("Jan 2026"), "Dec 2025");
eq("the quarter before Aug 2026 is Q2", priorQuarterOf("Aug 2026"), ["Apr 2026", "May 2026", "Jun 2026"]);
eq("…and before Feb 2026 is Q4 2025", priorQuarterOf("Feb 2026"), ["Oct 2025", "Nov 2025", "Dec 2025"]);

console.log("\nprior quarter is POOLED, not an average of monthly ratios:");
{
  const row = (cost: number | null, revenue: number) =>
    ({ cost, revenue, eventRevenue: 0, matches: 1 }) as unknown as Parameters<typeof pooledRatio>[0][number];
  // Two months: 10/100 = 10% and 90/100 = 90%. Pooled = 100/200 = 50%. The average of the two
  // ratios is also 50% here, so a second case is needed where they diverge.
  eq("equal-weight case", pooledRatio([row(10, 100), row(90, 100)]), 0.5);
  // 10/10 = 100% and 90/990 ≈ 9.1%. Pooled = 100/1000 = 10%. Average of ratios ≈ 54.5%.
  const pooled = pooledRatio([row(10, 10), row(90, 990)]);
  eq("uneven case pools to 10%, NOT the 54.5% an average of ratios gives",
     pooled == null ? null : Math.round(pooled * 1000) / 1000, 0.1);
  eq("no revenue in the window → null, never 0", pooledRatio([row(50, 0)]), null);
  eq("no KNOWN cost in the window → null, never 0", pooledRatio([row(null, 500)]), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
