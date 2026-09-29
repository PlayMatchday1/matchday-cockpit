/* Assertions for scripts/mocks/behavior-tables.html.
 *
 * Every absence check carries a presence control in the same run, and any zero from a selector
 * written here is checked against its container existing first. Both rules were earned this week:
 * a parse error that produced zero assertions, a piped tsc that had OOM'd, a queue that opened on
 * an empty Saturday, a selector invented for a component with no testids, and a reload that reset
 * the table under assertions still measuring the old mode.
 *
 *   node scripts/mocks/measure-behavior-tables.mjs
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CANDS = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"];
const executablePath = CANDS.find(x => x && existsSync(x));
const FILE = "file://" + join(dirname(fileURLToPath(import.meta.url)), "behavior-tables.html");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓ " + m)) : (fail++, console.log("✗ " + m)); };
const D = t => `[data-testid="${t}"]`;

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const load = async () => { await p.goto(FILE); await p.waitForTimeout(150); };
const seg = (id, v) => p.click(`${D(id)} button[data-${id === "grain" ? "g" : "s"}="${v}"]`);
const rowNames = () => p.$$eval(D("row"), es => es.map(e => e.dataset.name));
const heads = () => p.$$eval(D("th"), es => es.map(e => e.textContent.trim()));
await load();

// ══ 1. THE SHAPE THE PAGE ALREADY HAD IS KEPT ═════════════════════════════════════════════════
// Metrics down the side, time across the top, a selected-period total and one MoM pill. An earlier
// pass of this mock transposed it — periods down, metrics across — and threw away a layout that
// worked. Rows are the small fixed set; columns are the thing that extends.
const names = await rowNames();
ok(names.join() === "Registrations,New players,Total players,Spots booked,Returning players,Returning player %",
  `the six metrics are the rows, in order (${names.join(", ")})`);
const hs = await heads();
ok(hs[0] === "Metric", `  and the first column is the metric name (${hs[0]})`);
ok(hs.some(h => /Period total/.test(h)), "  the period total survives");
ok(hs.some(h => /Change vs\. last month/.test(h)), "  and so does the change column, naming the unit it compares");
ok(await p.$$eval(D("periodtotal"), es => es.length) === 6,
  "  CONTROL: every metric row carries its own period total");

ok(!(await p.$eval(".pnote", e => e.textContent)).match(/oldest to newest|\d+ (months|weeks|days)/),
  "  and no row-count line, which read \"4 weeks\" beside a monthly table");
ok(await p.$eval("#ptitle", e => e.textContent) === "Player Metrics",
  "  CONTROL: while the panel is titled and rendered, so the empty note is not an empty panel");

// ══ 2. NO CHART BY DEFAULT, STILL REACHABLE ═══════════════════════════════════════════════════
ok(await p.$eval(D("chartbox"), e => e.hidden) === true, "the chart is not the default view");
ok((await rowNames()).length > 0,
  "  CONTROL: while the table is populated, so the hidden chart is not an empty page");
await p.click(D("charttog")); await p.waitForTimeout(120);
ok(await p.$eval(D("chartbox"), e => e.hidden) === false, "  it opens on demand rather than being deleted");
const hint = await p.$eval(D("charthint"), e => e.textContent);
ok(/6,573|9,716/.test(hint) && /585|1,123/.test(hint),
  "  and says why, with the real figures that make one shared axis impossible");
await p.click(D("charttog")); await p.waitForTimeout(120);
ok(await p.$eval(D("chartbox"), e => e.hidden) === true, "  CONTROL: and it closes again");

// ══ 3. SEPTEMBER IS A COLUMN, AND MARKED ONCE ═════════════════════════════════════════════════
// defaultPeriod filters to `m < nowMonth` — completed months only — so September's absence was
// deliberate. Including it is only safe alongside the same-days toggle; the two are one change.
ok((await heads()).some(h => /Sep 2026/.test(h)), "September is in the default columns");
ok(await p.$$eval(`${D("th")}.live`, es => es.length) === 1,
  "  the live column is marked exactly once");
ok(await p.$eval(`${D("th")}.live`, e => /Sep 2026/.test(e.textContent)),
  "  CONTROL: and the mark is on September, not on some other column");
ok(await p.$eval(`${D("th")}.live`, e => /in progress/.test(e.textContent)),
  "  marked on the header rather than on six separate cells");

// ══ 4. GRAIN CHANGES THE COLUMNS, NOT THE ROWS ════════════════════════════════════════════════
// Daily is cheap: behavior-weekly/route.ts already re-derives from row-level mirrors, so the day
// key is what weekKey's helpers already return. Daily is that query without the bucketing.
const monthCols = (await heads()).length;
await seg("grain", "weekly"); await p.waitForTimeout(160);
const weekCols = (await heads()).length;
ok(weekCols > monthCols, `weekly widens the table rather than lengthening it (${monthCols} then ${weekCols})`);
ok((await rowNames()).length === 6, "  CONTROL: and the six metric rows are untouched");
// SIX MONTHS OF DAYS IS 180 COLUMNS, WHICH IS NOT A TABLE. Daily narrows the range to one month
// and leaves the picker there to widen it deliberately.
await seg("grain", "daily"); await p.waitForTimeout(200);
const dayCols = (await heads()).length;
ok(dayCols > 25 && dayCols < 40, `daily narrows to one month rather than 180 columns (${dayCols})`);
ok(await p.$eval(D("start"), e => e.value) === await p.$eval(D("end"), e => e.value),
  "  CONTROL: by collapsing the range, visibly, in the pickers the operator can reopen");
ok((await rowNames()).length === 6, "  CONTROL: rows still the six metrics");
await load();

// ══ 5. THE ROW DIMENSION SWAPS TO CITIES, AND THE METRIC PICKER APPEARS WITH IT ═══════════════
// In All MatchDay the metrics ARE the rows, so a metric picker there would hide rows of the thing
// you came to read. It only has a job once the rows are entities.
ok(await p.$eval(D("metrics"), e => e.hidden) === true, "no metric picker while the metrics are the rows");
await seg("scope", "city"); await p.waitForTimeout(160);
ok(await p.$eval(D("metrics"), e => e.hidden) === false, "  CONTROL: and it appears when the rows become cities");
const cities = await rowNames();
ok(cities.length === 7, `seven play markets (${cities.length})`);
ok(!cities.includes("Registrations"), "  CONTROL: the metric rows gave way rather than doubling up");
ok((await heads()).some(h => /Sep 2026/.test(h)), "  and time is still the columns");

// ══ 6. SORTING, WHICH THE PAGE HAS NEVER HAD ══════════════════════════════════════════════════
const colVals = async () => p.$$eval(`${D("row")} ${D("periodtotal")}`,
  es => es.map(e => +e.textContent.replace(/[,%]/g, "")));
await p.click(`${D("th")}[data-k="total"]`); await p.waitForTimeout(160);
const desc = await colVals();
ok(desc.every((v, i) => i === 0 || desc[i - 1] >= v), `sorting by the period total descends (${desc.join(" ")})`);
await p.click(`${D("th")}[data-k="total"]`); await p.waitForTimeout(160);
const asc = await colVals();
ok(asc.every((v, i) => i === 0 || asc[i - 1] <= v), `  and clicking again ascends (${asc.join(" ")})`);
ok(asc.length === desc.length, "  CONTROL: sorting reorders rows without losing or inventing any");
ok(await p.$$eval(D("th"), es => es.some(e => e.getAttribute("aria-sort") === "ascending")),
  "  CONTROL: with aria-sort on the header, so it is announced and not only coloured");
// ANY PERIOD COLUMN SORTS TOO, which is what "compare all the fields on total spots" needs.
const firstCol = (await p.$$eval(D("th"), es => es.map(e => e.dataset.k)))[1];
await p.click(`${D("th")}[data-k="${firstCol}"]`); await p.waitForTimeout(160);
ok(await p.$eval(`${D("th")}[data-k="${firstCol}"]`, e => e.getAttribute("aria-sort") !== "none"),
  "  a single period column sorts as well as the total");
// AND SORTING IS OFF WHERE IT WOULD BE MEANINGLESS: ordering six metrics by size says nothing.
await seg("scope", "overall"); await p.waitForTimeout(160);
ok(await p.$$eval(`${D("th")}.sortable`, es => es.length) === 0,
  "  CONTROL: sorting is absent in All MatchDay, where ranking metrics by size means nothing");

// ══ 7. CLICKING A CITY OPENS ALL SIX METRICS FOR IT ═══════════════════════════════════════════
// Ryan: "for city and field detail, display all metrics simultaneously — clicking a city should
// reveal a dropdown of the metrics." With entities as rows and time as columns the metric is the
// third dimension, and this is where it fits without a second table.
await seg("scope", "city"); await p.waitForTimeout(160);
ok(await p.$$eval(D("child"), es => es.length) === 0, "nothing is expanded to begin with");
await p.click(`${D("row")}`); await p.waitForTimeout(160);
ok(await p.$$eval(D("child"), es => es.length) === 6, "  clicking a city opens all six of its metrics");
ok(await p.$$eval(`${D("row")}[data-open="1"]`, es => es.length) === 1,
  "  CONTROL: exactly one row open at a time");
await p.click(`${D("row")}`); await p.waitForTimeout(160);
ok(await p.$$eval(D("child"), es => es.length) === 0, "  CONTROL: and clicking it again closes it");

// ══ 8. THE CHANGE COLUMN IS ALWAYS POPULATED, AND ALWAYS ON A MATCHED WINDOW ═════════════════
// There is no toggle. An earlier pass had one and it was doing two jobs stitched together:
// truncating the visible cells AND unlocking this pill. Split, neither needs a mode — and a mode
// that can sit in the wrong position is one someone will misread.
await load();
ok(await p.$$eval('[data-testid="mtd"]', es => es.length) === 0, "no compare toggle exists");
ok(await p.$$eval(D("delta"), es => es.length) === 6,
  "  CONTROL: and every metric row carries a change pill anyway, with September live");
ok(await p.$$eval(D("delta"), es => es.every(e => /%|pts/.test(e.textContent))),
  "  each one a real figure, not a dash");

// THE CELLS STAY TRUE. August really did book 8,870 spots; a truncated August is a number that
// exists only to serve a comparison and has no business in the column.
const cellAt = (row, col) => p.evaluate(([r, c]) => {
  const tr = [...document.querySelectorAll('[data-testid="row"]')].find(e => e.dataset.name === r);
  return +tr.querySelector(`[data-testid="cell"][data-c="${c}"]`).textContent.replace(/,/g, ""); },
  [row, col]);
ok(await cellAt("Spots booked", "2026-08") === 8870,
  "the columns show the true full-month figure, not a truncated one");
ok(await cellAt("Spots booked", "2026-09") === 8243, "  CONTROL: including the live month's own total");

// AND THE PILL SAYS WHICH TWO WINDOWS IT USED, so it can never silently disagree with the cells
// beside it. This is the whole reason the toggle could be removed rather than merely hidden.
const momHead = (await heads()).find(h => /Change vs\./.test(h));
ok(/first 27 days/.test(momHead), `the change header names the matched window (${momHead})`);
ok(/weekends/.test(momHead), "  and the weekend count of each, which is the mismatch that moves spots");
ok(/Aug 5/.test(momHead) && /Sep 4/.test(momHead),
  "  CONTROL: and the two counts differ, which is the whole point of printing them");

// WITH NO LIVE COLUMN THERE IS NOTHING TO MATCH, so it names the plain months instead.
await p.selectOption(D("end"), "2026-08"); await p.waitForTimeout(160);
const closedHead = (await heads()).find(h => /Change vs\./.test(h));
ok(!/first 27 days/.test(closedHead) && /Jul 2026/.test(closedHead),
  `  and reverts to whole periods when none is part-elapsed (${closedHead})`);
ok(await p.$$eval(D("delta"), es => es.length) === 6, "  CONTROL: still populated either way");
await load();

// ══ 11. GEOMETRY ══════════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1440]) {
  await p.setViewportSize({ width: vw, height: 1000 });
  await load();
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${vw}px: no page-level horizontal scroll`);
  ok(await p.evaluate(() => { const s = document.querySelector(".scroll");
    return s.scrollWidth > s.clientWidth ? getComputedStyle(s).overflowX === "auto" : true; }),
    `  ${vw}px: the table scrolls in its own container, never the page`);
  ok(await p.$$eval(`${D("grain")} button, ${D("scope")} button, ${D("mtd")}`,
    es => es.every(e => e.getBoundingClientRect().height >= 32)),
    `  ${vw}px: every control clears 32px`);
  // THE ROW NAME STAYS PUT WHILE THE PERIODS SCROLL. A metric name that scrolls off leaves a row
  // of numbers belonging to nothing, which is the failure a wide table actually has.
  ok(await p.$eval(`${D("row")} td:first-child`, e => getComputedStyle(e).position) === "sticky",
    `  ${vw}px: the row name column is pinned while the periods scroll`);
}

// ══ 12. LIGHT, NOT DARK ═══════════════════════════════════════════════════════════════════════
await p.setViewportSize({ width: 1440, height: 1000 });
await p.emulateMedia({ colorScheme: "dark" });
await load();
const bg = await p.$eval("body", e => getComputedStyle(e).backgroundColor);
ok(bg === "rgb(244, 247, 245)", `with the OS set to dark the page is still light (${bg})`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
