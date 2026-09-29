// Assertions for scripts/mocks/player-activity-v2.html
// Run: node scripts/mocks/player-activity-v2.assert.mjs [url]
// Default target is the mock. Point it at the deployed page to check the build against the spec:
//   node -e 'import("./scripts/e2e/_session.mjs").then(async m=>{process.loadEnvFile(".env.local");
//     const {storageState}=await m.storageStateFor("rmancuso@playmatchday.com",process.argv[1]);
//     require("fs").writeFileSync("/tmp/pa-state.json",JSON.stringify(storageState));})' \
//     https://matchday-clubhouse.vercel.app
//   PA_STATE=/tmp/pa-state.json node scripts/mocks/player-activity-v2.assert.mjs \
//     https://matchday-clubhouse.vercel.app/lifecycle/behavior
//
// Without PA_STATE the app redirects to /login and the run times out on pa-card. Two things about
// that state matter and both cost time once:
//
//   THE ORIGIN MUST MATCH THE TARGET. storageState is keyed by origin, so a state built for the
//   deployed host does nothing against http://localhost:3001 — pass the base you are testing.
//
//   IT MUST NOT BE THE E2E SERVICE ACCOUNT. `scripts/e2e/auth.mjs` writes .auth/state.json for
//   E2E_EMAIL, and that identity is BLOCKED AT THE DATABASE BY DESIGN: the page loads and
//   /api/lifecycle answers, but /api/lifecycle/behavior-weekly returns
//   403 {"error":"Service accounts hold no permissions."} and the distinct totals sit on a dash.
//   That reads exactly like a broken aggregate and is not one. Use a real admin email.
// Rule: every absence assertion is paired with a presence control in the same run.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "file://" + path.join(here, "player-activity-v2.html");
const tid = id => `[data-testid="${id}"]`;
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("PASS", msg); } else { fail++; console.log("FAIL", msg); } };
const num = s => Number(String(s).replace(/[^0-9.-]/g, ""));

/* ── DRIVING THE REAL PAGE NEEDS A REAL SESSION ──────────────────────────────────────────────
 * Against the mock (a file:// URL) this is unused. Against the app, /lifecycle/behavior sits behind
 * PagePermissionGuard and an unauthenticated run lands on /login?next=… and times out on pa-card.
 * PA_STATE points at a Playwright storageState JSON — the one scripts/e2e/auth.mjs and
 * scripts/e2e/_session.mjs already produce for the project's own identity. This is the repo's
 * existing sign-in path, not a way around the guard: no session, no page. */
const statePath = process.env.PA_STATE;
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  ...(statePath ? { storageState: statePath } : {}),
});
const errors = []; page.on("pageerror", e => errors.push(e.message));
await page.goto(url);
await page.waitForSelector(tid("pa-card"));
ok(true, "instrument ran: page loaded and pa-card rendered");

// 1. Naming
ok((await page.textContent(tid("pa-title"))).trim() === "Player Activity", "page title is Player Activity");
ok((await page.textContent(tid("nav-player-activity"))).trim() === "Player Activity", "sidebar says Player Activity, not Player Behavior");

// 2. One time control, matching Player Funnel
ok(await page.isVisible(tid("pa-range-from")) && await page.isVisible(tid("pa-range-to")), "presence: From and To month inputs");
ok(await page.inputValue(tid("pa-range-from")) === "2026-04" && await page.inputValue(tid("pa-range-to")) === "2026-09", "default range Apr 2026 to Sep 2026 (six months ending in the current month)");
ok((await page.textContent(tid("pa-range-label"))).trim() === "Apr 2026 to Sep 2026", "resolved range label matches funnel wording");
const body = await page.textContent("main");
ok(!/Last 6 months|Last 3 months|Last 12 months/.test(body), "absence: no preset period bar competing with the range");
ok(/Apr 2026 to Sep 2026/.test(body), "presence control for the text scan above");

// 3. No chart
const buttons = await page.$$eval("main button", bs => bs.map(b => b.textContent.trim()));
ok(!buttons.some(t => /chart/i.test(t)), "absence: no Show chart button");
ok(buttons.includes("Export"), "presence control: Export button found by the same scan");
ok(await page.locator("main canvas, main svg.recharts-surface").count() === 0, "absence: no chart element");

