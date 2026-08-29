/* TWO REVENUE BASES, AND NO FIGURE MAY MIX THEM.
 *
 * The estate keeps two on purpose:
 *
 *   TAX-INCLUSIVE   fin_revenue as recorded. The Revenue and Cities pages report money COLLECTED
 *                   and tie to Stripe's gross volume. cityMembershipRevenueFor.
 *   PRE-TAX         roster-derived money — mdapi_match_players.amount. Slate Review's DPP is
 *                   $12.00 a spot, the sticker price, measured on PRUMC match 17905 (10 paid
 *                   spots, $120.00). cityMembershipRevenuePreTaxFor.
 *
 * THE FAILURE THIS PREVENTS is not a wrong total — it is ONE figure built from both. Slate Review
 * showed a pre-tax DPP beside a tax-inclusive membership share and called the sum revenue. The two
 * halves differed by the city's tax rate and nothing on screen said so.
 *
 * WHAT IT ASSERTS: that each call site reads the helper matching what it JOINS. Demonstrated red
 * by swapping one call site, in the commit.
 */

import { readFileSync } from "node:fs";
import { CITY_TAX_RATE, preTaxOf, taxRateFor, hasTaxRate, citiesWithoutRate, UnknownTaxCityError } from "../src/lib/salesTax";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* WHO MAY READ WHICH. The right-hand column is what that surface JOINS the membership figure to,
 * which is the whole reason the split exists. */
const TAX_INCLUSIVE_CALLERS = [
  ["src/components/finance/RevenueSection.tsx", "the Revenue page — reports money collected"],
] as const;
const PRE_TAX_CALLERS = [
  ["src/lib/matchPnL.ts", "joined to roster-derived DPP"],
  ["src/components/SlateMatchPnLSection.tsx", "joined to Slate Review's $12.00 pre-tax DPP"],
  ["src/lib/cityPnl.ts", "joined to roster-derived field revenue"],
  ["src/lib/fieldEconomics.ts", "joined to roster-derived revenue"],
] as const;

console.log("\nthe rates are the API's, and an unknown city throws");
{
  is("Texas is 8.25%", [taxRateFor("Austin"), taxRateFor("Houston"), taxRateFor("San Antonio"), taxRateFor("Dallas")],
    [0.0825, 0.0825, 0.0825, 0.0825]);
  is("Atlanta is 8.9%", taxRateFor("Atlanta"), 0.089);
  is("St. Louis is 9.68%", taxRateFor("St. Louis"), 0.0968);
  /* READ, NOT MEASURED. I had inferred 8.65% for OKC from the ratio of total_amount to amount;
   * GET /cities says 8.625. The suite pins the SERVED value so a future measurement cannot
   * quietly replace it. */
  is("OKC is 8.625%, the served value — not the 8.65 I measured", taxRateFor("OKC"), 0.08625);
  /* WARSAW IS A REAL ZERO, not a missing rate. Dividing it would invent an 8% reduction. */
  is("Warsaw is zero", taxRateFor("Warsaw"), 0);
  is("…and zero means unchanged, not divided", preTaxOf(100, "Warsaw"), 100);
  is("Warsaw is KNOWN, which is what makes its zero legitimate", hasTaxRate("Warsaw"), true);

  let threw = false;
  try { preTaxOf(100, "Deleted Account Revenue"); } catch (e) { threw = e instanceof UnknownTaxCityError; }
  if (threw) ok("an unknown city THROWS rather than defaulting to 0%");
  else bad("an unknown city throws", "A 0% DEFAULT LEAVES TAX INSIDE A PRE-TAX FIGURE");
  is("…and it is reported by name", citiesWithoutRate(["Austin", "Deleted Account Revenue", "Warsaw"]),
    ["Deleted Account Revenue"]);
  // CONTROL: the throw is specific, not blanket — a known city must not throw.
  is("control: a known city does not throw", preTaxOf(108.25, "Austin").toFixed(2), "100.00");
}

console.log("\ngross, never net — the conversion is exact");
{
  is("$108.25 gross in Texas is $100.00 pre-tax", Number(preTaxOf(108.25, "Austin").toFixed(2)), 100);
  is("$108.90 gross in Atlanta is $100.00 pre-tax", Number(preTaxOf(108.90, "Atlanta").toFixed(2)), 100);
  /* NEVER NET. Dividing net by (1 + rate) shrinks the Stripe fees by the tax rate too, which is
   * not a thing that happened to them. Atlanta Jul 2026: net 408.54, gross 428.17 — the wrong
   * form gives a different answer from the right one, which is why this is asserted and not
   * merely written down. */
  const gross = 428.17, net = 408.54;
  const right = preTaxOf(gross, "Atlanta");
  const wrong = net / 1.089;
  if (Math.abs(right - wrong) > 0.5) ok(`control: net/(1+rate) gives $${wrong.toFixed(2)}, not $${right.toFixed(2)} — the forms are distinguishable`);
  else bad("control: the two forms differ", `${right} vs ${wrong}`);
  is("the right form is gross-based", Number(right.toFixed(2)), 393.18);
}

