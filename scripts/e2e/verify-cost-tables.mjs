// FINANCE › COST — the two economics tables, as rendered.
//
// WHAT THIS PINS. The columns, the rank, the pill, the two prior-period columns, and the three
// things a screenshot cannot check: that the printed ratio is the printed cost over the printed
// revenue, that a rank survives a re-sort, and that an absent prior period reads "—" rather than
// 0.0%. Two bugs found by hand while building this are pinned by name, because both of them
// produced a page that looked fine.
//
//   node scripts/e2e/verify-cost-tables.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor , nonEmpty } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));
const pct = (t) => (/—/.test(t ?? "") ? null : Number(String(t).replace(/[^0-9.-]/g, "")));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1700, height: 1500 }, acceptDownloads: true });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(`${BASE}/admin/finance/cost`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="cost-row"]', { timeout: 90000 });
await page.waitForTimeout(2000);
eq("no uncaught page errors", pageErrors, []);

const readTable = () => page.evaluate(() => {
  const headers = [...document.querySelectorAll('[data-testid="cost-economics-table"] thead th')].map((t) => t.innerText.trim());
  const rows = [...document.querySelectorAll('[data-testid="cost-row"]')].map((r) => ({
    cells: [...r.querySelectorAll("td")].length,
    rank: r.querySelector('[data-testid="cost-rank"]')?.innerText.trim(),
    name: r.querySelectorAll("td")[1]?.innerText.trim(),
    structure: r.querySelector('[data-testid="cost-structure"]')?.innerText.trim() ?? null,
    revenue: r.querySelector('[data-testid="cost-revenue-cell"]')?.innerText.trim(),
    cost: r.querySelector('[data-testid="cost-amount-cell"]')?.innerText.trim(),
    ratio: r.querySelector('[data-testid="cost-ratio-cell"]')?.innerText.trim(),
    band: r.querySelector('[data-testid="cost-ratio-pill"]')?.getAttribute("data-band") ?? null,
    priorMonth: r.querySelector('[data-testid="cost-prior-month"]')?.innerText.trim(),
    priorQuarter: r.querySelector('[data-testid="cost-prior-quarter"]')?.innerText.trim(),
  }));
  const count = document.querySelector('[data-testid="breakdown-count"]')?.innerText.trim();
  return { headers, rows, count };
});

// ── 1. COLUMNS ────────────────────────────────────────────────────────────────────────────────
console.log("\n── the columns ──");
const city = await readTable();
eq("City Economics has 7 headers", city.headers.length, 7);
eq("…in the specified order", city.headers.map((h) => h.toUpperCase()),
   ["#", "CITY", "REVENUE", "FIELD COST", "COST RATIO", "PRIOR MONTH RATIO", "PRIOR QUARTER RATIO"]);
eq("every City row has 7 cells", [...new Set(city.rows.map((r) => r.cells))], [7]);

await page.locator('[data-testid="grain-field"]').click();
await page.waitForTimeout(2500);
const field = await readTable();
eq("Field Economics has 9 headers", field.headers.length, 9);
eq("…in the specified order", field.headers.map((h) => h.toUpperCase()),
   ["#", "FIELD", "CITY", "COST STRUCTURE", "REVENUE", "FIELD COST", "COST RATIO", "PRIOR MONTH RATIO", "PRIOR QUARTER RATIO"]);
eq("every Field row has 9 cells", [...new Set(field.rows.map((r) => r.cells))], [9]);
eq("COST STRUCTURE is plain text, not a badge",
   field.rows.every((r) => r.structure && !/PER MATCH|PROFIT SHARE/.test(r.structure)), true);
eq("  …and reads the same words Field Costs uses",
   [...new Set(field.rows.map((r) => r.structure))].every((v) => /^(Per match|Profit share|Monthly flat)( \+ (Per match|Profit share|Monthly flat))*$/.test(v)), true);