// 4. Overall table
const overallRows = await page.locator(`${tid("pa-table-overall")} tbody tr`).count();
ok(overallRows === 6, `overall has 6 metric rows (got ${overallRows})`);
const heads = await page.$$eval(`${tid("pa-table-overall")} thead th`, t => t.map(x => x.textContent.trim()));
ok(heads.length === 1 + 6 + 2, `overall header: metric + 6 months + total + change (got ${heads.length})`);
ok(/SEP 2026|Sep 2026/i.test(heads[6]) && /IN PROGRESS/i.test(heads[6]), "Sep 2026 is a column, marked in progress once in the header");
ok(/Aug 2026 vs Jul 2026/.test(heads[8]), "change column names its window: last complete month vs prior");
/* WAIT FOR THE DISTINCT TOTAL TO RESOLVE BEFORE READING IT. It comes from a second request
 * (the route's window aggregate) and renders an em-dash until that lands, and `num("—")` is 0 —
 * a race that reads as "the number is wrong" rather than "the number has not arrived". The mock
 * is synchronous and satisfies this immediately. */
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="pa-total-totalPlayers"]');
  return el && !el.textContent.includes("\u2014");
}, null, { timeout: 60000 }).catch(() => {});
const tp = num(await page.textContent(tid("pa-total-totalPlayers")));
/* A DISTINCT COUNT OVER A RANGE THAT ENDS TODAY MOVES EVERY DAY, so pinning 8,361 would date this
 * the way verify-pace-readout dated itself on the 25th. The mock carries the verified 8,361 for
 * Apr-Sep 2026 and still asserts it exactly; against a live page the BAND is the assertion and the
 * value is printed for the reader. The real check is the one below: below the sum of the months. */
ok(url.startsWith("file://") ? tp === 8361 : tp > 5000 && tp < 12000,
  `Total players period total is a plausible distinct count (got ${tp}; the mock's verified figure is 8,361)`);
const tpMonths = await page.$$eval(`${tid("pa-row-totalPlayers")} td`, t => t.slice(1, 7).map(x => Number(x.textContent.replace(/[^0-9]/g, ""))));
ok(tp < tpMonths.reduce((a, b) => a + b, 0), "distinct total is below the sum of the months (the old bug summed them)");
const spots = num(await page.textContent(tid("pa-total-spots")));
const spotsMonths = await page.$$eval(`${tid("pa-row-spots")} td`, t => t.slice(1, 7).map(x => Number(x.textContent.replace(/[^0-9]/g, ""))));
ok(spots === spotsMonths.reduce((a, b) => a + b, 0), "presence control: additive Spots booked total equals the sum of its months");
ok(!/being rewired/.test(body), "absence: no long explainer paragraph above the table");

// 4b. Metric descriptions live behind the "i", not on the page
//
// REWRITTEN 2026-09-29. This block asserted a `pa-legend` definition list of 8 entries beneath the
// table. NOTHING EVER IMPLEMENTED THAT: it fails against the MOCK it is the assertion script for —
// `page.$eval('[data-testid="pa-legend"]')` throws and takes the whole run down, so every assertion
// after it (fields, sorting, expansion, cities, compare, grains — about sixty of them) never ran.
// The mock and the brief agree with each other and not with this block: descriptions sit behind a
// small "i" beside each metric name, shown on hover / tap / focus and hidden otherwise, with no
// legend and no footnote. The block now asserts THAT, keeping the two checks worth keeping — the
// verbatim wording, and that nothing is printed into the table.
const infoIds = await page.$$eval('[data-testid^="pa-info-"]', els => els.map(e => e.dataset.testid));
ok(infoIds.length === 6, `one "i" per metric row (got ${infoIds.length})`);
// VISIBILITY, NOT PRESENCE. The mock keeps one hidden tooltip node in the DOM and the build mounts
// one on demand; both are "no tooltip showing", and a presence check would call one of them wrong.
ok(!(await page.isVisible(tid("pa-tip"))), "absence: no tooltip showing before anything is hovered");
// PRESENCE CONTROL FOR THE ABSENCE ABOVE: the same selector, after a hover, definitely finds one.
await page.hover(tid("pa-info-totalPlayers"));
await page.waitForSelector(tid("pa-tip"), { state: "visible" });
ok((await page.textContent(tid("pa-tip"))).trim() === "Players who played, counted once per period.",
  "Total players wording is Ryan's, verbatim, and it is in the tooltip");
