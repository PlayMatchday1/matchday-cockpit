/* REVENUE IS PRE-TAX. No revenue path may read total_amount.
 *
 * WHY THIS IS A NODE GUARD. mdapi_match_players carries two money columns that differ by 5-9%
 * depending on the city, and reading the wrong one produces a number that looks entirely
 * reasonable. It did, for as long as the Player Data Room has existed:
 *
 *   amount        the PRE-TAX price. Populated since 2023-04.
 *   total_amount  the CARD CHARGE = round((amount - credit_amount) x (1 + city sales tax rate)).
 *                 Populated only since 2025-12 — which is why 32 months rendered $0.00.
 *
 * Confirmed against the rates in the API's own cities table: ATX/HOU/SATX 8.25, ATL 8.90,
 * STL 9.68, and no city disagrees. Sales tax is money we collect and remit; it was never
 * revenue, and nothing in the finance estate books it as a liability or an expense.
 *
 * WHAT IT ASSERTS. Not "does the model divide by 100" — that a wrong column is not read. Proven
 * failable: reverting any one site turns this red, demonstrated in the commit.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY CHECK. Each of these files EXPLAINS, in prose, that it must
 * not read total_amount — and a grep that reads prose as code goes red for being well documented,
 * which teaches people to delete the explanation. That already happened once this week.
 */

