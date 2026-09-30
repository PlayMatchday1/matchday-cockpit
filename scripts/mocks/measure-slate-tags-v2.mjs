/* Assertions for scripts/mocks/slate-tags-v2.html.
 *
 * Every absence check carries a presence control in the same run. The whole point of this mock is
 * that two tiles which look identical today must stop looking identical, so the controls matter
 * more than usual: an assertion that two things differ is worthless if either one is missing.
 *
 *   node scripts/mocks/measure-slate-tags-v2.mjs
 */
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CANDS = [process.env.PW_CHROMIUM, "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"];
const executablePath = CANDS.find(x => x && existsSync(x));
const FILE = "file://" + join(dirname(fileURLToPath(import.meta.url)), "slate-tags-v2.html");
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("✓ " + m)) : (fail++, console.log("✗ " + m)); };
const D = t => `[data-testid="${t}"]`;

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const p = await browser.newPage({ viewport: { width: 1180, height: 1100 } });
const load = async () => { await p.goto(FILE); await p.waitForTimeout(140); };
const tile = (d, v) => `${D("tile")}[data-day="${d}"][data-venue="${v}"]`;
await load();

// ══ 1. "NEW DAY" IS GONE, AND SOMETHING TOOK ITS PLACE ════════════════════════════════════════
const body = await p.$eval("body", e => e.textContent);
// THE PHRASE IS ALLOWED IN THE EXPLANATION AND NOWHERE ELSE. Asserting the string is absent from
// the whole page would fail on the sentence that tells people it was retired, which is the one
// place it belongs. What must be gone is the BADGE.
ok(await p.$$eval(D("newb"), es => es.every(e => !/NEW DAY/i.test(e.textContent))),
  "no tile badge reads NEW DAY");
ok(await p.$$eval(D("tile"), es => es.length) === 9,
  `  CONTROL: nine tiles rendered, so the absence is not an empty page (${await p.$$eval(D("tile"), es => es.length)})`);
ok(await p.$$eval(`${D("keynew")} .newb`, es => es.every(e => !/NEW DAY/i.test(e.textContent))),
  "  and the key does not offer it as a tag either");
ok(await p.$$eval(D("keynew"), es => es.length) === 4,
  "  CONTROL: four tags are offered, so the absence is not an empty key");
ok(/NEW MATCH/.test(body), "  and NEW MATCH is on screen in its place");

// ══ 2. FOUR TAGS, ONE PER TILE, MUTUALLY EXCLUSIVE ════════════════════════════════════════════
const flags = await p.$$eval(D("newb"), es => es.map(e => e.dataset.f));
ok(new Set(flags).size === 4 && ["field","match","time","back"].every(k => flags.includes(k)),
  `all four change tags render (${flags.join(", ")})`);
ok(await p.$$eval(D("tile"), es => es.every(e => e.querySelectorAll('[data-testid="newb"]').length <= 1)),
  "  no tile carries two of them, because the precedence picks one");
ok(await p.$$eval(`${D("tile")}[data-change=""]`, es => es.length === 4),
  "  CONTROL: and four tiles carry none, so the tag is not on everything");

// ══ 3. NEW MATCH COVERS BOTH CASES, WHICH IS THE WHOLE PROPOSAL ═══════════════════════════════
// A new weekday at a known field, AND a time added beside one that is still running. The old set
// called the first NEW DAY and the second NEW TIME, which is why NEW TIME meant two things.
ok(await p.$eval(tile("wed", "Keswick Park (Chamblee)"), e => e.dataset.change) === "match",
  "a new weekday at an existing field is NEW MATCH");
ok(await p.$eval(tile("tue", "Westlake"), e => e.dataset.change) === "",
  "  CONTROL: Westlake's existing 6:00 PM is untagged, so the field is not new");
const added = await p.$$eval(`${D("tile")}[data-venue="Westlake"]`, es => es.map(e => e.dataset.change));
ok(added.includes("match"),
  `  and the 7:00 PM added beside it is NEW MATCH too, not NEW TIME (${added.filter(Boolean).join(", ")})`);

// ══ 4. NEW TIME IS NOW ONLY A MOVE ════════════════════════════════════════════════════════════
const tiles = await p.$$eval(`${D("tile")}[data-change="time"]`, es => es.map(e => e.dataset.venue));
ok(tiles.length === 1 && tiles[0] === "PRUMC", `NEW TIME fires on exactly the moved slot (${tiles.join(", ")})`);
ok((await p.$eval(tile("mon", "PRUMC"), e => e.title)).includes("6:00 is gone"),
  "  and the tooltip names the time it left, which is what makes it a move rather than an addition");

// ══ 5. RETURNING SLATE IS NOT A KIND OF NEW ═══════════════════════════════════════════════════
ok(await p.$eval(tile("wed", "Stony Point"), e => e.dataset.change) === "back",
  "a slot that ran here before and missed its last outing reads RETURNING SLATE");
