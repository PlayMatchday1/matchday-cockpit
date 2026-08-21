// THE BREAKDOWN PANEL — one card, and filters only where they can change the answer.
//
// WHAT IT WAS: the toggle sat at the foot of MATCHDAY REVENUE, a four-month summary it does not
// control; the filters got a second card; the table a third; Match View a fourth. Four borders,
// one job.
//
// THE TWO ASSERTIONS THAT CARRY THE MOST: "one card" is checked in BOTH directions — the toggle,
// filters and table share an ancestor, AND that ancestor does not contain the summary table. Only
// the first would pass on a page where everything is inside one giant wrapper.
//
// COUNTS AND ABSENCES ARE ASSERTED AFTER FILTERING, not only on load. A count that is right on
// load and frozen afterwards is the failure this panel is most likely to have.
//
//   node scripts/e2e/verify-breakdown-panel.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/admin/finance/revenue?p=2026-08`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="breakdown-card"]', { timeout: 120000 });
await page.waitForTimeout(2500);
eq("no uncaught page errors", errors, []);

const view = async (g) => {
  await page.click(`[data-testid="breakdown-${g}"]`);
  await page.waitForTimeout(g === "match" ? 2600 : 1300);
};
const read = () => page.evaluate(() => {
  const card = document.querySelector('[data-testid="breakdown-card"]');
  const box = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.width > 0; };
  return {
    count: card.querySelector('[data-testid="breakdown-count"]')?.textContent?.trim() ?? null,
    headH: box(card.querySelector('[class*="brkHead"]')),
    filterH: box(card.querySelector('[class*="brkFilters"]')),
    chips: [...card.querySelectorAll('[data-testid="city-chip"]')].filter(visible).length,
    selects: card.querySelectorAll('[data-testid^="mf-"]').length,
    rows: card.querySelectorAll("tbody tr:not([class*='tot'])").length,
    total: card.querySelector('[data-testid="gt-tot-total"]')?.textContent ?? null,
    // PAGE-WIDE counts: the point of the rebuild is that these are one, not two.
    exports: [...document.querySelectorAll("button")].filter((b) => /^export$/i.test(b.textContent.trim())).length,
    clears: [...document.querySelectorAll("button")].filter((b) => /^clear( filters?)?$/i.test(b.textContent.trim())).length,
    counters: [...document.querySelectorAll("*")].filter((e) =>
      e.children.length === 0 && /^\d+ (of \d+ )?(cities|fields|matches|city|field|match)$/i.test(e.textContent.trim())).length,
    sideways: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
});

// ── 1. ONE CARD, ASSERTED BOTH WAYS ───────────────────────────────────────────────────────────
console.log("\n── one card ──");
{
  const A = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="breakdown-card"]');
    const toggle = document.querySelector('[data-testid="breakdown-city"]');
    const table = card.querySelector("table");
    const summary = document.querySelector('[data-testid="revenue-summary"]');
    return {
      toggleInside: card.contains(toggle),
      tableInside: !!table && card.contains(table),
      exportInside: card.contains([...document.querySelectorAll("button")].find((b) => /^export$/i.test(b.textContent.trim())) ?? null),
      summaryInside: card.contains(summary),
      // control: the summary really is on the page, so "not inside" is not "not rendered".
      summaryExists: !!summary,
    };
  });
  eq("  control — the summary table is on the page", A.summaryExists, true);
  eq("the toggle is inside the breakdown card", A.toggleInside, true);
  eq("the table is inside the breakdown card", A.tableInside, true);
  eq("the Export is inside the breakdown card", A.exportInside, true);
  eq("…and the summary table is NOT inside it", A.summaryInside, false);
}

