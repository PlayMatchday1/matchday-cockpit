// CONFINEMENT — the normalized cost model must not spread, and Finance › Cost must not grow a
// second one back.
//
// legPerMatchUnitCost and groupPerMatchCostFor are the PER-MATCH basis and the realized lens, and
// nothing else. If a new caller appears outside those paths, the estate has a second cost model
// again and this fails.
//
// THE COST PAGE'S OWN INVARIANTS ARE PINNED HERE TOO, because none of them is visible on screen:
// it reads NO override, it defines no second has-it-happened predicate, and every caller of the
// two builders states its realized cut explicitly. That last one is not hypothetical — a default
// on that parameter silently moved Finance › Revenue's Austin row from 172 matches to 132.
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

// ── NOTHING ON THE COST PAGE READS AN OVERRIDE ────────────────────────────────────────────────
// An override is a billing-timing lump (Soccer Central's $5,600 covering three months). Reading
// one makes a month's ratio a fact about when an invoice arrived. canonicalVenueCost checks the
// override first, so fieldEconomics must not call it at all.
const fe = code("src/lib/fieldEconomics.ts");
for (const sym of ["canonicalVenueCost", "findOverride", "data.overrides"]) {
  eq(`fieldEconomics never calls ${sym}`, new RegExp(`\\b${sym.replace(".", "\\.")}\\b`).test(fe), false);
}
// CONTROL for those three falses: the file WAS read and does contain the cost code being scanned.
eq("  control — fieldEconomics really was scanned (it defines groupCost)", /function groupCost\(/.test(fe), true);

// ── THE BASIS AND STRUCTURE TOGGLES ARE GONE, AND STAY GONE ────────────────────────────────────
const cost = code("src/components/finance/CostSection.tsx");
for (const gone of ["CostMode", "as_billed", "basis-per-match", "basis-as-billed", "setStructures"]) {
  eq(`the Cost page carries no ${gone}`, new RegExp(gone.replace("-", "\\-")).test(cost), false);
}
// CONTROL: the file was read and still renders the page.
eq("  control — the Cost page really was scanned (it still builds field months)",
   /buildFieldMonths\(/.test(cost), true);
// The COST STRUCTURE column stays — each row must still say which model produced its figure.
eq("the cost structure column survives the toggle removal", /COST_BASIS_LABEL/.test(cost), true);
eq("  …and the derived-not-billed label is on the page", /cost-derived-note/.test(cost), true);

// ── ONE PREDICATE FOR "HAS IT HAPPENED" ───────────────────────────────────────────────────────
// The Match panel's hasKickedOff is the only one. A second definition is how the four-month
// window and the "all time" label came to disagree in the first place.
eq("the realized cut goes through hasKickedOff", /hasKickedOff\(/.test(fe), true);
eq("  …and reads the true instant, never the wall-clock match_date",
   /\bmatch_date\b[^\n]*now|now[^\n]*\bmatch_date\b/.test(fe), false);

// ── EVERY CALLER STATES ITS REALIZED CUT ──────────────────────────────────────────────────────
// A default on this parameter made Finance › Revenue realized without anyone asking. The builders
// must declare it with no default, and every call site must pass a 4th / 3rd argument.
eq("buildFieldMonths declares realizedThroughMs with NO default",
   /realizedThroughMs: RealizedThroughMs,/.test(fe), true);
eq("  …and no builder carries `= Date.now()`", /=\s*Date\.now\(\)/.test(fe), false);
const callSites = files
  .filter((f) => /\bbuildFieldMonths\s*\(|\bbuildFieldCostSlots\s*\(/.test(code(f)))
  .filter((f) => f !== "src/lib/fieldEconomics.ts");
eq("both builders have callers to check", callSites.length > 0, true);
const lazy: string[] = [];
for (const f of callSites) {
  for (const m of code(f).matchAll(/\b(buildFieldMonths|buildFieldCostSlots)\s*\(([^)]*)\)/g)) {
    const args = m[2].split(",").length;
    const need = m[1] === "buildFieldMonths" ? 4 : 3;
    if (args < need) lazy.push(`${f}: ${m[1]} got ${args} args, needs ${need}`);
  }
}
eq("every call site states its realized cut explicitly", lazy, []);

// And the dead ranking code stays dead.
for (const sym of ["buildRankingRows", "RankingRow"]) {
  eq(`${sym} appears nowhere, including in comments`,
     files.filter((f) => new RegExp(`\\b${sym}\\b`).test(readFileSync(f, "utf8"))), []);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