console.log("\nno caller crosses bases");
for (const [path, why] of TAX_INCLUSIVE_CALLERS) {
  const code = strip(readFileSync(path, "utf8"));
  if (/cityMembershipRevenueFor/.test(code)) ok(`${path.split("/").pop()} reads the TAX-INCLUSIVE helper (${why})`);
  else bad(`${path} reads the tax-inclusive helper`);
  if (!/cityMembershipRevenuePreTaxFor/.test(code)) ok("…and not the pre-tax one");
  else bad(`${path} also reads the PRE-TAX helper`, "ONE FIGURE, TWO BASES");
}
for (const [path, why] of PRE_TAX_CALLERS) {
  const code = strip(readFileSync(path, "utf8"));
  if (/cityMembershipRevenuePreTaxFor/.test(code)) ok(`${path.split("/").pop()} reads the PRE-TAX helper (${why})`);
  else bad(`${path} reads the pre-tax helper`, "IT WOULD JOIN TAX-INCLUSIVE MEMBERSHIP TO PRE-TAX DPP");
  // The bare name is a prefix of the pre-tax name, so match it only where NOT followed by PreTax.
  if (!/cityMembershipRevenueFor\b/.test(code)) ok("…and not the tax-inclusive one");
  else bad(`${path} also reads the TAX-INCLUSIVE helper`, "ONE FIGURE, TWO BASES");
}

console.log("\nthe allocator, and the wiring");
{
  const fs = strip(readFileSync("src/lib/financeStats.ts", "utf8"));
  // POSITIVE CONTROL: the file was read and still holds code.
  if (/venueAllocatedMemberRevenueFor/.test(fs)) ok("control: financeStats was read");
  else bad("control: financeStats was read");
  /* THE VENUE ALLOCATOR IS PRE-TAX because every caller joins it to roster-derived revenue. The
   * share is a ratio of member spots, so pre-taxing the city total pre-taxes each slice and the
   * slices still sum to the city figure. */
  const alloc = fs.slice(fs.indexOf("export function venueAllocatedMemberRevenueFor"), fs.indexOf("export function matchAllocated") >= 0 ? fs.indexOf("export function matchAllocated") : fs.length);
  if (/cityMembershipRevenuePreTaxFor/.test(alloc)) ok("the venue allocator pre-taxes the city total");
  else bad("the venue allocator pre-taxes the city total", "FIELD-LEVEL MEMBERSHIP WOULD CARRY TAX");

  /* COST'S OWN MEMBERSHIP CALL. buildFieldMonths adds each venue-month's allocated share into
   * `revenue`, and that allocator must be the PRE-TAX one — Cost divides into roster-derived
   * money (mdapi_match_players.amount), so a tax-inclusive membership half would put two bases
   * inside one ratio. Added at the FIELD grain so the city rows, which aggregate them, get it
   * for free and reconcile to the city total by construction. */
  const fe = strip(readFileSync("src/lib/fieldEconomics.ts", "utf8"));
  if (/venueAllocatedMemberRevenueFor\(data, id, month\)/.test(fe)) ok("Cost adds allocated membership at the field grain");
  else bad("Cost adds allocated membership at the field grain", "THE RATIO DIVIDES INTO DPP ALONE AGAIN");
  if (/membership: ids\.reduce/.test(fe)) ok("…and carries it as its own slice of revenue");
  else bad("…and carries it as its own slice of revenue");
  if (!/cityMembershipRevenueFor\b/.test(fe)) ok("…and Cost never reads the tax-inclusive helper");
  else bad("…and Cost never reads the tax-inclusive helper", "ONE RATIO, TWO BASES");

  const cost = readFileSync("src/components/finance/CostSection.tsx", "utf8");
  if (/its cost is\s*\n?\s*held\s*\n?\s*out of the ratio/.test(cost.replace(/\s+/g, " ")) || /its cost is held/.test(cost.replace(/\s+/g, " ")))
    ok("COST NOT RECORDED says the COST is held out, not the revenue");
  else bad("COST NOT RECORDED says the cost is held out", "it still reads as if revenue leaves the denominator");

  const rev = readFileSync("src/components/finance/RevenueSection.tsx", "utf8");
  if (/THAT DIAGNOSIS WAS WRONG/.test(rev)) ok("the Revenue page's 7-8% comment carries its correction");
  else bad("the Revenue page's comment is corrected", "a wrong reason will justify the next wrong decision");
  if (/7\.65%/.test(rev)) ok("…with the measured figure beside it");
  else bad("…with the measured figure beside it");
}

console.log(`\nrevenue-basis: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