// ── 2. EACH VIEW ──────────────────────────────────────────────────────────────────────────────
for (const [g, noun, wantChips, wantSelects] of [
  ["city", "cities", 0, 0], ["field", "fields", null, 0], ["match", "matches", 0, 13],
]) {
  console.log(`\n── ${g} view ──`);
  await view(g);
  const R = await read();
  console.log(`     ${JSON.stringify({ count: R.count, headH: R.headH, filterH: R.filterH, chips: R.chips, selects: R.selects, rows: R.rows })}`);

  eq(`${g}: exactly one Export on the page`, R.exports, 1);
  // AT MOST ONE. The brief asks for "exactly one" per view and also that Clear hides itself when
  // nothing is filtered — on an unfiltered view those give 0, so the invariant that actually holds
  // everywhere is "never two", and the appear/hide behaviour is asserted directly further down.
  eq(`${g}: never more than one clear control`, R.clears <= 1, true);
  eq(`${g}: exactly one count element`, R.counters, 1);
  eq(`${g}: the count's noun matches the view`, (R.count ?? "").endsWith(noun), true);
  // …and NOT one of the other two nouns, so a frozen label cannot pass by ending in the right word.
  eq(`  …and not another view's noun`,
     ["cities", "fields", "matches"].filter((x) => x !== noun).some((x) => (R.count ?? "").endsWith(x)), false);
  eq(`${g}: the count equals the rendered row count`,
     Number((R.count ?? "").match(/^(\d+)/)?.[1]), R.rows);
  eq(`${g}: the header is under 70px`, R.headH < 70, true);
  eq(`${g}: the page does not scroll sideways`, R.sideways, false);

  if (g === "city") {
    // HEIGHT-ZERO, NOT `hidden`: a row that is present but collapsed still occupies the reading.
    eq("city: the filter row has no measured height", R.filterH, 0);
    eq("city: no city chip has a box", R.chips, 0);
  }
  if (g === "field") {
    eq("field: city chips are visible", R.chips > 1, true);
    eq("field: no field select is rendered", R.selects, 0);
  }
  if (g === "match") {
    /* SIX SELECTS, NOT THIRTEEN — and that is the rebuild, not a regression. MATCH duplicated
     * Kick-off and was deleted; MEMBERS CODE, FREE CODE, DPP'S, TOTAL SPOTS and DPP REVENUE became
     * the lens and table columns. Counted by NAME so a silent drop still shows up. */
    const labels = await page.evaluate(() => ["month", "weekof", "dow", "city", "field", "hour"]
      .filter((k) => document.querySelector(`[data-testid="mv-${k}"]`)));
    eq("match: the six selects are present, by name", labels, ["month", "weekof", "dow", "city", "field", "hour"]);
    eq("  …and the deleted five are gone", await page.evaluate(() =>
      ["members", "free", "dpps", "spots", "dpprev", "match"].filter((k) => document.querySelector(`[data-testid="mf-${k}"]`))), []);
    eq("match: no city chip is visible", R.chips, 0);
  }
  if (wantChips !== null) eq(`${g}: chip count`, R.chips, wantChips);
  // The old grid's mf-* selects are gone everywhere; Match View's own live under mv-*.
  if (wantSelects !== null && g !== "match") eq(`${g}: select count`, R.selects, wantSelects);
}

// ── 3. FILTERING MOVES THE COUNT, THE ROWS AND THE TOTAL ──────────────────────────────────────
console.log("\n── filtering ──");
{
  await view("field");
  const before = await read();
  eq("  control — Clear is absent before any filter", before.clears, 0);
  await page.click('[data-testid="city-chip"][data-city="Austin"]');
  await page.waitForTimeout(1300);
  const after = await read();
  eq("filtering changes the row count", after.rows < before.rows, true);
  eq("  …and the count says what it narrowed FROM", /^\d+ of \d+ fields$/.test(after.count ?? ""), true);
  eq("  …and the count still equals the rendered rows",
     Number((after.count ?? "").match(/^(\d+)/)?.[1]), after.rows);
  // A FILTER THAT LEAVES THE TOTAL UNCHANGED IS DECORATION.
  eq("  …and the total row moves with it", money(after.total) < money(before.total), true);
  eq("  control — both totals are real figures", [money(before.total) > 0, money(after.total) > 0], [true, true]);
  eq("Clear appears once a filter is on", after.clears, 1);
  console.log(`     ${before.count} ${before.total} → ${after.count} ${after.total}`);

  await page.click('[data-testid="breakdown-clear"]');
  await page.waitForTimeout(1300);
  const cleared = await read();
  eq("Clear restores every row", cleared.rows, before.rows);
  eq("  …and hides itself again", cleared.clears, 0);
  eq("  …and the count returns to the unfiltered form", cleared.count, before.count);
}