// ── 2. THE REMOVED STRINGS ────────────────────────────────────────────────────────────────────
console.log("\n── what was removed stays removed ──");
{
  const body = await page.evaluate(() => document.body.innerText);
  eq("  control — the scan read a real page with rows", body.length > 1500 && field.rows.length > 3, true);
  eq("  control — it finds a header that IS present ('Prior quarter ratio')", /prior quarter ratio/i.test(body), true);
  // SCOPED TO THE TABLE AND THE CARDS. "no cost basis" also appears in the "Cost not recorded"
  // block below the table — a different element, not one that was asked to go, and its wording is
  // load-bearing there. Asserting against the whole page would have forced that block reworded to
  // satisfy a check about columns.
  const tableText = await page.evaluate(() =>
    (document.querySelector('[data-testid="cost-economics-table"]')?.innerText ?? ""));
  const cardsText = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="cost-tile-ratio"]')?.closest("div")?.parentElement;
    return t?.innerText ?? "";
  });
  for (const gone of ["at costed fields", "event play", "no cost basis"]) {
    eq(`the "${gone}" column is gone from the table`,
       new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(tableText), false);
  }
  for (const gone of ["of it sits at fields with no cost basis", "field-month", "excluded — no cost on file",
                      "across", "event play"]) {
    eq(`the card subtitle "${gone.slice(0, 30)}" is gone`,
       new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(cardsText), false);
  }
  eq("the ratio paragraph above the table is gone",
     /Cost ratio is field cost ÷ revenue/i.test(body), false);
  eq("  control — the table text was actually read", tableText.length > 200, true);
  eq("  control — the cards text was actually read", cardsText.length > 20, true);
  const caught = await page.evaluate(() => {
    const d = document.createElement("div"); d.textContent = "at costed fields";
    document.body.appendChild(d);
    const hit = /at costed fields/i.test(document.body.innerText);
    d.remove(); return hit;
  });
  eq("  control — a planted 'at costed fields' IS caught", caught, true);
}

// ── 3. THE RATIO IS THE PRINTED DIVISION ──────────────────────────────────────────────────────
console.log("\n── printed ratio === printed cost ÷ printed revenue ──");
{
  let checked = 0;
  for (const r of field.rows) {
    const rev = money(r.revenue), cost = money(r.cost), shown = pct(r.ratio);
    if (!(rev > 0) || /—/.test(r.cost ?? "") || shown == null) continue;
    checked++;
    const expect = (cost / rev) * 100;
    if (Math.abs(expect - shown) > 0.1) bad(`${r.name}: printed ${shown}% but ${cost}/${rev} = ${expect.toFixed(1)}%`);
  }
  eq(`every row with revenue divides to its printed ratio (${checked} rows)`, checked > 5, true);
  if (checked > 5) ok("  …all within 0.1pp");
}

// ── 4. THE PILL MATCHES THE NUMBER ────────────────────────────────────────────────────────────
console.log("\n── the pill agrees with the number inside it ──");
{
  const wrong = field.rows.filter((r) => {
    const v = pct(r.ratio);
    if (v == null || r.band == null) return false;
    const want = v < 50 ? "good" : v < 60 ? "warn" : "bad";
    return r.band !== want;
  });
  eq("no pill disagrees with its printed ratio", wrong.map((r) => `${r.name} ${r.ratio}/${r.band}`), []);
  eq("  control — pills were rendered to be checked", nonEmpty(field.rows, "field.rows").filter((r) => r.band).length > 3, true);
}

// ── 5. RANKS ──────────────────────────────────────────────────────────────────────────────────
console.log("\n── the rank is revenue order and travels with the row ──");
{
  const ranks = field.rows.map((r) => Number(r.rank));
  eq("ranks are 1..N with no gaps or duplicates", ranks, field.rows.map((_, i) => i + 1));
  const revs = field.rows.map((r) => money(r.revenue));
  eq("#1 is the highest-revenue row", revs[0], Math.max(...revs));
  eq("  control — revenues actually differ, so the ordering is a real claim", new Set(revs).size > 1, true);
}