import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const ok = (m: string) => { pass++; console.log(`  ✓ ${m}`); };
const bad = (m: string, d = "") => { fails.push(`${m}${d ? ` — ${d}` : ""}`); console.log(`  ✗ ${m}${d ? ` — ${d}` : ""}`); };
const is = (m: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(m) : bad(m, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

/* Block comments, line comments — INCLUDING TRAILING ONES — and SQL comments.
 *
 * The trailing case is not a detail: the first run of this suite went red on
 *   `amount: number | null;   // PRE-TAX cents. NOT total_amount`
 * because a line-start-only rule catches a comment that OWNS its line and nothing else. The
 * forbidden string was in
 * prose explaining that the forbidden string must not be used. `[^:]` spares `https://`. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "")
     .replace(/(^|[^:])\/\/.*$/gm, "$1")
     .replace(/--.*$/gm, "");

console.log("\nthe comment stripper, before it is trusted with anything");
{
  is("a block comment goes", strip("/* total_amount */ const a = 1;").trim(), "const a = 1;");
  is("a line comment goes", strip("// total_amount\nconst a = 1;").trim(), "const a = 1;");
  is("a TRAILING line comment goes too", strip("const a = 1; // total_amount").trim(), "const a = 1;");
  // …and a URL is not mistaken for one, or stripping would silently mangle real code.
  is("a URL survives", strip('"https://x.example/total_amount"').trim(), '"https://x.example/total_amount"');
  is("a SQL comment goes", strip("-- total_amount\nSELECT 1;").trim(), "SELECT 1;");
  is("real code survives", strip('sel("total_amount");').trim(), 'sel("total_amount");');
  // THE CONTROL THAT MATTERS: the stripper must not be so greedy it empties the file, or every
  // "must not contain" check below passes on nothing.
  const f = strip(readFileSync("src/lib/dataRoom.ts", "utf8"));
  if (f.length > 4000) ok(`control: dataRoom.ts still has ${f.length} chars of code after stripping`);
  else bad("control: the stripper did not empty the file", `${f.length} chars left`);
}

/* THE FOUR REVENUE SITES. lookup/[env]/route.ts is deliberately NOT here: it reads totalAmount as
 * `charged` and its own comment says "what Stripe actually took". That is the card charge, it is
 * labelled as the card charge, and it is correct. */
const SITES = [
  ["src/lib/dataRoom.ts", "Player Data Room"],
  ["src/lib/growthAnalytics.ts", "Growth (computeGrowth)"],
  ["src/lib/growthCache.ts", "Growth cache fetch"],
  ["supabase/migrations/0154_growth_revenue_pretax.sql", "the view + play dims"],
] as const;

console.log("\nno revenue path reads the tax-inclusive column");
for (const [path, label] of SITES) {
  const code = strip(readFileSync(path, "utf8"));
  // POSITIVE CONTROL per file: we are reading the file we think we are, post-strip.
  const marker = path.endsWith(".sql") ? /growth_participation/ : /amount/;
  if (marker.test(code)) ok(`control: ${label} was read and still contains code`);
  else bad(`control: ${label} was read`, "the check below would pass on an empty string");

  if (path.endsWith(".sql")) {
    /* THE SQL IS THE ONE PLACE total_amount MAY STILL APPEAR AS A NAME — as the deprecated
     * output alias that closes the deploy-order window. What must NOT appear is it being READ:
     * `p.total_amount` on the right-hand side. */
    if (!/p\.total_amount/.test(code)) ok(`${label}: the view no longer READS p.total_amount`);
    else bad(`${label}: the view no longer READS p.total_amount`, "THE TAX IS BACK IN REVENUE");
    if (/COALESCE\(p\.amount, 0\)\s+AS amount_cents/.test(code)) ok(`${label}: it projects the pre-tax amount`);
    else bad(`${label}: it projects the pre-tax amount`);
    if (/SUM\(amount_cents\)/.test(code)) ok(`${label}: play dims sum the pre-tax column`);
    else bad(`${label}: play dims sum the pre-tax column`);
  } else {
    if (!/total_amount/.test(code)) ok(`${label}: no total_amount in code`);
    else bad(`${label}: no total_amount in code`, `still reads it: ${(code.match(/.{0,60}total_amount.{0,30}/) ?? [""])[0].trim()}`);
  }
}

console.log("\n…and the pre-tax column is what they read instead");
{
  const dr = strip(readFileSync("src/lib/dataRoom.ts", "utf8"));
  if (/revenue: Number\(r\.amount_cents\) \/ 100/.test(dr)) ok("Data Room's revenue is amount_cents / 100");
  else bad("Data Room's revenue is amount_cents / 100");
  const ga = strip(readFileSync("src/lib/growthAnalytics.ts", "utf8"));
  if (/amount: Number\(p\.amount \?\? 0\) \/ 100/.test(ga)) ok("Growth's play amount is p.amount / 100");
  else bad("Growth's play amount is p.amount / 100");
  const gc = strip(readFileSync("src/lib/growthCache.ts", "utf8"));
  if (/deleted_at, amount"/.test(gc)) ok("the growth cache fetches amount");
  else bad("the growth cache fetches amount");
}

console.log("\nthe caches invalidate on a MEANING change, not only on a new row");
{
  /* max(player_api_id) and max(start_date) both move when a ROW lands and are blind to a column
   * changing meaning. Without a version in the key, every warm instance would have gone on
   * serving tax-inclusive numbers from a cache that believed itself fresh. */
  const dr = strip(readFileSync("src/lib/dataRoom.ts", "utf8"));
  const gc = strip(readFileSync("src/lib/growthCache.ts", "utf8"));
  if (/FACT_MODEL_VERSION/.test(dr) && /\$\{FACT_MODEL_VERSION\}:/.test(dr)) ok("the Data Room key carries a model version");
  else bad("the Data Room key carries a model version", "A WARM INSTANCE WOULD SERVE THE OLD NUMBERS");
  if (/GROWTH_MODEL_VERSION/.test(gc) && /\$\{GROWTH_MODEL_VERSION\}:/.test(gc)) ok("the growth cache key carries a model version");
  else bad("the growth cache key carries a model version", "A WARM INSTANCE WOULD SERVE THE OLD NUMBERS");
}

console.log("\nthe pages say the number is pre-tax");
{
  const panel = readFileSync("src/components/growth/DataRoomPanel.tsx", "utf8");
  if (/pre-tax/i.test(panel)) ok("the Data Room labels revenue pre-tax");
  else bad("the Data Room labels revenue pre-tax", "a 5-9% definition is invisible without it");
}

console.log("\nfin_revenue is NOT touched");
{
  /* IT IS A LEDGER, and it is tax-inclusive too — DPP gross clusters on $9.74 / $12.99 / $19.48,
   * which are $9 / $12 / $18 x 1.0825, and $95,508.95 of sales tax sits inside it all-time.
   * Correcting a ledger means re-deriving it. Out of scope by ruling, and asserted so that a
   * later "while we're here" cannot quietly widen this change. */
  const sql = readFileSync("supabase/migrations/0154_growth_revenue_pretax.sql", "utf8");
  const code = strip(sql);
  if (!/fin_revenue/.test(code)) ok("migration 0154 does not touch fin_revenue");
  else bad("migration 0154 does not touch fin_revenue", "A LEDGER IS BEING REWRITTEN BY A PROJECTION CHANGE");
  if (/fin_revenue/.test(sql)) ok("…and says in its header why it is left alone");
  else bad("…and says why it is left alone");
}

console.log(`\nrevenue-pretax: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
