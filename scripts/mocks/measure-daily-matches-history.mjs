/* Assertions for scripts/mocks/daily-matches-history.html.
 *
 * Every absence check carries a presence control in the same run, and any zero from a selector
 * written here is checked against its container existing first.
 *
 *   node scripts/mocks/measure-daily-matches-history.mjs
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CANDS = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"];
const executablePath = CANDS.find(x => x && existsSync(x));
const FILE = "file://" + join(dirname(fileURLToPath(import.meta.url)), "daily-matches-history.html");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓ " + m)) : (fail++, console.log("✗ " + m)); };
const D = t => `[data-testid="${t}"]`;

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const p = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const load = async () => { await p.goto(FILE); await p.waitForTimeout(150); };
const months = () => p.$$eval(D("mh"), es => es.map(e => e.dataset.m));
await load();

// ══ 1. HISTORY IS OPTIONAL AND OFF BY DEFAULT ═════════════════════════════════════════════════
// The table's job is the climb to December. Four extra columns on by default push the live month
// and the goal apart, and those two are what people actually read.
ok(await p.$eval(D("histtog"), e => e.getAttribute("aria-pressed")) === "false",
  "history is off when the page opens");
const closed = await months();
ok(closed.join() === "sep,oct,nov,dec", `four columns to begin with (${closed.join(", ")})`);
ok(await p.$$eval(D("row"), es => es.length) === 9,
  "  CONTROL: while nine city rows are rendered, so the short header is not an empty table");
ok(await p.$$eval(D("trendhead"), es => es.length) === 0, "  and no trend column yet");

await p.click(D("histtog")); await p.waitForTimeout(150);
const opened = await months();
ok(opened.join() === "jun,jul,aug,sep,oct,nov,dec", `history adds three months to the left (${opened.join(", ")})`);
ok(await p.$$eval(D("trendhead"), es => es.length) === 1, "  and the trend column appears with them");
ok(await p.$$eval(D("row"), es => es.length) === 9, "  CONTROL: the same nine cities, not a different set");

// ══ 2. ACTUAL AND GOAL ARE NOT THE SAME KIND OF NUMBER ════════════════════════════════════════
// The chart above this table already teaches solid-versus-outlined. This is that distinction in a
// row: a hairline at the boundary and a caption band over each side.
const caps = await p.$$eval(".capband td", es => es.map(e => e.textContent.trim()).filter(Boolean));
ok(caps.join() === "Actual,Goal", `the two sides are captioned (${caps.join(" / ")})`);
ok(await p.$$eval("th.boundary", es => es.length) === 1, "  with exactly one rule between them");
ok(await p.$eval("th.boundary", e => e.dataset.m) === "oct",
  "  CONTROL: and it falls after the live month, not at an arbitrary column");
// PAST MONTHS ARE INK, FUTURE MONTHS ARE GREY. Computed, not by class name.
const inks = await p.evaluate(() => {
  const g = m => getComputedStyle(document.querySelector(`[data-testid="cell"][data-m="${m}"]`)).color;
  return { jun: g("jun"), sep: g("sep"), nov: g("nov"), dec: g("dec") }; });
ok(inks.jun !== inks.nov, `an actual and a target are different ink (${inks.jun} vs ${inks.nov})`);
ok(inks.sep === inks.dec, "  CONTROL: while the live month and the goal share the emphasis they already had");
ok(inks.jun !== inks.sep, "  and history sits one step back from the live month, which stays the anchor");

// ══ 3. THE LIVE MONTH IS MARKED ═══════════════════════════════════════════════════════════════
ok(await p.$$eval(D("inprog"), es => es.length) === 1, "the live month is marked exactly once");
ok(await p.evaluate(() => document.querySelector('[data-testid="inprog"]').closest("th").dataset.m === "sep"),
  "  CONTROL: on September, not on another column");

// ══ 4. A NEW MARKET IS NOT A CITY AT ZERO ═════════════════════════════════════════════════════
// This is the one that would otherwise ship wrong. San Diego and Philadelphia had no goal in June.
// Rendering 0.0 there reads as a city that collapsed rather than one that did not exist.
const sd = await p.evaluate(() => {
  const r = [...document.querySelectorAll('[data-testid="row"]')].find(e => e.dataset.city === "San Diego");
  return [...r.querySelectorAll('[data-testid="cell"]')].slice(0, 3).map(e => e.textContent.trim()); });
ok(sd.every(t => t === "—"), `a market with no history dashes rather than reading 0.0 (${sd.join(" ")})`);
ok(await p.$$eval(`${D("cell")}[data-none="1"]`, es => es.length === 6),
  "  CONTROL: six such cells across the two new markets, not a blanket dash");
ok(await p.evaluate(() => {
  const r = [...document.querySelectorAll('[data-testid="row"]')].find(e => e.dataset.city === "Austin");
  return [...r.querySelectorAll('[data-testid="cell"]')].slice(0, 3).every(e => /\d/.test(e.textContent)); }),
  "  CONTROL: while a city with history carries real figures, so the dash reads as specific");
ok(await p.$$eval(D("newnote"), es => es.length === 2),
  "  and each is labelled new rather than left to be guessed at");

// ══ 5. TREND IS WHY HISTORY EARNS ITS COLUMNS ═════════════════════════════════════════════════
// A gap alone does not say whether it is closing. +3.7 having climbed and +3.7 having sat flat are
// opposite decisions, and the table cannot tell them apart without this.
const trends = await p.$$eval(D("trend"), es => es.map(e => e.dataset.t ?? "none"));
ok(trends.includes("up") && trends.includes("dn") && trends.includes("flat"),
  `all three directions render (${trends.join(", ")})`);
ok(await p.evaluate(() => {
  const r = [...document.querySelectorAll('[data-testid="row"]')].find(e => e.dataset.city === "Austin");
  return r.querySelector('[data-testid="trend"]').textContent.includes("+2.1"); }),
  "  Austin reads +2.1, its June-to-now climb, not its gap");
ok(await p.evaluate(() => {
  const up = [...document.querySelectorAll('[data-testid="trend"]')].find(e => e.dataset.t === "up");
  const dn = [...document.querySelectorAll('[data-testid="trend"]')].find(e => e.dataset.t === "dn");
  // BOTH MUST EXIST FOR THIS TO MEAN ANYTHING. Comparing a colour against a missing element throws
  // rather than failing, which is a worse outcome than a red line.
  if (!up || !dn) return false;
  return getComputedStyle(up).color !== getComputedStyle(dn).color; }),
  "  CONTROL: climbing and falling are different colours, computed rather than assumed");
// AND IT NEVER RENDERS FOR A CITY THAT HAS NO HISTORY TO TREND.
ok(await p.$$eval(`${D("trend")}[data-none="1"]`, es => es.length === 2),
  "  a new market shows no trend rather than a fabricated one");

// ══ 6. NOTHING ELSE MOVES WHEN HISTORY OPENS ══════════════════════════════════════════════════
// The gap and the fields column are the page's existing answer and must read identically either
// way, or the toggle is changing more than it claims to.
const gapsOn = await p.$$eval(".gap", es => es.map(e => e.textContent.trim()));
await p.click(D("histtog")); await p.waitForTimeout(150);
const gapsOff = await p.$$eval(".gap", es => es.map(e => e.textContent.trim()));
ok(gapsOn.join() === gapsOff.join(), `the gap column is identical with history on and off (${gapsOff.slice(0,3).join(" ")})`);
ok(gapsOff.length > 0, "  CONTROL: and there are gaps to compare, so the equality is not of two empties");

// ══ 7. EXPANSION STILL WORKS, AND CARRIES THE SAME COLUMNS ════════════════════════════════════
await p.click(D("histtog")); await p.waitForTimeout(150);
ok(await p.$$eval(D("child"), es => es.length) === 0, "nothing is expanded to begin with");
await p.evaluate(() => [...document.querySelectorAll('[data-testid="row"]')]
  .find(e => e.dataset.city === "Houston").click());
await p.waitForTimeout(150);
const kids = await p.$$eval(D("child"), es => es.length);
ok(kids === 6, `opening Houston shows its six fields (${kids})`);
ok(await p.evaluate(() => {
  const c = document.querySelector('[data-testid="child"]');
  return c.querySelectorAll('[data-testid="cell"]').length === 7; }),
  "  and a field row carries the same seven months as its city");
ok(await p.$$eval(`${D("child")} ${D("cell")}[data-none="1"]`, es => es.length > 0),
  "  CONTROL: a field with no history dashes too, the same rule one level down");

// ══ 8. GEOMETRY ═══════════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1440]) {
  await p.setViewportSize({ width: vw, height: 1000 });
  await load();
  await p.click(D("histtog")); await p.waitForTimeout(150);
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${vw}px: no page-level horizontal scroll with history open`);
  ok(await p.evaluate(() => { const s = document.querySelector(".scroll");
    return s.scrollWidth > s.clientWidth ? getComputedStyle(s).overflowX === "auto" : true; }),
    `  ${vw}px: the table scrolls in its own container, never the page`);
  ok(await p.$$eval(`${D("grain")} button, ${D("sortseg")} button, ${D("histtog")}`,
    es => es.every(e => e.getBoundingClientRect().height >= 32)),
    `  ${vw}px: every control clears 32px`);
  ok(await p.$eval(`${D("row")} td:first-child`, e => getComputedStyle(e).position) === "sticky",
    `  ${vw}px: the city name stays put while the months scroll`);
}

// ══ 9. LIGHT, NOT DARK ════════════════════════════════════════════════════════════════════════
await p.setViewportSize({ width: 1440, height: 1000 });
await p.emulateMedia({ colorScheme: "dark" });
await load();
const bg = await p.$eval("body", e => getComputedStyle(e).backgroundColor);
ok(bg === "rgb(244, 247, 245)", `with the OS set to dark the page is still light (${bg})`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
