// REVENUE PACE — the grain follows the period.
//
// Month by day, quarter by week, year by month. Every expected count in here is DERIVED from the
// period the page is actually showing, never pinned to a live figure: three suites this session
// hardcoded a number that was true the day it was written, and each one failed for the wrong
// reason later. The bucket counts come from the calendar, and the revenue total comes from the
// tile on the same screen rather than from a constant.
//
// WHAT THIS EXISTS TO CATCH. The card used to chart `period.months[last]` at every grain — a month
// in the FUTURE on Quarter and Year — so both of those views drew nothing and said "compared with
// —". An empty chart and a chart of real zeroes looked identical.

import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

/** The period the page is showing, parsed from its own label into a start/end pair. */
function windowOf(label) {
  let m;
  if ((m = label.match(/^([A-Za-z]+) (\d{4})$/))) {
    const mi = MONTH_FULL.indexOf(m[1]);
    return { grain: "month", start: new Date(+m[2], mi, 1), end: new Date(+m[2], mi + 1, 0) };
  }
  if ((m = label.match(/^Q(\d) (\d{4})$/))) {
    const q = +m[1] - 1;
    return { grain: "quarter", start: new Date(+m[2], q * 3, 1), end: new Date(+m[2], q * 3 + 3, 0) };
  }
  if ((m = label.match(/^(\d{4})$/))) {
    return { grain: "year", start: new Date(+m[1], 0, 1), end: new Date(+m[1], 12, 0) };
  }
  throw new Error(`unparseable period label ${JSON.stringify(label)}`);
}

/** How many buckets that window has at its own grain — the calendar's answer, not the chart's. */
function expectedBuckets({ grain, start, end }) {
  if (grain === "month") return Math.round((end - start) / 86400000) + 1;
  if (grain === "year") return 12;
  let n = 0;
  for (let w = mondayOf(start); w <= end; w = addDays(w, 7)) n += 1;
  return n;
}

const money = (t) => {
  const m = String(t ?? "").replace(/,/g, "").match(/-?\$?\s*([\d.]+)/);
  return m ? Number(m[1]) : null;
};

const browser = await chromium.launch();
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

// Every /rest/v1/ request the pace card makes, identified by its own column list.
const PACE_Q = /select=date%2Ccity%2Cvenue%2Ctype%2Cgross/;
let paceReqs = [];
page.on("request", (r) => { if (PACE_Q.test(r.url())) paceReqs.push(r.url()); });

const readChart = () => page.evaluate(() => {
  const card = document.querySelector('[data-testid="pace-card"]');
  const svg = document.querySelector('[data-testid="pace-chart"]');
  if (!card || !svg) return null;
  const j = (a) => JSON.parse(svg.getAttribute(a) ?? "null");
  return {
    grain: card.getAttribute("data-grain"),
    title: document.querySelector('[data-testid="pace-title"]')?.textContent ?? "",
    sub: document.querySelector('[data-testid="pace-sub"]')?.textContent ?? "",
    period: document.querySelector('[data-testid="period-label"]')?.textContent ?? "",
    tile: document.querySelector('[data-testid="tile-revenue"] [data-testid="revenue-tile-value"]')?.textContent ?? null,
    current: j("data-current") ?? [],
    compare: j("data-compare") ?? [],
    partial: j("data-partial") ?? [],
    labels: j("data-labels") ?? [],
    dots: document.querySelectorAll('[data-testid="pace-dot-partial"]').length,
  };
});

/* SWITCH GRAIN AND LAND ON THE CURRENT PERIOD OF IT.
 *
 * The jump is not tidiness. Changing grain does NOT preserve the point in time: FinanceShell derives
 * the period from the URL alone, and `p=2026` parses back with its anchor at 1 January, so
 * August → Q3 → 2026 → month lands on JANUARY 2026. Without the jump this suite drifts to whatever
 * period that walk happens to reach, and half of what it asserts — a running period, a partial
 * trailing bucket — is only true of the current one. The drift is reported separately; here it is
 * pinned down so the assertions mean what they say. */