await page.hover(tid("pa-title"));
await page.waitForSelector(tid("pa-tip"), { state: "hidden" });
ok(true, "the tooltip hides again when the pointer leaves");
// KEYBOARD AND TAP REACH IT TOO, not hover alone.
await page.focus(tid("pa-info-registrations"));
await page.waitForSelector(tid("pa-tip"), { state: "visible" });
ok((await page.textContent(tid("pa-tip"))).trim() === "Completed signups, grouped by city selected at signup.",
  "keyboard focus opens the description, verbatim");
await page.locator(tid("pa-info-registrations")).evaluate(e => e.blur());
ok(!/Completed signups, grouped by city/.test(await page.textContent("main")),
  "absence: no metric description is printed into the page");
ok(await page.locator(`${tid("pa-table-overall")} td.desc`).count() === 0, "absence: no descriptions crammed into table rows");
ok(await page.locator(`${tid("pa-table-overall")} tbody td:first-child`).count() === 6, "presence control: the six metric name cells the scan above looked inside");
ok(await page.locator(`${tid("pa-table-overall")} th[aria-sort]`).count() === 0, "Overall is not sortable (metrics are the rows)");
// THE PAGE'S OWN ASSUMPTIONS, likewise behind an "i" and likewise not printed.
ok(await page.isVisible(tid("pa-assumptions")), "presence: the assumptions \"i\" sits beside the page title");
ok(!/Excludes test players/.test(await page.textContent("main")), "absence: the assumptions are not printed on the page");

// 5. Fields: all fields with activity, not 4
await page.click(tid("pa-group-fields"));
const fieldRows = await page.locator(`${tid("pa-table-spots")} tbody tr[data-row]`).count();
const countText = await page.textContent(tid("pa-count-spots"));
ok(fieldRows > 4, `fields view shows every field with activity, not 4 (got ${fieldRows})`);
ok(num(countText) === fieldRows, `count label matches rendered rows (${countText.trim()})`);
const fieldTotals = await page.$$eval(`${tid("pa-table-spots")} tbody td[data-col="total"]`, t => t.map(x => x.textContent.trim()));
ok(new Set(fieldTotals).size > 1, "period totals differ per field (live page repeated 8,955 on every row)");
ok(await page.isDisabled(tid("pa-metric-chip-registrations")), "Registrations chip disabled in Fields, reason in its title");
// SAME REWRITE AS 4b: there is no legend, so "greyed in the legend" is asserted on the CHIP, which
// is where Fields actually says Registrations do not apply. The chip is disabled and carries the
// reason in its title, which is the thing a reader can see.
ok(/no field/i.test(await page.getAttribute(tid("pa-metric-chip-registrations"), "title") ?? ""),
  "Fields: the disabled Registrations chip says why in its title");
await page.check(tid("pa-show-inactive"));
const allRows = await page.locator(`${tid("pa-table-spots")} tbody tr[data-row]`).count();
ok(allRows > fieldRows, `show fields with no activity adds rows (${fieldRows} to ${allRows})`);
await page.uncheck(tid("pa-show-inactive"));
await page.click(tid("pa-field-city-austin"));
const cities = await page.$$eval(`${tid("pa-table-spots")} tbody .city`, t => [...new Set(t.map(x => x.textContent))]);
ok(cities.length === 1 && cities[0] === "Austin", "city filter narrows fields to Austin");
await page.click(tid("pa-field-city-all"));