// THE POINT OF THE TAG IS THE INTERCEPTION. Without it this tile reads NEW MATCH, because the
// 4-week window the new tags compare against cannot see a slot last scheduled five weeks ago.
ok(await p.$eval(tile("wed", "Stony Point"), e => e.dataset.wouldbe) === "match",
  "  and it is intercepting a NEW MATCH, not filling a gap where no tag would have rendered");
ok(await p.$$eval(`${D("tile")}[data-change="match"]`, es => es.length) === 2,
  "  CONTROL: two other tiles do read NEW MATCH, so the interception is specific");
const inks = await p.evaluate(() => {
  const g = f => getComputedStyle(document.querySelector(`[data-testid="newb"][data-f="${f}"]`)).backgroundColor;
  return { back: g("back"), field: g("field"), match: g("match"), time: g("time") }; });
ok(inks.back !== inks.field, `  and it is a different colour from the three that mean new (${inks.back} vs ${inks.field})`);
ok(inks.field === inks.match && inks.match === inks.time,
  "  CONTROL: while the three that DO mean new share one colour, so the odd one out is deliberate");
ok((await p.$eval(tile("wed", "Stony Point"), e => e.title)).includes("would read NEW MATCH"),
  "  and the tooltip names the label it displaced, which is the only way to check the rule fired");

// ══ 6. THREE TAGS, THREE COLOURS ═════════════════════════════════════════════════════════════
// An earlier pass gave PRIORITY and KEY FIELD one colour and split them on border style. It did
// not read at tile size, and the legend swatch rendered solid while its caption said dashed, so
// the key contradicted itself on screen. Colour is the only channel that survives here.
const shape = await p.evaluate(() => {
  const g = t => { const e = document.querySelector(`[data-testid="tag"][data-t="${t}"]`);
    if (!e) return null; const s = getComputedStyle(e);
    return { color: s.color, style: s.borderTopStyle, width: s.borderTopWidth }; };
  return { prio: g("prio"), key: g("key"), s11: g("s11") }; });
// ALL THREE MUST EXIST FOR ANY OF THIS TO MEAN ANYTHING. Comparing against a missing element
// throws rather than failing, which is a worse outcome than a red line.
ok(shape.prio != null && shape.key != null && shape.s11 != null,
  "all three promo tags are on screen to compare");
const cols = [shape.prio.color, shape.key.color, shape.s11.color];
ok(new Set(cols).size === 3, `each carries its own colour (${cols.join(" / ")})`);
ok(shape.prio.color !== shape.key.color,
  "  PRIORITY and KEY FIELD are no longer the same colour, which is the whole change");
ok([shape.prio, shape.key, shape.s11].every(x => x.style === "solid"),
  "  and none of them leans on a border style to be told apart");
ok([shape.prio, shape.key, shape.s11].every(x => x.width !== "0px"),
  "  CONTROL: every border is actually drawn, so 'all solid' is not three invisible borders");
// THE LEGEND SWATCH IS THE SAME ELEMENT, which is what failed last time: the tile was dashed and
// the swatch was not, so the key described something the reader could not see.
ok(await p.evaluate(() => {
  const tile = document.querySelector('[data-testid="tag"][data-t="key"]');
  const key = document.querySelector('[data-testid="keytag"] .tag[data-t="key"]');
  if (!tile || !key) return false;
  return getComputedStyle(tile).color === getComputedStyle(key).color; }),
  "  and the legend swatch is the same colour as the tile, so the key cannot contradict the page");

// ══ 7. PRIORITY IS STILL SWALLOWED BY KEY FIELD ═══════════════════════════════════════════════
const wt = await p.$$eval(`${D("tile")}[data-day="tue"][data-venue="Westlake"][data-time="7:00 PM"] ${D("tag")}`,
  es => es.map(e => e.dataset.t));
ok(!wt.includes("prio"), `a match's own PRIORITY is not printed beside a KEY FIELD (${wt.join(", ")})`);
ok(wt.includes("key"), "  CONTROL: the KEY FIELD that swallowed it is there");
const ht = await p.$$eval(`${tile("mon", "Hattrick")} ${D("tag")}`, es => es.map(e => e.dataset.t));
ok(ht.includes("prio"), "  CONTROL: and PRIORITY does render where no KEY FIELD covers it");

// ══ 8. THE PAIR THIS FEATURE EXISTS FOR ═══════════════════════════════════════════════════════
// Keswick and Hattrick both cancelled 2 of 4. On the shipped tile they are one orange chip and one
// decision. They are opposite decisions.
const kes = tile("mon", "Keswick Park (Chamblee)"), hat = tile("mon", "Hattrick");
ok(await p.$eval(kes, e => e.dataset.r) === "2" && await p.$eval(hat, e => e.dataset.r) === "2",
  "two Monday tiles carry the identical 2/4 ratio");
const chips = await p.evaluate(([a, b]) => {
  const c = s => getComputedStyle(document.querySelector(`${s} [data-testid="rchip"]`)).backgroundColor;
  return [c(a), c(b)]; }, [kes, hat]);