async function grain(g, { jump = true } = {}) {
  await page.click(`[data-testid="period-grain-${g}"]`);
  await page.waitForFunction((want) => document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-grain") === want, g, { timeout: 120000 });
  if (jump) {
    await page.click('[data-testid="period-jump"]');
    await page.waitForTimeout(400);
  }
  await settle(g);
  return readChart();
}

/** Wait for a USABLE chart AND the tiles beside it — the tiles arrive later, behind their own load. */
async function settle(g) {
  await page.waitForFunction((want) => {
    const c = document.querySelector('[data-testid="pace-card"]');
    return c?.getAttribute("data-grain") === want && !!document.querySelector('[data-testid="pace-chart"]');
  }, g, { timeout: 120000 });
  await page.waitForSelector('[data-testid="tile-revenue"] [data-testid="revenue-tile-value"]', { timeout: 180000 });
}

/** One period back at the current grain — the way to reach a CLOSED period from a running one. */
async function stepBack() {
  const before = await page.evaluate(() => document.querySelector('[data-testid="period-label"]')?.textContent ?? "");
  await page.click('[data-testid="period-prev"]');
  await page.waitForFunction((b) => (document.querySelector('[data-testid="period-label"]')?.textContent ?? "") !== b, before, { timeout: 60000 });
  const g = await page.evaluate(() => document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-grain") ?? "");
  await settle(g);
  return readChart();
}

await page.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="pace-chart"]', { timeout: 180000 });
await page.waitForTimeout(2500);

// ── 1. ONE POINT PER BUCKET, AT EVERY GRAIN ───────────────────────────────────────────────────
console.log("\n── the grain follows the period ──");
const seen = {};
for (const g of ["month", "quarter", "year"]) {
  const c = await grain(g);
  seen[g] = c;
  if (!c) { bad(`${g}: the chart rendered`, "no pace-chart element"); continue; }
  const w = windowOf(c.period);
  eq(`  control — the page is on a ${g} period ("${c.period}")`, w.grain, g);
  const want = expectedBuckets(w);
  eq(`${g}: one point per ${{ month: "day", quarter: "week", year: "month" }[g]}`, c.labels.length, want);
  // THE CURRENT LINE STOPS AT THE LAST BUCKET THE PERIOD HAS REACHED. Future buckets are omitted
  // rather than drawn at zero, so this is <= the bucket count and never more.
  eq(`  …and the drawn series never exceeds it`, c.current.length <= want, true);
  eq(`  …and it drew at least one point`, c.current.length >= 1, true);
}

// ── 2. THE TITLE IS DERIVED, AND NEVER THE WRONG WORD ─────────────────────────────────────────
console.log("\n── the title says which grain it is ──");
const WORD = { month: "Daily", quarter: "Weekly", year: "Monthly" };
const BY = { month: "by day", quarter: "by week", year: "by month" };
for (const g of ["month", "quarter", "year"]) {
  const c = seen[g];
  eq(`${g}: the title reads "${WORD[g]} revenue pace"`, c.title.trim(), `${WORD[g]} revenue pace`);
  eq(`  …and the subtitle says "${BY[g]}"`, c.sub.includes(BY[g]), true);
  // THE WORD "DAILY" MUST NOT SURVIVE ON A WEEKLY OR MONTHLY CHART. Scoped to the card, because
  // "Avg daily revenue" is a legitimate tile elsewhere on the same screen.
  // READ FROM WHAT WAS CAPTURED ON THAT VIEW, not from the DOM — the page has moved on since, and
  // scanning it here would test the last grain visited three times over.
  const text = `${c.title} ${c.sub}`;
  for (const wrong of ["Daily", "Weekly", "Monthly"].filter((x) => x !== WORD[g])) {
    eq(`  ${g}: "${wrong}" appears nowhere in its title or subtitle`, new RegExp(wrong, "i").test(text), false);
  }
}
// POSITIVE CONTROL for the six absence checks above: the same regex scan over the same captured
// strings, for the word that IS there. Without it, a capture that came back empty would pass all six.
for (const g of ["month", "quarter", "year"]) {
  eq(`  control — that same scan DOES find "${WORD[g]}" on the ${g} view`,
    new RegExp(WORD[g], "i").test(`${seen[g].title} ${seen[g].sub}`), true);
}

// ── 3. THE POINTS SUM TO THE PERIOD'S OWN TOTAL ───────────────────────────────────────────────
console.log("\n── each grain sums to the period total ──");
for (const g of ["month", "quarter", "year"]) {
  const c = seen[g];
  const shown = money(c.tile);
  const sum = c.current.reduce((a, b) => a + b, 0);
  eq(`  control — the ${g} revenue tile carries a figure`, Number.isFinite(shown) && shown > 0, true);
  // TO THE DOLLAR. The series is unrounded, the tile is rounded once — half a dollar is the whole
  // tolerance, and anything wider would stop catching a mis-bucketed day.
  eq(`${g}: the plotted points sum to the ${c.period} revenue tile ($${Math.round(sum).toLocaleString()})`,
    Math.abs(sum - shown) < 1, true);
}

// ── 4. THE COMPARISON DRAWS ITS FULL PERIOD ───────────────────────────────────────────────────
console.log("\n── the comparison draws in full ──");
for (const g of ["month", "quarter", "year"]) {
  const c = seen[g];
  eq(`  control — ${g} has a comparison series`, c.compare.length > 0, true);
  // FULL, not cut to what the current period has reached. The comparison is a whole prior period,
  // so it is at least as long as the current one and, in a period still running, strictly longer.
  eq(`${g}: the comparison is at least as long as the current series`, c.compare.length >= c.current.length, true);
  const w = windowOf(c.period);
  // A prior month/quarter/year has its own bucket count, which need not equal this one's (Feb has
  // 28 days, a quarter can hold 13 or 14 Mondays) — so this asserts it is a FULL period, by
  // checking it is not the truncated length of the current one while the current one is running.
  if (c.current.length < expectedBuckets(w)) {
    eq(`  …and is NOT truncated to the current period's drawn length`, c.compare.length === c.current.length, false);
  }
}

// ── 5. THE PARTIAL BUCKET IS MARKED ───────────────────────────────────────────────────────────
console.log("\n── the trailing bucket is marked partial ──");
{
  const c = await grain("quarter");
  const w = windowOf(c.period);
  const last = c.current.length - 1;
  eq("  control — the quarter is still running (its line is short of its buckets)",
    c.current.length < expectedBuckets(w), true);
  eq("the last drawn week is marked partial", c.partial.includes(last), true);
  eq("  …and the week before it is NOT", c.partial.includes(last - 1), false);
  eq("  …and a hollow marker is drawn for each partial point", c.dots, c.partial.length);
  eq("  control — at least one marker is drawn", c.dots >= 1, true);
  const note = await page.locator('[data-testid="pace-partial-note"]').count();
  eq("  …and the legend explains the hollow point", note, 1);

  // A CLOSED PERIOD HAS NO STILL-OPEN BUCKET. Its edges can still clip a week, so this asserts the
  // TRAILING point specifically rather than that nothing at all is marked.
  // A CLOSED MONTH, reached by stepping back one from the running one.
  await grain("month");
  const m = await stepBack();
  eq("  control — the previous month is complete (every bucket drawn)",
    m.current.length, expectedBuckets(windowOf(m.period)));
  eq(`a completed month (${m.period}) marks no day partial at all`, m.partial, []);
  eq("  …and draws no hollow marker", m.dots, 0);
}

// ── 6. THE READOUT, AT EVERY GRAIN ────────────────────────────────────────────────────────────
console.log("\n── the readout speaks the grain ──");
{
  const box = await page.locator('[data-testid="pace-hit"]').boundingBox();
  const hoverMid = async () => {
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.waitForTimeout(220);
    return page.evaluate(() => {
      const t = document.querySelector('[data-testid="pace-readout"]');
      return t ? {
        label: t.querySelector('[data-testid="pace-readout-label"]')?.textContent ?? "",
        cur: t.querySelector('[data-testid="pace-readout-current"]')?.textContent ?? "",
      } : null;
    });
  };
  for (const [g, re, shape] of [
    ["month", /^[A-Z][a-z]{2} \d{1,2}$/, "Aug 17"],
    ["quarter", /^Week of [A-Z][a-z]{2} \d{1,2}$/, "Week of Aug 17"],
    ["year", /^[A-Z][a-z]+ \d{4}$/, "August 2026"],
  ]) {
    await grain(g);
    const b = await page.locator('[data-testid="pace-hit"]').boundingBox();
    await page.mouse.move(b.x + b.width * 0.45, b.y + b.height * 0.5);
    await page.waitForTimeout(250);
    const r = await hoverMid();
    eq(`${g}: a readout appears on hover`, r != null, true);
    eq(`  …and its label reads like "${shape}" (got "${r?.label}")`, re.test(r?.label ?? ""), true);
    eq(`  …and it carries an amount`, /\$/.test(r?.cur ?? ""), true);
  }
  await page.mouse.move(5, 5);
}

// ── 7. THREE SWITCHES AND BACK ────────────────────────────────────────────────────────────────
console.log("\n── switching does not accumulate ──");
{
  const first = await grain("month");
  paceReqs = [];
  await grain("quarter"); await grain("year"); await grain("month");
  await grain("quarter"); await grain("year");
  const again = await grain("month");
  eq("  control — the first pass drew points", first.current.length > 0, true);
  eq("the same period returns the same series", again.current, first.current);
  eq("  …the same comparison", again.compare, first.compare);
  eq("  …the same partial marks", again.partial, first.partial);
  eq("  …and the same labels", again.labels, first.labels);
  // THE MEASURED FIX. The card used to refetch ~6,300 rows over seven pages on every period
  // change; the row set is now cached at module scope, which the parent's unmount cannot clear.
  eq("seven grain switches cost the pace card no requests at all", paceReqs.length, 0);
}

// ── 8. THE CACHE IS KEYED ON THE RANGE, AND ONLY ON THINGS THAT CHANGE THE ROWS ───────────────
console.log("\n── the cache key ──");
{
  const snap = () => page.evaluate(() => {
    const c = document.querySelector('[data-testid="pace-card"]');
    return { range: c?.getAttribute("data-cacherange") ?? "", rows: Number(c?.getAttribute("data-cacherows") ?? 0) };
  });
  await grain("year");
  const before = await snap();
  eq("  control — the card publishes the range its cache holds", /^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/.test(before.range), true);
  eq("  control — …and how many rows it holds", before.rows > 0, true);

  // WIDENING PAST THE CACHED UPPER BOUND MUST FETCH. Stepping the year forward moves the needed
  // upper bound past what the slot covers, which is the one case a superset test cannot answer.
  paceReqs = [];
  const labelBefore = await page.evaluate(() => document.querySelector('[data-testid="period-label"]')?.textContent ?? "");
  await page.click('[data-testid="period-next"]');
  await page.waitForFunction((b) => (document.querySelector('[data-testid="period-label"]')?.textContent ?? "") !== b, labelBefore, { timeout: 60000 });
  await settle("year");
  const widened = await snap();
  eq(`widening past the cached bound (${labelBefore} → ${await page.evaluate(() => document.querySelector('[data-testid="period-label"]')?.textContent)}) issues a fetch`, paceReqs.length > 0, true);
  eq("  …and the slot now records the wider range", widened.range > before.range, true);

  // NARROWING WITHIN IT MUST NOT. This is the positive control's other half: the counter above
  // proved it can see a fetch, so a zero here is a real zero.
  paceReqs = [];
  await page.click('[data-testid="period-prev"]');
  await page.waitForFunction((b) => (document.querySelector('[data-testid="period-label"]')?.textContent ?? "") === b, labelBefore, { timeout: 60000 });
  await settle("year");
  eq("narrowing back inside the cached range issues ZERO fetches", paceReqs.length, 0);
  eq("  …and the slot still holds the wider range", (await snap()).range, widened.range);

  // CITY, FIELD AND KIND ARE CLIENT-SIDE FILTERS. They change what is drawn and must never change
  // what is fetched — if any of them entered the key, the cache would miss on every filter change.
  for (const [testid, pick] of [["pace-kind", "dpp"], ["pace-city", null], ["pace-field", null]]) {
    const opts = await page.evaluate((t) => [...document.querySelectorAll(`[data-testid="${t}"] option`)].map((o) => o.value), testid);
    const value = pick ?? opts.find((o) => o && !/^All /.test(o));
    if (!value) { eq(`  control — ${testid} offers a second option`, false, true); continue; }
    const drawnBefore = await page.evaluate(() => document.querySelector('[data-testid="pace-chart"]')?.getAttribute("data-current"));
    paceReqs = [];
    await page.selectOption(`[data-testid="${testid}"]`, value);
    await page.waitForTimeout(900);
    const drawnAfter = await page.evaluate(() => document.querySelector('[data-testid="pace-chart"]')?.getAttribute("data-current"));
    // THE CONTROL FOR THE ZERO: the filter really did move the chart, so "no fetch" is not "no
    // change". A select that silently did nothing would otherwise pass this line.
    eq(`  control — ${testid}="${value}" changed what is drawn`, drawnBefore !== drawnAfter, true);
    eq(`changing ${testid} issues ZERO fetches`, paceReqs.length, 0);
  }
}

// ── 9. TWO MOUNTS, ONE COLD KEY — AND THE MONOTONIC WRITE ─────────────────────────────────────
// Both need a FRESH browser context: the cache is module scope, so the only way to reach a cold key
// is a new document.
console.log("\n── two mounts against a cold key ──");
{
  const c2 = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
  const p2 = await c2.newPage();
  const reqs = [];
  p2.on("request", (r) => { if (PACE_Q.test(r.url())) reqs.push(decodeURIComponent(r.url())); });
  // HOLD THE FIRST FETCH OPEN so a second mount lands on a key that is cold but already in flight —
  // which is the case the single in-flight slot exists for. Without the delay the first fetch wins
  // the race by luck and the assertion proves nothing.
  await p2.route("**/rest/v1/fin_revenue*", async (route) => {
    if (!PACE_Q.test(route.request().url())) return route.fallback();
    await new Promise((r) => setTimeout(r, 2500));
    return route.fallback();
  });
  await p2.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
  await p2.waitForSelector('[data-testid="pace-card"]', { timeout: 180000 });
  // FORCE THE SECOND MOUNT while the first fetch is still open.
  await p2.click('[data-testid="period-grain-year"]').catch(() => {});
  await p2.waitForFunction(() => document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-grain") === "year", null, { timeout: 60000 });
  await p2.waitForSelector('[data-testid="pace-chart"]', { timeout: 180000 });
  await p2.waitForTimeout(2500);

  const held = await p2.evaluate(() => Number(document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-cacherows") ?? 0));
  // ONE SET = one request per page of the row count, each offset appearing exactly once. Derived
  // from the rows actually held: the pager stops on a short page, so a full multiple costs one more.
  const pages = Math.floor(held / 1000) + 1;
  const offsets = reqs.map((u) => u.match(/offset=(\d+)/)?.[1]).filter((x) => x != null);
  eq("  control — the card mounted twice (the grain changed under an open fetch)",
    await p2.evaluate(() => document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-grain")), "year");
  eq("  control — the cold load actually fetched", offsets.length > 0, true);
  eq(`two mounts against a cold key issue ONE set of ${pages} page(s)`, offsets.length, pages);
  eq("  …with every offset requested exactly once", new Set(offsets).size, offsets.length);
  await c2.close();
}

console.log("\n── the monotonic write ──");
{
  const c3 = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
  const p3 = await c3.newPage();
  const thisYear = new Date().getFullYear();
  const narrowBound = `${thisYear}-12-31`;
  const wideBound = `${thisYear + 1}-12-31`;
  let narrowServed = 0, wideServed = 0;
  /* THE NARROW FETCH IS HELD ON A GATE, NOT ON A TIMER, and then answered with nothing.
   *
   * A TIMER DOES NOT PRODUCE THE RACE. A 7s hold looked like it did and the suite passed — until the
   * monotonic guard was deleted and it passed anyway. The narrow fetch had been resolving FIRST,
   * because reaching the widen click takes longer than the hold: the section's own load blocks it
   * for ~20s. The order this asserts has to be imposed, not hoped for.
   *
   * The two fetches also have to differ in ROW COUNT, which they cannot do naturally: the app never
   * asks for a bound below the end of the current year, and a future year holds no revenue, so the
   * real narrow and wide reads return identical rows and a row-count assertion would pass either
   * way. A stored range without its matching rows is the exact bug, so the rows must differ. */
  let releaseNarrow = () => {};
  const narrowGate = new Promise((r) => { releaseNarrow = r; });
  await p3.route("**/rest/v1/fin_revenue*", async (route) => {
    const u = decodeURIComponent(route.request().url());
    if (!PACE_Q.test(route.request().url())) return route.fallback();
    if (u.includes(`lte.${narrowBound}`)) {
      narrowServed += 1;
      await narrowGate;
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    }
    if (u.includes(`lte.${wideBound}`)) wideServed += 1;
    return route.fallback();
  });
  await p3.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
  await p3.waitForSelector('[data-testid="pace-card"]', { timeout: 180000 });
  // The narrow fetch is now open and CANNOT finish. Widen, client-side, so the wide fetch starts
  // and is the first of the two to write the slot.
  await p3.click('[data-testid="period-grain-year"]');
  await p3.waitForFunction(() => document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-grain") === "year", null, { timeout: 60000 });
  await p3.click('[data-testid="period-next"]');
  await p3.waitForFunction((w) => (document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-cacherange") ?? "").endsWith(w), wideBound, { timeout: 180000 });
  const wide = await p3.evaluate(() => ({
    range: document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-cacherange"),
    rows: Number(document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-cacherows") ?? 0),
  }));
  eq("  control — the wide fetch landed first and holds rows", wide.rows > 0, true);
  eq("  control — …and the narrow fetch is still open at that moment", narrowServed > 0, true);

  // NOW let the narrow one finish, LAST, and force a render so the slot is republished.
  releaseNarrow();
  await p3.waitForTimeout(1500);
  await p3.selectOption('[data-testid="pace-kind"]', "dpp");
  await p3.waitForTimeout(900);
  const after = await p3.evaluate(() => ({
    range: document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-cacherange"),
    rows: Number(document.querySelector('[data-testid="pace-card"]')?.getAttribute("data-cacherows") ?? 0),
  }));
  eq("  control — the wide fetch was served", wideServed > 0, true);
  eq("a late narrow fetch does NOT replace the wider slot's range", after.range, wide.range);
  eq("  …nor its rows — the range still carries the rows that cover it", after.rows, wide.rows);
  eq("  …and that row count is the WIDE one, not the narrow fetch's zero", after.rows > 0, true);
  await c3.close();
}

eq("no uncaught page errors", errors, []);

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ${f}`);
}
await closeContext(ctx);
await closeBrowser(browser);
process.exit(failures.length ? 1 : 0);