// 6. Sorting is visible and works
const sortable = await page.locator(`${tid("pa-table-spots")} th.sortable`).count();
const withIcon = await page.locator(`${tid("pa-table-spots")} th.sortable .si`).count();
ok(sortable >= 8 && withIcon === sortable, `every sortable header carries a visible sort icon (${withIcon}/${sortable})`);
ok(await page.getAttribute(tid("pa-sort-spots-total"), "aria-sort") === "descending", "default sort: period total, high to low");
ok(/Sorted by\s+Period total, high to low/.test(await page.textContent(tid("pa-sortnote-spots"))), "sort state stated in words");
const colVals = async col => page.$$eval(`${tid("pa-table-spots")} tbody td[data-col="${col}"]`, t => t.map(x => Number(x.textContent.replace(/[^0-9]/g, ""))));
const isDesc = a => a.every((v, i) => i === 0 || a[i - 1] >= v), isAsc = a => a.every((v, i) => i === 0 || a[i - 1] <= v);
ok(isDesc(await colVals("total")), "rows actually ordered by total descending");
await page.click(tid("pa-sort-spots-2026-08"));
ok(await page.getAttribute(tid("pa-sort-spots-2026-08"), "aria-sort") === "descending" && isDesc(await colVals("2026-08")), "click Aug 2026: sorted high to low");
await page.click(tid("pa-sort-spots-2026-08"));
ok(await page.getAttribute(tid("pa-sort-spots-2026-08"), "aria-sort") === "ascending" && isAsc(await colVals("2026-08")), "click again: low to high");
ok(await page.getAttribute(tid("pa-sort-spots-total"), "aria-sort") === "none", "previous sort column cleared");

// 6b. Click a field or city row to see all its metrics
const scRow = `${tid("pa-table-spots")} ${tid("pa-row-soccer-central")}`;
ok(await page.getAttribute(scRow, "aria-expanded") === "false", "rows start collapsed");
ok(await page.locator(`${tid("pa-table-spots")} tr[data-detail]`).count() === 0, "absence: no detail rows before a click");
await page.click(`${scRow} .name`);
const scDetail = await page.$$eval(`${tid("pa-table-spots")} tr[data-detail]`, t => t.map(x => x.dataset.testid));
ok(scDetail.length === 5, `presence control: clicking Soccer Central opens its 5 field metrics (got ${scDetail.length})`);
ok(!scDetail.some(t => t.endsWith("-registrations")), "field detail has no Registrations row");
const prevRow = await page.$eval(`${tid("pa-detail-spots-soccer-central-newPlayers")}`, tr => tr.previousElementSibling.dataset.testid);
ok(prevRow === "pa-row-soccer-central", "detail opens directly beneath its own row");
const parentTotal = await page.$eval(`${scRow} td[data-col="total"]`, x => x.textContent.replace(/[^0-9]/g, ""));
const detailTotal = await page.$eval(`${tid("pa-detail-spots-soccer-central-spots")} td[data-dtotal]`, x => x.textContent.replace(/[^0-9]/g, ""));
ok(parentTotal === detailTotal, "detail Spots booked matches the row it expanded from");
ok(num(await page.$eval(`${tid("pa-detail-spots-soccer-central-totalPlayers")} td:nth-child(6)`, x => x.textContent)) === 525, "detail Total players Aug 2026 is the production 525");
await page.click(tid("pa-sort-spots-total"));
ok(await page.$eval(`${tid("pa-detail-spots-soccer-central-newPlayers")}`, tr => tr.previousElementSibling.dataset.testid) === "pa-row-soccer-central", "re-sorting keeps the detail under its row");
ok(isDesc(await colVals("total")), "detail rows do not disturb the sort order");
await page.click(`${scRow} .name`);
ok(await page.locator(`${tid("pa-table-spots")} tr[data-detail]`).count() === 0, "second click collapses");

// 7. Multiple metrics at once
await page.click(tid("pa-metric-chip-totalPlayers"));
ok(await page.isVisible(tid("pa-section-spots")) && await page.isVisible(tid("pa-section-totalPlayers")), "two metrics selected: two sections, each listing every field");
await page.click(tid("pa-metric-chip-totalPlayers"));
await page.click(tid("pa-metric-chip-spots"));
ok(await page.isVisible(tid("pa-section-spots")), "last selected metric cannot be deselected");