// ── 6. THE COUNT LABEL ────────────────────────────────────────────────────────────────────────
console.log("\n── the count describes the table beside it ──");
eq("Field count matches rendered rows", Number(field.count.replace(/\D/g, "")), field.rows.length);
eq("  …and says 'fields'", /field/i.test(field.count), true);
await page.locator('[data-testid="grain-city"]').click();
await page.waitForTimeout(2000);
{
  const c = await readTable();
  eq("City count matches rendered rows", Number(c.count.replace(/\D/g, "")), c.rows.length);
  eq("  …and says 'cities'", /cit/i.test(c.count), true);
  eq("  …and the two tabs differ, so the count is not a constant", c.rows.length !== field.rows.length, true);
}

// ── 7. THE PRIOR COLUMNS ──────────────────────────────────────────────────────────────────────
console.log("\n── prior month and prior quarter ──");
await page.locator('[data-testid="grain-field"]').click();
await page.waitForTimeout(2500);
{
  const f = await readTable();
  // POSITIVE CONTROL FIRST. byField keys on FieldMonth.key, not the display name; looking up by
  // name made EVERY prior cell a dash, and a suite that only checks "renders — when absent"
  // passes happily on that page.
  const realMonth = f.rows.filter((r) => pct(r.priorMonth) != null).length;
  const realQuarter = f.rows.filter((r) => pct(r.priorQuarter) != null).length;
  eq("  control — Field Economics shows REAL prior-month figures, not all dashes", realMonth > 0, true);
  eq("  control — …and real prior-quarter figures", realQuarter > 0, true);
  console.log(`     ${realMonth}/${f.rows.length} rows carry a prior month, ${realQuarter} a prior quarter`);
  const zeroish = f.rows.filter((r) => /^0\.0%$/.test(r.priorMonth ?? "") && money(r.revenue) === 0);
  eq("no prior cell prints 0.0% for a row with no revenue", zeroish.map((r) => r.name), []);
  eq("absent prior periods render an em dash", f.rows.some((r) => /—/.test(r.priorMonth) || /—/.test(r.priorQuarter)), true);

  // ── 8. NO KNOWN COST ⇒ DASH ON BOTH CELLS ───────────────────────────────────────────────────
  console.log("\n── a venue with no cost on file reads — twice, never 0.0% ──");
  for (const name of ["NEMP", "Onion Creek"]) {
    const r = f.rows.find((x) => x.name === name);
    if (!r) { bad(`${name} is on the page`, "row not found"); continue; }
    eq(`${name} field cost is a dash`, /—/.test(r.cost), true);
    eq(`${name} cost ratio is a dash, not 0.0%`, /—/.test(r.ratio), true);
  }
  // CONTROL: a venue whose cost is a real zero still prints $0, so the dash means something.
  const zero = f.rows.find((x) => x.cost === "$0");
  eq("  control — a genuinely $0 venue still prints $0, not a dash", zero != null, true);
}