// ── 4. SWITCHING VIEW CARRIES WHAT THE NEXT VIEW CAN USE ──────────────────────────────────────
console.log("\n── carrying a selection across views ──");
{
  await view("field");
  await page.click('[data-testid="city-chip"][data-city="Austin"]');
  await page.waitForTimeout(1300);
  await view("match");
  /* THE CITY LANDS IN MATCH VIEW'S OWN SELECT NOW. The thirteen-select grid (mf-*) is gone; Match
   * View filters itself, so a city carried from Field View arrives as its city selection — visible,
   * chipped and clearable — rather than being applied to the rows upstream where nothing showed it. */
  const mfCity = await page.evaluate(() => document.querySelector('[data-testid="mv-city"]')?.value);
  eq("field → match keeps the city, in Match View's own City select", mfCity, "Austin");
  const m = await read();
  /* THE TOGGLE SIZES THE DATASET; MATCH VIEW'S CONTEXT LINE STATES THE SELECTION. Two questions,
   * two answers, both visible — not the duplicate count the old grid produced. */
  eq("  …and the toggle counts the whole dataset", /^\d[\d,]* matches$/.test(m.count ?? ""), true);
  const ctx = await page.evaluate(() => document.querySelector('[data-testid="mv-context"]')?.textContent ?? "");
  eq("  …while Match View states the narrowed selection", /Austin/.test(ctx), true);
  eq("  …and the two figures differ, so neither is a copy of the other",
     Number((ctx.match(/Showing ([\d,]+)/) ?? [])[1]?.replace(/,/g, "")) < Number((m.count ?? "").replace(/[^0-9]/g, "")), true);
  const clears = await page.evaluate(() =>
    document.querySelectorAll('[data-testid="mv-clear-all"], [data-testid="breakdown-clear"]').length);
  eq("  …and exactly one clear control is offered", clears, 1);
  console.log(`     match: ${m.count}`);

  await view("city");
  await view("field");
  const back = await read();
  eq("field → city drops it, and going back to Field starts at All",
     /^\d+ fields$/.test(back.count ?? ""), true);
  eq("  …with no Clear offered", back.clears, 0);
}

// ── 5. THE FIGURES ARE THE SAME FIGURES ───────────────────────────────────────────────────────
console.log("\n── figures unchanged ──");
{
  await view("city");
  const F = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="breakdown-card"]');
    const n = (t) => Number(String(t ?? "").replace(/[^0-9.-]/g, ""));
    const tbl = card.querySelector("table");
    const body = [...tbl.querySelectorAll("tbody tr")].filter((r) => !r.className.includes("tot"));
    const head = [...tbl.querySelectorAll("thead th")].map((h) => h.innerText.trim().toUpperCase());
    const iTot = head.findIndex((h) => h.startsWith("TOTAL REVENUE"));
    const iDpp = head.findIndex((h) => h.startsWith("DPP REVENUE"));
    const iMem = head.findIndex((h) => h.startsWith("MEMBERSHIP REVENUE"));
    const cells = (r) => [...r.querySelectorAll("td,th")];
    return {
      iTot, iDpp, iMem,
      rows: body.map((r) => ({ tot: n(cells(r)[iTot]?.innerText), dpp: n(cells(r)[iDpp]?.innerText), mem: n(cells(r)[iMem]?.innerText) })),
      tot: { tot: n(card.querySelector('[data-testid="gt-tot-total"]')?.innerText),
             dpp: n(card.querySelector('[data-testid="gt-tot-dpp"]')?.innerText),
             mem: n(card.querySelector('[data-testid="gt-tot-member"]')?.innerText) },
    };
  });
  eq("  control — the three revenue columns were located", [F.iTot > 0, F.iDpp > 0, F.iMem > 0], [true, true, true]);
  eq("  control — the table had rows", F.rows.length > 0, true);
  const bad1 = F.rows.filter((r) => Math.abs(r.dpp + r.mem - r.tot) > 1);
  eq("DPP + membership equals total revenue on every row", bad1.length, 0);
  eq("  …and on the total row", Math.abs(F.tot.dpp + F.tot.mem - F.tot.tot) <= 1, true);
  const sum = F.rows.reduce((a, r) => a + r.tot, 0);
  eq("the city rows sum to the total row", Math.abs(sum - F.tot.tot) <= 1, true);
  console.log(`     ${F.rows.length} rows summing ${Math.round(sum)} · total row ${F.tot.tot}`);
}

// ── 6. THE HEADER AT A NARROWER WIDTH ─────────────────────────────────────────────────────────
console.log("\n── 1024px ──");
{
  await page.setViewportSize({ width: 1024, height: 1200 });
  await page.waitForTimeout(800);
  for (const g of ["city", "field", "match"]) {
    await view(g);
    const R = await read();
    eq(`${g}: the header is under 70px at 1024px`, R.headH < 70, true);
    eq(`  …and the page still does not scroll sideways`, R.sideways, false);
  }
}

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  " + f)); }
await closeContext(ctx);
await closeBrowser(browser);
process.exit(FAIL === 0 ? 0 : 1);