ok(chips[0] === chips[1], `  and the identical chip colour, so the ratio alone cannot separate them (${chips[0]})`);
const ages = await p.evaluate(([a, b]) => {
  const e = s => { const x = document.querySelector(`${s} [data-testid="age"]`);
    return x ? { w: x.dataset.w, text: x.textContent.trim(), bg: getComputedStyle(x).backgroundColor } : null; };
  return [e(a), e(b)]; }, [kes, hat]);
ok(ages[0] != null && ages[1] != null, "  both carry a recency marker");
ok(ages[0].w === "4" && ages[1].w === "1",
  `  one last cancelled 4 weeks ago, the other one week ago (${ages[0].text} vs ${ages[1].text})`);
ok(ages[0].bg !== ages[1].bg,
  `  and they are visually different weights, computed rather than assumed (${ages[0].bg} vs ${ages[1].bg})`);
ok((await p.$eval(kes, e => e.title)).includes("4 weeks ago") && (await p.$eval(hat, e => e.title)).includes("1 week ago"),
  "  with the age spelled out in words on hover, not only as an abbreviation");

// ══ 9. THE MARKER IS TIED TO THE RATIO, IN BOTH DIRECTIONS ════════════════════════════════════
ok(await p.$$eval(`${D("tile")}[data-r="0"] ${D("age")}`, es => es.length) === 0,
  "a slot with no cancellations carries no recency marker");
ok(await p.$$eval(`${D("tile")}[data-r="0"]`, es => es.length) === 4,
  "  CONTROL: and there are four such tiles, so the zero is not an empty selector");
ok(await p.evaluate(() => [...document.querySelectorAll('[data-testid="tile"]')]
    .filter(e => e.dataset.r !== "0").every(e => e.querySelector('[data-testid="age"]'))),
  "  every tile that DOES have a ratio carries one");
ok(await p.$$eval(D("age"), es => es.every(e => ["1","2","3","4"].includes(e.dataset.w))),
  "  and nothing older than 4 weeks is marked, which is where a cancellation stops earning a push");

// ══ 10. THE KEY EXPLAINS BOTH CHANGES, AND ONLY WHAT IS ON SCREEN ═════════════════════════════
ok(await p.$$eval(D("keynew"), es => es.length) === 4, "the key lists the four change tags in use");
// ALL FOUR RUNGS OF THE SCALE, unlike the tag list above it. A step's weight only means anything
// against the others, so a ramp with a gap in it reads as broken rather than as unused.
ok(await p.$$eval(D("keyage"), es => es.length) === 4,
  `  and all four recency steps, even the one no tile uses this week (${await p.$$eval(D("keyage"), es => es.length)})`);
ok(await p.$$eval(`${D("keyage")}[data-used="0"]`, es => es.length) === 1,
  "  CONTROL: exactly one of them is unused this week, so the full ramp is not an accident of the fixture");
ok(await p.$$eval(D("keyage"), es => es.map(e => e.querySelector(".age").textContent.trim())
    .every(t => /^\dW AGO$/.test(t))),
  "  every step is labelled in one shape, with no special case for the newest");
ok((await p.$eval(D("cutoff"), e => e.textContent)).includes("older than 4 weeks"),
  "  and states the 4 week cut-off once, rather than on a rung");
ok(await p.$$eval(D("whyshape"), es => es.length) === 0,
  "  and no shape caption survives, since nothing is told apart by shape any more");
// EVERY DESCRIPTION IS ONE SHORT LINE. The key is read weekly by people who know what the tags
// mean; a paragraph there is clutter that stops being read, which is how a legend dies.
ok(await p.$$eval(".keyrow span", es => es.every(e => e.textContent.trim().length <= 70)),
  `  and no description runs long (max ${await p.$$eval(".keyrow span", es => Math.max(...es.map(e => e.textContent.trim().length)))} chars)`);

// ══ 11. GEOMETRY ══════════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1180]) {
  await p.setViewportSize({ width: vw, height: 1100 });
  await load();
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${vw}px: no page-level horizontal scroll`);
  ok(await p.evaluate(() => { const s = document.querySelector(".gridscroll");
    return s.scrollWidth > s.clientWidth ? getComputedStyle(s).overflowX === "auto" : true; }),
    `  ${vw}px: the grid scrolls in its own container, never the page`);
  ok(await p.$$eval(`${D("newb")}, ${D("age")}, ${D("rchip")}`,
    es => es.every(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0)),
    `  ${vw}px: every badge is actually laid out, none collapsed to nothing`);
  ok(await p.evaluate(() => [...document.querySelectorAll('[data-testid="tile"]')]
      .every(e => e.scrollWidth <= e.clientWidth + 1)),
    `  ${vw}px: no badge row overflows its tile`);
}

// ══ 12. LIGHT, NOT DARK ═══════════════════════════════════════════════════════════════════════
await p.setViewportSize({ width: 1180, height: 1100 });
await p.emulateMedia({ colorScheme: "dark" });
await load();
const bg = await p.$eval("body", e => getComputedStyle(e).backgroundColor);
ok(bg === "rgb(244, 247, 245)", `with the OS set to dark the page is still light (${bg})`);

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
