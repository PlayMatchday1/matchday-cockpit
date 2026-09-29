/* PLAYER ACTIVITY, against the real page. Gated by node --check and scripts/_bindcheck.mjs.
 *
 *   npx tsx --env-file=.env.local scripts/_check_activity.mjs
 *
 * Every absence check carries a presence control in the same run, and every zero read from a selector
 * written here asserts its own container first: a selector that matches nothing and a component that
 * renders nothing both return 0.
 */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
import { businessMonthKey } from '../src/lib/funnelMonth.ts';
installHarnessGuard();

const BASE = process.env.BASE || 'http://localhost:3000';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport: { width: 1440, height: 1000 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const D = t => `[data-testid="${t}"]`;
const load = async (w = 1440) => {
  await p.setViewportSize({ width: w, height: 1000 });
  await p.goto(`${BASE}/lifecycle/behavior`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(D('behavior-row'), { timeout: 60000 });
  await p.waitForTimeout(1800);
};
const rowNames = () => p.$$eval(D('behavior-row'), es => es.map(e => e.dataset.name));
const heads = () => p.$$eval('thead th', es => es.map(e => e.textContent.trim()));
await load();
ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);

// ══ 1. WORDING ════════════════════════════════════════════════════════════════════════════════
const words = await p.evaluate(() => ({
  title: document.querySelector('[data-testid="growth-title"]')?.textContent.trim(),
  subtitle: document.querySelector('[data-testid="growth-subtitle"]')?.textContent.trim(),
  body: document.body.innerText,
}));
ok(words.title === 'Player Activity', `the page is titled Player Activity ("${words.title}")`);
ok(words.subtitle === 'Track signups, bookings and returning players.',
  `  with the new subtitle ("${words.subtitle}")`);
ok(!/Player Behavior/.test(words.title ?? ''), '  CONTROL: and not the old title');
ok(/Player Metrics/.test(words.body), 'the table is headed Player Metrics');
ok(!/Historical Matchday metrics/.test(words.body), '  CONTROL: not "Historical Matchday metrics"');
ok(!/Recurring players|% recurring/.test(words.body), 'nothing says Recurring, which became Returning');
ok(/Returning players/.test(words.body) && /Returning player %/.test(words.body),
  '  CONTROL: while both Returning labels are on screen, so the check above is not free');
ok(!/oldest to newest/.test(words.body), 'the "N months · oldest to newest" line is gone');

// ══ 2. THE SIX METRICS ARE THE ROWS, IN ORDER ════════════════════════════════════════════════
const names = await rowNames();
ok(names.join() === 'Registrations,New players,Total players,Spots booked,Returning players,Returning player %',
  `the six metrics are the rows, in order (${names.join(', ')})`);
const hs = await heads();
ok(hs[0] === 'Metric', `  and the first column is the metric name (${hs[0]})`);
ok(hs.some(h => /Period total/.test(h)), '  the period total survives');
ok(hs.some(h => /Change vs\. last month/.test(h)), '  and the change column names the unit it compares');
ok(await p.$$eval(`${D('behavior-row')} ${D('behavior-period-total')}`, es => es.length) === 6,
  '  CONTROL: every metric row carries its own period total cell');

// ══ 3. SEPTEMBER IS A COLUMN, MARKED ONCE, ON SEPTEMBER ══════════════════════════════════════
const nowKey = businessMonthKey();
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const nowLabel = `${MON[Number(nowKey.split('-')[1]) - 1]} ${nowKey.split('-')[0]}`;
ok(hs.some(h => h.startsWith(nowLabel)), `${nowLabel} is in the default columns`);
const marks = await p.$$eval(D('behavior-in-progress'), es => es.length);
ok(marks === 1, `  the live column is marked exactly once (${marks})`);
const markedCol = await p.$$eval(`${D('behavior-col-head')}`, es =>
  es.filter(e => e.querySelector('[data-testid="behavior-in-progress"]')).map(e => e.dataset.k));
ok(markedCol.length === 1 && markedCol[0] === nowKey,
  `  CONTROL: and the mark is on ${nowKey}, not another column (${markedCol.join(', ')})`);
ok(await p.$$eval(D('behavior-col-head'), es => es.length) > 1,
  '  CONTROL: with more than one column, so "exactly once" is a real constraint');

// ══ 4. NO COMPARE TOGGLE, AND EVERY ROW HAS A REAL CHANGE ════════════════════════════════════
ok(await p.$$eval('[data-testid="behavior-mtd"], [data-testid="mtd"]', es => es.length) === 0,
  'no compare toggle exists');
const deltas = await p.$$eval(`${D('behavior-row')} [class*="status"]`, es => es.map(e => e.textContent.trim()));
ok(deltas.length === 6, `  CONTROL: and every metric row carries a change pill anyway (${deltas.length})`);
ok(deltas.every(t => /%|pts/.test(t)), `  each one a real figure, not a dash (${deltas.join(' ')})`);

// ══ 5. GRAIN WIDENS THE TABLE AND LEAVES THE ROWS ALONE ══════════════════════════════════════
const monthCols = (await heads()).length;
ok(await p.$(D('behavior-gran-daily')) !== null, 'a Daily grain exists beside Monthly and Weekly');
await p.click(D('behavior-gran-weekly'));
/* WAIT ON CONTENT, NOT A CLOCK. A cold weekly fetch outlasts any timeout worth hardcoding, and the
   loading state renders ZERO columns - which reads as "weekly lost the table" rather than "the fetch
   had not landed". That exact zero failed this assertion once. */
await p.waitForFunction(() => [...document.querySelectorAll('thead th')]
  .some(e => /Change vs\. last week/.test(e.textContent ?? '')), { timeout: 90000 });
await p.waitForTimeout(600);
const weekCols = (await heads()).length;
ok(weekCols > monthCols, `weekly widens the table rather than lengthening it (${monthCols} then ${weekCols})`);
ok((await rowNames()).length === 6, '  CONTROL: and the six metric rows are untouched');
ok((await heads()).some(h => /Change vs\. last week/.test(h)), '  and the change column now names the week');
await p.click(D('behavior-gran-daily'));
/* WAIT ON THE AXIS, NOT THE HEADER. The change header names the GRAIN and flips the instant the
   button is pressed, so waiting on it proved only that the click registered - the table was still
   showing the monthly axis while the daily fetch was in flight, and the column count read 10. */
await p.waitForFunction(() => document.querySelectorAll('[data-testid="behavior-col-head"]').length > 20,
  { timeout: 90000 });
await p.waitForTimeout(600);
const dayHeads = await heads();
ok(dayHeads.length > 25 && dayHeads.length < 40,
  `daily narrows to about a month of columns rather than 180 (${dayHeads.length})`);
ok((await rowNames()).length === 6, '  CONTROL: rows still the six metrics');
ok(dayHeads.some(h => /Change vs\. last day/.test(h)), '  and the change column names the day');
await load();

// ══ 6. THE METRIC PICKER APPEARS WITH THE PIVOT ══════════════════════════════════════════════
const pickerShown = () => p.$eval('#growthBehaviorMetricField', e => !e.className.includes('hidden'));
ok((await pickerShown()) === false, 'no metric picker while the metrics are the rows');
await p.click('#growthBehaviorView button[data-value="city"]');
await p.waitForTimeout(1500);
ok((await pickerShown()) === true, '  CONTROL: and it appears when the rows become cities');
const cities = await rowNames();
ok(cities.length === 7, `seven play markets (${cities.length}: ${cities.join(', ')})`);
ok(!cities.includes('Registrations'), '  CONTROL: the metric rows gave way rather than doubling up');
ok((await heads()).some(h => h.startsWith(nowLabel)), '  and time is still the columns');

// ══ 7. CLICKING A CITY OPENS ITS METRICS, ONE ROW AT A TIME ══════════════════════════════════
ok(await p.$$eval(D('behavior-child'), es => es.length) === 0, 'nothing is expanded to begin with');
await p.click(D('behavior-row'));
await p.waitForTimeout(900);
const kids = await p.$$eval(D('behavior-child'), es => es.map(e => e.dataset.metric));
ok(kids.length === 6, `  clicking a city opens all six of its metrics (${kids.length}: ${kids.join(', ')})`);
ok(await p.$$eval(`${D('behavior-row')}[data-open="1"]`, es => es.length) === 1,
  '  CONTROL: exactly one row open at a time');
await p.click(D('behavior-row'));
await p.waitForTimeout(700);
ok(await p.$$eval(D('behavior-child'), es => es.length) === 0, '  CONTROL: and clicking it again closes it');

// ══ 8. SORTING ════════════════════════════════════════════════════════════════════════════════
const totals = () => p.$$eval(`${D('behavior-row')} ${D('behavior-period-total')}`,
  es => es.map(e => Number(e.textContent.replace(/[,%—\s]/g, '')) || 0));
await p.click('thead th[data-k="total"]');
await p.waitForTimeout(700);
const desc = await totals();
ok(desc.length > 1, `CONTROL: ${desc.length} rows to order, so the sort checks are not free`);
ok(desc.every((v, i) => i === 0 || desc[i - 1] >= v), `sorting by the period total descends (${desc.join(' ')})`);
await p.click('thead th[data-k="total"]');
await p.waitForTimeout(700);
const asc = await totals();
ok(asc.every((v, i) => i === 0 || asc[i - 1] <= v), `  and clicking again ascends (${asc.join(' ')})`);
ok(asc.length === desc.length, '  CONTROL: sorting reorders rows without losing or inventing any');
ok(await p.$$eval('thead th[aria-sort]', es => es.some(e => e.getAttribute('aria-sort') === 'ascending')),
  '  CONTROL: with aria-sort on the header, so it is announced and not only coloured');
const firstBucket = (await p.$$eval(D('behavior-col-head'), es => es.map(e => e.dataset.k)))[0];
await p.click(`thead th[data-k="${firstBucket}"]`);
await p.waitForTimeout(700);
ok(await p.$eval(`thead th[data-k="${firstBucket}"]`, e => e.getAttribute('aria-sort') !== 'none'),
  `  a single period column sorts as well as the total (${firstBucket})`);
await p.click('#growthBehaviorView button[data-value="matchday"]');
await p.waitForTimeout(1200);
ok(await p.$$eval('thead th[aria-sort]', es => es.length) === 0,
  '  CONTROL: sorting is absent in Overall, where ranking metrics by size means nothing');
ok((await rowNames()).length === 6, '  CONTROL: while Overall still has its six rows');

// ══ 9. THE CHART IS REACHABLE, NOT DEFAULT ═══════════════════════════════════════════════════
ok(await p.$eval(D('behavior-chartbox'), e => e.hidden) === true, 'the chart is not the default view');
ok((await rowNames()).length > 0, '  CONTROL: while the table is populated, so a hidden chart is not an empty page');
await p.click(D('behavior-chart-toggle'));
await p.waitForTimeout(700);
ok(await p.$eval(D('behavior-chartbox'), e => e.hidden) === false, '  it opens on demand rather than being deleted');
const hint = await p.$eval(D('behavior-chart-hint'), e => e.textContent);
ok(/6,573/.test(hint) && /9,716/.test(hint) && /585/.test(hint) && /1,123/.test(hint),
  '  and says why, with the real figures that make one shared axis impossible');
await p.click(D('behavior-chart-toggle'));
await p.waitForTimeout(700);
ok(await p.$eval(D('behavior-chartbox'), e => e.hidden) === true, '  CONTROL: and it closes again');

// ══ 10. THE DISTINCT-COUNT NOTE, WHILE THE AGGREGATE IS PARKED ═══════════════════════════════
/* A number people have been reading does not silently disappear. The wrong sum is gone and the
   right figure is not wired in, so the dash carries a reason on the page. */
const note = await p.$(D('behavior-distinct-note'));
const totalCells = await p.$$eval(`${D('behavior-row')} ${D('behavior-period-total')}`, es => es.map(e => e.textContent.trim()));
const dashed = totalCells.filter(t => t === '—').length;
ok(totalCells.length === 6, `CONTROL: six period-total cells read (${totalCells.join(' | ')})`);
if (dashed > 0) {
  ok(note !== null, `${dashed} distinct total(s) dash, and the page says why`);
  const nt = await p.$eval(D('behavior-distinct-note'), e => e.textContent.replace(/\s+/g, ' '));
  ok(/distinct counts/.test(nt), '  naming them as distinct counts');
  ok(/not the sum/.test(nt), '  and that the period figure is not the sum of the months');
  ok(/month column is correct/.test(nt), '  while saying the per-month columns are unaffected');
} else {
  ok(note === null, 'the distinct totals are wired, so the interim note is absent');
}
/* AND THE WRONG NUMBER IS GONE EITHER WAY. 15,625 was the sum of six monthly Set sizes. */
ok(!totalCells.some(t => t.replace(/,/g, '') === '15625'),
  '  CONTROL: and the 86.9%-overstated sum appears nowhere');

// ══ 11. 390 AND 1440 ══════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1440]) {
  await load(vw);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= vw + 2, `${vw}px: no page-level horizontal scroll (${sw})`);
  const geo = await p.evaluate(() => {
    const cell = document.querySelector('[data-testid="behavior-row"] td');
    const scroller = (() => {
      let el = document.querySelector('[data-testid="behavior-row"]')?.closest('div');
      while (el && el !== document.body) {
        if (el.scrollWidth > el.clientWidth + 1) return { sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX };
        el = el.parentElement;
      }
      return null;
    })();
    const small = [...document.querySelectorAll('#growthBehaviorGranularity button, #growthBehaviorView button, [data-testid="behavior-chart-toggle"]')]
      .filter(e => e.offsetParent !== null && e.getBoundingClientRect().height < 31.5)
      .map(e => e.textContent.trim().slice(0, 14));
    return { pos: cell ? getComputedStyle(cell).position : null, scroller, small };
  });
  ok(geo.pos === 'sticky', `  ${vw}px: the row name column is pinned while the periods scroll (${geo.pos})`);
  ok(geo.small.length === 0, `  ${vw}px: every control clears 32px${geo.small.length ? ': ' + geo.small.join(' / ') : ''}`);
  ok(geo.scroller === null || geo.scroller.ox === 'auto' || geo.scroller.ox === 'scroll',
    `  ${vw}px: the table scrolls in its own container, never the page (${geo.scroller ? geo.scroller.ox : 'fits'})`);
}

ok(errs.length === 0, `no page errors across the whole run${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