// 8. Cities
await page.click(tid("pa-group-cities"));
const cityRows = await page.locator(`${tid("pa-table-spots")} tbody tr[data-row]`).count();
ok(cityRows === 7, `cities view: 7 active cities by default (got ${cityRows})`);
ok(await page.locator(`${tid("pa-table-spots")} ${tid("pa-row-warsaw")}`).count() === 0, "absence: Warsaw not in the default city list");
await page.check(tid("pa-show-outside"));
ok(await page.locator(`${tid("pa-table-spots")} ${tid("pa-row-warsaw")}`).count() === 1, "presence control: Warsaw appears when outside cities are included");
await page.uncheck(tid("pa-show-outside"));
await page.click(`${tid("pa-table-spots")} ${tid("pa-row-austin")} .name`);
const auDetail = await page.locator(`${tid("pa-table-spots")} tr[data-detail]`).count();
ok(auDetail === 6, `clicking Austin opens all 6 city metrics, Registrations included (got ${auDetail})`);
await page.click(`${tid("pa-table-spots")} ${tid("pa-row-austin")} .name`);

// 9. Compare two cities
await page.click(tid("pa-group-compare"));
ok(await page.inputValue(tid("pa-compare-a")) === "Austin" && await page.inputValue(tid("pa-compare-b")) === "Houston", "compare defaults: Austin vs Houston");
ok(await page.locator(`${tid("pa-compare-cards")} .cc`).count() === 6, "six side-by-side metric cards");
ok(await page.locator(`${tid("pa-table-compare")} tbody tr[data-testid$="-a"]`).count() === 6 && await page.locator(`${tid("pa-table-compare")} tbody tr[data-testid$="-gap"]`).count() === 6, "table: each metric has an A row, a B row and a gap row");
ok(await page.locator(`${tid("pa-compare-b")} option[value="Austin"][disabled]`).count() === 1, "cannot compare a city with itself");
ok(await page.locator(`${tid("pa-compare-b")} option[value="Dallas"]:not([disabled])`).count() === 1, "presence control: other cities stay selectable");
await page.selectOption(tid("pa-compare-b"), "Dallas");
ok(/Austin vs .*Dallas/.test(await page.textContent(tid("pa-section-compare"))), "switching B to Dallas updates the comparison");
await page.click(tid("pa-compare-swap"));
ok(await page.inputValue(tid("pa-compare-a")) === "Dallas", "swap flips the two cities");

// 10. Grains
await page.click(tid("pa-group-overall"));
await page.click(tid("pa-grain-weekly"));
/* ── A PRESENCE WAIT BEFORE A COUNT ──────────────────────────────────────────────────────────
 * Weekly and daily re-derive their axis from the route, so the table UNMOUNTS while that request
 * is in flight. Counting straight after the click counted zero headers and reported "-3 columns",
 * which reads as a wrong axis rather than an absent one. The mock is synchronous and passes this
 * immediately. Waiting for MORE THAN THE MONTHLY 9 is what proves the new axis arrived, rather
 * than just that a table exists. */
const axisReady = async (min) => page.waitForFunction((n) => {
  const t = document.querySelector('[data-testid="pa-table-overall"]');
  return t && t.querySelectorAll("thead th").length >= n;
}, min, { timeout: 60000 });
await axisReady(12);
const wk = await page.locator(`${tid("pa-table-overall")} thead th`).count() - 3;
ok(wk >= 25 && wk <= 28, `weekly: about 26 week columns over six months (got ${wk})`);
ok(num(await page.textContent(tid("pa-total-spots"))) === spots, "weekly Spots booked period total equals the monthly one");
await page.click(tid("pa-grain-daily"));
await axisReady(12);
const dy = await page.locator(`${tid("pa-table-overall")} thead th`).count() - 3;
ok(dy === 29, `daily: one month, days to today (got ${dy})`);
ok(await page.isDisabled(tid("pa-range-from")), "daily: From is disabled, the To month drives it");
ok(await page.isVisible(tid("pa-daily-note")), "daily: says why");

ok(errors.length === 0, `no page errors (${errors.join("; ")})`);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