// ── 8b. THE FIELD COST CARD SAYS WHAT IT LEAVES OUT ───────────────────────────────────────────
// rollup skips an unknown-cost row's cost but keeps its revenue, so the card's total is smaller
// than the table it sits over by an amount nothing used to name. The marker is that name — and it
// must equal the dashes a reader can actually count, on the active tab.
console.log("\n── the Field cost card names its exclusions ──");
{
  const f = await readTable();
  const dashes = f.rows.filter((r) => /—/.test(r.cost ?? "")).length;
  const marker = await page.evaluate(() =>
    document.querySelector('[data-testid="cost-excluded"]')?.innerText.trim() ?? null);
  eq("  control — there ARE dashed rows on this tab", dashes > 0, true);
  eq("the marker is present when rows are excluded", marker != null, true);
  eq("…and its count equals the dashes on screen", Number((marker ?? "").replace(/\D/g, "")), dashes);
  eq("…and it reads as a plain suffix, not a sentence", /^· \d+ excluded$/.test(marker ?? ""), true);

  // IT MOVES WITH THE TAB. City groups differently — a city with one costed field is not dashed
  // even when one of its fields is — so the count is re-derived, not carried over.
  await page.locator('[data-testid="grain-city"]').click();
  await page.waitForTimeout(2000);
  const c = await readTable();
  const cityDashes = c.rows.filter((r) => /—/.test(r.cost ?? "")).length;
  const cityMarker = await page.evaluate(() =>
    document.querySelector('[data-testid="cost-excluded"]')?.innerText.trim() ?? null);
  eq("on City Economics the count matches that tab's dashes",
     cityMarker == null ? 0 : Number(cityMarker.replace(/\D/g, "")), cityDashes);
  eq("…and renders NOTHING AT ALL when nothing is excluded",
     cityDashes === 0 ? cityMarker === null : cityMarker !== null, true);
  console.log(`     field tab: ${dashes} dashed · city tab: ${cityDashes} dashed`);
  await page.locator('[data-testid="grain-field"]').click();
  await page.waitForTimeout(2000);
}

// ── 9. CROSS-TAB ──────────────────────────────────────────────────────────────────────────────
console.log("\n── every city equals the sum of its fields ──");
{
  const f = await readTable();
  const byCity = {};
  for (const r of f.rows) {
    // City is the 3rd cell on Field Economics.
    const cityName = await page.evaluate((n) => {
      for (const row of document.querySelectorAll('[data-testid="cost-row"]')) {
        const tds = row.querySelectorAll("td");
        if (tds[1]?.innerText.trim() === n) return tds[2]?.innerText.trim();
      }
      return null;
    }, r.name);
    if (!cityName) continue;
    (byCity[cityName] ??= { revenue: 0, cost: 0 });
    byCity[cityName].revenue += money(r.revenue);
    if (!/—/.test(r.cost ?? "")) byCity[cityName].cost += money(r.cost);
  }
  await page.locator('[data-testid="grain-city"]').click();
  await page.waitForTimeout(2000);
  const c = await readTable();
  const mismatches = [];
  for (const r of nonEmpty(c.rows, "c.rows")) {
    const f2 = byCity[r.name];
    if (!f2) { mismatches.push(`${r.name}: no fields`); continue; }
    if (Math.abs(f2.revenue - money(r.revenue)) > 1) mismatches.push(`${r.name} revenue ${money(r.revenue)} vs fields ${f2.revenue}`);
    if (Math.abs(f2.cost - money(r.cost)) > 1) mismatches.push(`${r.name} cost ${money(r.cost)} vs fields ${f2.cost}`);
  }
  // REPORTED, NOT ADJUSTED. Unmatched revenue and the city-NULL row are data facts.
  if (mismatches.length) console.log("     cross-tab differences (reported, not adjusted):\n       " + mismatches.join("\n       "));
  eq("every city reconciles to its fields", mismatches, []);
}

// ── 10. EXPORT KEEPS ALL THREE BUCKETS ────────────────────────────────────────────────────────
console.log("\n── the Export still carries the three revenue buckets ──");
{
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20000 }).catch(() => null),
    page.getByRole("button", { name: /^export$/i }).first().click(),
  ]);
  if (!download) bad("the Export produced a file", "no download event");
  else {
    const stream = await download.createReadStream();
    let csv = ""; for await (const chunk of stream) csv += chunk;
    const header = csv.split("\n")[0];
    eq("the export header still names Revenue", /Revenue/i.test(header), true);
    eq("…Event revenue", /Event revenue/i.test(header), true);
    eq("…and the ratio denominator", /Ratio denominator/i.test(header), true);
    eq("  control — the CSV has data rows, not just a header", csv.trim().split("\n").length > 3, true);
  }
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
