// CONFINEMENT — the normalized cost model must not spread.
//
// legPerMatchUnitCost and groupPerMatchCostFor are the PER-MATCH basis and the realized lens, and
// nothing else. The Cost page now defaults to as-billed, which routes through canonicalVenueCost
// with the rest of Finance; if a new caller appears outside those two paths, the page has grown a
// second cost model again and this fails.
//
//   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/cost-basis-confinement-test.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const eq = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want)
    ? (pass++, console.log(`  ✓ ${n}`))
    : (fail++, console.log(`  ✗ ${n} — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}
/** Strip comments so a mention in prose is never mistaken for a call. */
const code = (f: string) =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const files = walk("src");
const ALLOWED = new Set([
  "src/lib/financeStats.ts",              // where both are defined, and the realized lens
  "src/lib/fieldEconomics.ts",            // the PER-MATCH basis, one call at groupCost
  "src/lib/cityPnl.ts",                   // Cities P&L, the live realized consumer
  "src/lib/crossbarCost.finance-test.ts", // the regression guard for both lenses
]);

for (const sym of ["legPerMatchUnitCost", "groupPerMatchCostFor"]) {
  const callers = files.filter((f) => new RegExp(`\\b${sym}\\b`).test(code(f)));
  const stray = callers.filter((f) => !ALLOWED.has(f)).sort();
  eq(`${sym} is confined to the per-match basis and the realized path`, stray, []);
  // CONTROL for that empty array: the scan DOES find the allowed callers, so "no strays" is not
  // "nothing scanned".
  eq(`  control — ${sym} was actually found somewhere`, callers.length > 0, true);
}

// The as-billed basis must reach canonicalVenueCost, or the default is pointing at nothing.
eq("fieldEconomics' as-billed branch calls canonicalVenueCost",
   /canonicalVenueCost\(/.test(code("src/lib/fieldEconomics.ts")), true);
// …and the Cost page must open on it.
eq("the Cost page defaults to as_billed",
   /useState<CostMode>\("as_billed"\)/.test(code("src/components/finance/CostSection.tsx")), true);
// The per-match basis is NOT deleted — this was a default change.
eq("the per-match basis is still selectable",
   /setMode\("per_match"\)/.test(code("src/components/finance/CostSection.tsx")), true);

// And the dead ranking code stays dead.
for (const sym of ["buildRankingRows", "RankingRow"]) {
  eq(`${sym} appears nowhere, including in comments`,
     files.filter((f) => new RegExp(`\\b${sym}\\b`).test(readFileSync(f, "utf8"))), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
