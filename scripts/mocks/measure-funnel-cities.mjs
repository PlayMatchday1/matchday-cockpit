/* Assertions for scripts/mocks/funnel-cities.html.
 *
 * Every absence check carries a presence control in the same run. Three failures in the promo work
 * this week read as satisfied zeros: a parse error that produced zero assertions, and twice a query
 * that matched nothing because the panel had opened on an empty day. A zero and a clean pass exit
 * through the same door unless something asserts the thing was there to begin with.
 *
 *   node scripts/mocks/measure-funnel-cities.mjs
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const FILE = "file://" + join(dirname(fileURLToPath(import.meta.url)), "funnel-cities.html");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓ " + m)) : (fail++, console.log("✗ " + m)); };
const D = t => `[data-testid="${t}"]`;

const CANDS = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"];
const executablePath = CANDS.find(x => x && existsSync(x));
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const p = await browser.newPage({ viewport: { width: 1320, height: 1000 } });
const load = async () => { await p.goto(FILE); await p.waitForTimeout(160); };
await load();

// ══ 1. THE PERIOD BUBBLES ARE GONE, AND THE CARDS DID NOT LOSE THEIR RANGE ════════════════════
// Ryan: "we dont need time periods at top because already a custom range for last row." Deleting
// PeriodBar alone would orphan KpiRow, which filters everything on period.start/period.end
// (KpiRow.tsx:19, 29, 66, 80). So the range moves up and drives both panels.
const bodyTxt = await p.$eval("body", e => e.textContent);
for (const b of ["Last 3 months", "Last 6 months", "Last 12 months", "YTD "])
  ok(!bodyTxt.includes(b), `no "${b.trim()}" bubble on the page`);
ok(await p.$$eval(D("range"), es => es.length) === 1, "  CONTROL: but exactly one range control exists");
ok(await p.$$eval(D("kpi"), es => es.length) === 4, "  CONTROL: and the four KPI cards are still there");

// THE CARDS FOLLOW THE RANGE. This is the assertion the whole change turns on: if the cards did not
// re-read it, removing the bubbles would leave them frozen on a default nobody chose.
const kpiBefore = await p.$$eval(D("kpi"), es => es.map(e => e.textContent));
await p.selectOption(D("end"), "2026-07");
await p.waitForTimeout(160);
const kpiAfter = await p.$$eval(D("kpi"), es => es.map(e => e.textContent));
ok(kpiBefore.join() !== kpiAfter.join(), "the KPI cards re-read the range when it changes");
ok(kpiAfter.some(t => /Jul 2026/i.test(t)), "  and name the new end month on the cards themselves");
await load();

// ══ 2. THE CURRENT MONTH IS SEPTEMBER, NOT OCTOBER ════════════════════════════════════════════
// The cause is not an off-by-one. behaviorAxis ends at max(nowMonth, last(playMonths)) and
// playMonths comes from match rows that include matches not yet played, so a booked October fixture
// raises the ceiling and PlayerFunnel calls months[last] "current".
const rowNames = await p.$$eval(D("row"), es => es.map(e => e.dataset.name));
const metas = await p.$$eval(D("row"), es => es.map(e => e.querySelector(".rowmeta").textContent));
const curIdx = metas.indexOf("current month");
ok(curIdx >= 0 && rowNames[curIdx] === "Sep 2026",
  `the current-month row is September (${rowNames[curIdx]})`);
ok(!rowNames.includes("Oct 2026"), "  CONTROL: and October appears nowhere in the table");
// THE ROW BENEATH IT MOVED TOO, which is the tell that the clamp is real rather than a relabel.
// Relabelling October to September would leave the previous-month row on September.
ok(rowNames[metas.indexOf("previous month")] === "Aug 2026",
  `  CONTROL: previous month moved to August with it (${rowNames[metas.indexOf("previous month")]})`);
// AND THE RANGE PICKERS CANNOT REACH A FUTURE MONTH EITHER. Same clamp, same reason.
const opts = await p.$$eval(`${D("end")} option`, es => es.map(e => e.value));
ok(opts[opts.length - 1] === "2026-09", `the range cannot be set past today (last option ${opts[opts.length - 1]})`);
ok(opts.includes("2026-09"), "  CONTROL: while the current month is itself selectable");

// THE CURRENT MONTH IS STILL MARKED AS OPEN. Clamping it is not the same as pretending it closed.
ok(await p.$$eval(`${D("row")}[data-partial="1"]`, es => es.length) === 1,
  "the current month is still marked part-elapsed");

// ══ 3. PICKING CITIES ═════════════════════════════════════════════════════════════════════════
ok(await p.$$eval(D("chip"), es => es.length) === 8, "eight chips: all cities plus the seven");
ok(await p.$$eval(D("chip"), es => es.every(e => e.getBoundingClientRect().height >= 32)),
  "  CONTROL: every chip clears 32px, rather than being shrunk to fit the row");
ok(await p.$eval(`${D("chip")}[data-all="1"]`, e => e.dataset.on) === "1",
  "  it opens on all cities");

// ONE CITY KEEPS THE TIME ROWS. Filtering to a city is not the same question as comparing cities,
// and answering the second one when you were asked the first loses the months.
await p.click(`${D("chip")}[data-city="Austin"]`);
await p.waitForTimeout(160);
const oneCity = await p.$$eval(D("row"), es => es.map(e => e.querySelector(".rowmeta").textContent));
ok(oneCity.includes("current month"), "one city still shows the time rows");
ok((await p.$eval(D("picknote"), e => e.textContent)).includes("Austin"),
  "  and the note names the city");

// TWO OR MORE SWITCHES THE ROW DIMENSION TO CITIES. No separate mode control: the picker decides,
// so there is no second switch to leave in the wrong position.
await p.click(`${D("chip")}[data-city="Atlanta"]`);
await p.waitForTimeout(160);
const two = await p.$$eval(D("row"), es => es.map(e => e.dataset.name));
ok(two.includes("Austin") && two.includes("Atlanta"),
  `two cities become two rows (${two.join(", ")})`);
ok(!two.includes("Sep 2026"), "  CONTROL: and the time rows give way rather than doubling up");

// THE TOTAL ROW IS THE ARITHMETIC CONTROL. City rows that do not sum to their own total are the
// failure this table would otherwise hide, because every row looks plausible on its own.
const nums = await p.evaluate(() => {
  const read = name => { const r = [...document.querySelectorAll('[data-testid="row"]')]
      .find(e => e.dataset.name === name);
    return [...r.querySelectorAll('[data-testid="cell"]')].map(c => {
      const n = c.querySelector(".num"); return n ? +n.textContent.replace(/,/g, "") : null; }); };
  return { atx: read("Austin"), atl: read("Atlanta"),
           total: read([...document.querySelectorAll('[data-testid="row"]')]
             .find(e => e.dataset.total === "1").dataset.name) }; });
ok(nums.total.every((v, i) => v === null ? nums.atx[i] === null
    : v === nums.atx[i] + nums.atl[i]),
  `the total row equals the cities above it (${nums.total.join("/")} = ${nums.atx.join("/")} + ${nums.atl.join("/")})`);

// ALL SEVEN MUST SUM TO THE REAL NATIONAL FIGURES. The per-city split is illustrative; the totals
// are read off the live page, so the split is built to reconcile. If it ever stops reconciling, the
// mock has quietly become fiction rather than an illustration.
for (const c of ["Houston", "San Antonio", "Dallas", "St. Louis", "Oklahoma City"])
  await p.click(`${D("chip")}[data-city="${c}"]`);
await p.waitForTimeout(200);
const allSel = await p.evaluate(() => { const r = [...document.querySelectorAll('[data-testid="row"]')]
    .find(e => e.dataset.total === "1");
  return [...r.querySelectorAll('[data-testid="cell"]')].map(c => {
    const n = c.querySelector(".num"); return n ? +n.textContent.replace(/,/g, "") : null; }); });
ok(allSel.join() === [null, 9468, 4734, 1625, 1014, 463].join(),
  `all seven cities sum to the real national figures (${allSel.join(", ")})`);
ok(await p.$eval(`${D("row")}[data-total="1"]`, e => e.dataset.name) === "All cities",
  "  and the total row says so when every city is picked");

// ══ 4. DOWNLOADS HAVE NO CITY, AND THE PAGE SAYS SO ═══════════════════════════════════════════
// funnelByMonthCity carries registrations and played1/3/5/10 only (PlayerFunnel.tsx:37). Store
// installs arrive with no city dimension, so a per-city funnel cannot start at downloads. A dash
// with a reason is the honest rendering; a number here would be invented.
ok(await p.$$eval(D("whydash"), es => es.length > 0),
  "per-city rows dash the downloads column and say why");
ok(await p.$$eval(`${D("cell")}[data-stage="downloads"]`, es => es.every(e => !e.querySelector(".num"))),
  "  CONTROL: no per-city download number is invented anywhere in the column");
ok(await p.$$eval(`${D("cell")}[data-stage="registrations"]`, es => es.every(e => !!e.querySelector(".num"))),
  "  CONTROL: while every city does carry a registrations figure, so the dash is specific");

// THE CONVERSION CHAIN RUNS PER ROW, which is the entire point of comparing cities.
const convs = await p.evaluate(() => { const r = [...document.querySelectorAll('[data-testid="row"]')]
    .find(e => e.dataset.name === "Austin");
  return [...r.querySelectorAll('[data-testid="conv"]')].map(e => e.textContent.trim()); });
ok(convs.length === 5, `each city row carries its own five conversions (${convs.join(" ")})`);
ok(convs[0] === "–", "  the first is a dash, because there is no per-city download to convert from");
ok(convs.slice(1).every(c => /^\d+\.\d%$/.test(c)),
  `  CONTROL: while the other four are real percentages (${convs.slice(1).join(" ")})`);

// ══ 5. LABELLED WHERE IT IS ILLUSTRATIVE ══════════════════════════════════════════════════════
ok((await p.$eval(".foot", e => e.textContent)).includes("illustrative"),
  "the per-city split is labelled illustrative on the page");
await load();
ok((await p.$eval(".foot", e => e.textContent)).includes("illustrative"),
  "  and so is the one invented time row, rather than only the city split");

// ══ 6. GEOMETRY ═══════════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1320]) {
  await p.setViewportSize({ width: vw, height: 1000 });
  await load();
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${vw}px: no page-level horizontal scroll`);
  ok(await p.$$eval(D("chip"), es => es.every(e => e.getBoundingClientRect().height >= 32)),
    `  ${vw}px: every chip still clears 32px`);
  ok(await p.$$eval(D("chip"), es => es.every(e => e.getBoundingClientRect().width <= window.innerWidth)),
    `  ${vw}px: no chip is wider than the screen`);
  ok(await p.evaluate(() => { const s = document.querySelector(".scroll");
    return s.scrollWidth > s.clientWidth ? getComputedStyle(s).overflowX === "auto" : true; }),
    `  ${vw}px: the table scrolls in its own container, never the page`);
}

// ══ 7. LIGHT, NOT DARK ════════════════════════════════════════════════════════════════════════
// An earlier mock in this repo honoured prefers-color-scheme and rendered dark on a machine set to
// dark, which this app does nowhere.
await p.setViewportSize({ width: 1320, height: 1000 });
await p.emulateMedia({ colorScheme: "dark" });
await load();
const bg = await p.$eval("body", e => getComputedStyle(e).backgroundColor);
ok(bg === "rgb(244, 247, 245)", `with the OS set to dark the page is still light (${bg})`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
