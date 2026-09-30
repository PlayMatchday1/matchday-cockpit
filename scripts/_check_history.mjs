/* THE 38 ASSERTIONS FROM scripts/mocks/measure-daily-matches-history.mjs, REWRITTEN AGAINST THE
 * REAL PAGE. Read only: it never presses a control that writes.
 *
 * WHY THE SELECTORS DIFFER FROM THE MOCK'S. The mock is a standalone file with hand-written class
 * names; the real page is Tailwind plus inline styles, so `.capband`, `th.boundary`, `.gap` and
 * `.nodata` do not exist as classes here. The PROPERTY each assertion tests is unchanged — the
 * selectors are data-testids and data-attributes the component actually carries, and every colour
 * check is computed rather than taken from a class name, which is what the mock asked for.
 *
 * THE COUNTS DIFFER TOO, AND ON PURPOSE. The mock is nine hand-written cities with a fabricated
 * decline; production has its own. Anything that was a hard count against fixture data is asserted
 * as the property it was standing in for, and the measured figure is printed beside it.
 *
 *   BASE=http://localhost:3001 node scripts/_check_history.mjs
 */
try { process.loadEnvFile('.env.local'); } catch { /* already set */ }
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();

const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = 'rmancuso@playmatchday.com';
const URL_ = `${BASE}/growth/daily-matches`;
const { storageState } = await storageStateFor(ADMIN, BASE);
const b = await chromium.launch();
const ctx = await b.newContext({ storageState, viewport: { width: 1440, height: 1000 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); c ? pass++ : fail++; };
const D = t => `[data-testid="${t}"]`;

const load = async (w = 1440) => {
  await p.setViewportSize({ width: w, height: 1000 });
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(D('fg-cities'), { timeout: 60000 });
  await p.waitForSelector(D('crow'), { timeout: 60000 });
};
const months = () => p.$$eval(D('mh'), es => es.map(e => e.dataset.m));
const toggle = async () => { await p.click(D('histtog')); await p.waitForTimeout(200); };
await load();

// ══ 1. HISTORY IS OPTIONAL AND OFF BY DEFAULT ═════════════════════════════════════════════════
// The table's job is the climb to December. Four extra columns on by default push the live month
// and the goal apart, and those two are what people actually read.
ok(await p.$eval(D('histtog'), e => e.getAttribute('aria-pressed')) === 'false',
  'history is off when the page opens');
const closed = await months();
ok(closed.join() === 'sep,oct,nov,dec', `four columns to begin with (${closed.join(', ')})`);
const nCities = await p.$$eval(D('crow'), es => es.length);
ok(nCities > 1,
  `  CONTROL: while ${nCities} city rows are rendered, so the short header is not an empty table`);
ok(await p.$$eval(D('trendhead'), es => es.length) === 0, '  and no trend column yet');
ok(await p.$$eval(D('capband'), es => es.length) === 0, '  and no caption band yet');

await toggle();
const opened = await months();
ok(opened.length === 7 && opened.slice(3).join() === 'sep,oct,nov,dec',
  `history adds three months to the left (${opened.join(', ')})`);
ok(await p.$$eval(D('trendhead'), es => es.length) === 1, '  and the trend column appears with them');
const nCities2 = await p.$$eval(D('crow'), es => es.length);
ok(nCities2 === nCities, `  CONTROL: the same ${nCities} cities, not a different set`);

// ══ 2. ACTUAL AND GOAL ARE NOT THE SAME KIND OF NUMBER ════════════════════════════════════════
// The chart above this table already teaches solid-versus-outlined. This is that distinction in a
// row: a hairline at the boundary and a caption band over each side.
const caps = await p.$$eval(`${D('cap-actual')}, ${D('cap-goal')}`, es => es.map(e => e.textContent.trim()));
ok(caps.join() === 'Actual,Goal', `the two sides are captioned (${caps.join(' / ')})`);
const bounds = await p.$$eval('th[data-boundary="1"]', es => es.map(e => e.dataset.m));
ok(bounds.length === 1, `  with exactly one rule between them (${bounds.length})`);
ok(bounds[0] === 'oct', '  CONTROL: and it falls after the live month, not at an arbitrary column');
ok(await p.$eval('th[data-boundary="1"]', e => getComputedStyle(e).borderLeftWidth) !== '0px',
  '  CONTROL: and the rule is actually drawn, not merely marked');

// PAST MONTHS ARE INK, FUTURE MONTHS ARE GREY. Computed, not by class name. Read off a city that
// HAS history, or the dash colour would be measured instead of the ink.
const inkCity = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="crow"]')];
  const r = rows.find(e => !e.querySelector('[data-testid="hcell"][data-none="1"]'));
  return r ? r.dataset.c : null;
});
ok(inkCity !== null, `  CONTROL: ${inkCity} has history in every column, so ink is measured and not a dash`);
const inks = await p.evaluate((city) => {
  const r = [...document.querySelectorAll('[data-testid="crow"]')].find(e => e.dataset.c === city);
  const g = m => getComputedStyle(r.querySelector(`[data-m="${m}"]`)).color;
  const first = r.querySelector('[data-testid="hcell"]').dataset.m;
  return { past: g(first), live: g('sep'), nov: g('nov'), dec: g('dec') };
}, inkCity);
ok(inks.past !== inks.nov, `an actual and a target are different ink (${inks.past} vs ${inks.nov})`);
ok(inks.live === inks.dec, '  CONTROL: while the live month and the goal share the emphasis they already had');
ok(inks.past !== inks.live, '  and history sits one step back from the live month, which stays the anchor');

// ══ 3. THE LIVE MONTH IS MARKED ═══════════════════════════════════════════════════════════════
ok(await p.$$eval(D('inprog'), es => es.length) === 1, 'the live month is marked exactly once');
ok(await p.evaluate(() => document.querySelector('[data-testid="inprog"]').closest('th').dataset.m === 'sep'),
  '  CONTROL: on September, not on another column');

// ══ 4. A NEW MARKET IS NOT A CITY AT ZERO ═════════════════════════════════════════════════════
// This is the one that would otherwise ship wrong. A market with no pitch open in June rendering
// 0.0 reads as a city that collapsed rather than one that did not exist.
const newCities = await p.evaluate(() => [...document.querySelectorAll('[data-testid="crow"]')]
  .filter(r => [...r.querySelectorAll('[data-testid="hcell"]')].every(c => c.dataset.none === '1'))
  .map(r => r.dataset.c));
ok(newCities.length > 0, `markets with no history exist to test (${newCities.join(', ')})`);
const dashText = await p.evaluate((city) => {
  const r = [...document.querySelectorAll('[data-testid="crow"]')].find(e => e.dataset.c === city);
  return [...r.querySelectorAll('[data-testid="hcell"]')].map(e => e.textContent.trim());
}, newCities[0]);
ok(dashText.every(t => !/\d/.test(t)),
  `  a market with no history dashes rather than reading 0.0 (${newCities[0]}: ${dashText.join(' ')})`);
const dashCells = await p.$$eval(`${D('crow')} ${D('hcell')}[data-none="1"]`, es => es.length);
ok(dashCells === newCities.length * 3,
  `  CONTROL: ${dashCells} dashed cells across ${newCities.length} new markets, not a blanket dash`);
ok(await p.evaluate((city) => {
  const r = [...document.querySelectorAll('[data-testid="crow"]')].find(e => e.dataset.c === city);
  return [...r.querySelectorAll('[data-testid="hcell"]')].every(e => /\d/.test(e.textContent)); }, inkCity),
  `  CONTROL: while ${inkCity} carries real figures in the same columns, so the dash reads as specific`);
ok(await p.$$eval(`${D('crow')} ${D('newnote')}`, es => es.length) === newCities.length,
  '  and each is labelled new rather than left to be guessed at');

// ══ 5. TREND IS WHY HISTORY EARNS ITS COLUMNS ═════════════════════════════════════════════════
// A gap alone does not say whether it is closing. +3.7 having climbed and +3.7 having sat flat are
// opposite decisions, and the table cannot tell them apart without this.
const trends = await p.$$eval(`${D('crow')} ${D('trend')}`, es => es.map(e => e.dataset.t ?? 'none'));
const kinds = [...new Set(trends)].sort();
console.log(`    trend directions present on production today: ${kinds.join(', ')}`);
// ASSERT ONLY THE DIRECTIONS THAT EXIST. Production has no falling city today and shaping the data
// to manufacture one would be the worst possible way to make this line green. The CLASSIFIER's
// three states are pinned in the gate suite instead, where a fixture is honest.
for (const k of ['up', 'dn', 'flat']) {
  if (kinds.includes(k)) ok(true, `  the ${k} state renders on real data`);
  else console.log(`    (no city is currently ${k === 'dn' ? 'falling' : k}; not asserted — see field-goals-test for the classifier)`);
}
ok(kinds.some(k => k !== 'none'), '  CONTROL: at least one real direction renders, so the scan is not of an empty set');
ok(await p.evaluate((city) => {
  const r = [...document.querySelectorAll('[data-testid="crow"]')].find(e => e.dataset.c === city);
  const t = r.querySelector('[data-testid="trend"]');
  const jun = Number(r.querySelector('[data-testid="hcell"]').dataset.v);
  const sep = Number(r.querySelector('[data-testid="sep"]').dataset.v);
  return Math.abs(Number(t.textContent.replace(/[^0-9.\-]/g, '')) - Math.round((sep - jun) * 10) / 10) < 0.051;
}, inkCity), `  ${inkCity}'s trend is its earliest-history-to-now climb, not its gap`);
const gapOf = await p.$eval(`${D('crow')}[data-c="${inkCity}"] ${D('gap')}`, e => e.textContent.trim());
const trendOf = await p.$eval(`${D('crow')}[data-c="${inkCity}"] ${D('trend')}`, e => e.textContent.trim());
ok(gapOf.replace(/[^0-9.]/g, '') !== trendOf.replace(/[^0-9.]/g, ''),
  `  CONTROL: and it is a different number from the gap (${trendOf} vs gap ${gapOf})`);
if (kinds.includes('up') && kinds.includes('dn')) {
  ok(await p.evaluate(() => {
    const up = [...document.querySelectorAll('[data-testid="trend"]')].find(e => e.dataset.t === 'up');
    const dn = [...document.querySelectorAll('[data-testid="trend"]')].find(e => e.dataset.t === 'dn');
    if (!up || !dn) return false;
    return getComputedStyle(up).color !== getComputedStyle(dn).color; }),
    '  CONTROL: climbing and falling are different colours, computed rather than assumed');
} else {
  console.log('    (climbing and falling cannot be compared on data with only one direction)');
}
// AND IT NEVER RENDERS FOR A CITY THAT HAS NO HISTORY TO TREND.
ok(await p.$$eval(`${D('crow')} ${D('trend')}[data-none="1"]`, es => es.length) === newCities.length,
  '  a new market shows no trend rather than a fabricated one');

// ══ 6. NOTHING ELSE MOVES WHEN HISTORY OPENS ══════════════════════════════════════════════════
// The gap and the fields column are the page's existing answer and must read identically either
// way, or the toggle is changing more than it claims to.
const gapsOn = await p.$$eval(`${D('crow')} ${D('gap')}`, es => es.map(e => e.textContent.trim()));
const fieldsOn = await p.$$eval(`${D('crow')} ${D('fields')}`, es => es.map(e => e.textContent.trim()));
await toggle();
const gapsOff = await p.$$eval(`${D('crow')} ${D('gap')}`, es => es.map(e => e.textContent.trim()));
const fieldsOff = await p.$$eval(`${D('crow')} ${D('fields')}`, es => es.map(e => e.textContent.trim()));
ok(gapsOn.join() === gapsOff.join(), `the gap column is identical with history on and off (${gapsOff.slice(0, 3).join(' ')})`);
ok(gapsOff.length > 0 && gapsOff.some(g => /\d/.test(g)),
  `  CONTROL: and there are ${gapsOff.length} real gaps to compare, so the equality is not of two empties`);
ok(fieldsOn.join() === fieldsOff.join(), 'the fields column is identical too');

// ══ 7. EXPANSION STILL WORKS, AND CARRIES THE SAME COLUMNS ════════════════════════════════════
await toggle();
ok(await p.$$eval(D('frow'), es => es.length) === 0, 'nothing is expanded to begin with');
const biggest = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="crow"]')];
  return rows.map(r => ({ c: r.dataset.c, n: Number(r.querySelector('[data-testid="fields"]').textContent.replace(/\D.*/, '') || 0) }))
    .sort((a, b) => b.n - a.n)[0].c;
});
await p.click(`${D('crow')}[data-c="${biggest}"]`);
await p.waitForSelector(D('frow'), { timeout: 20000 });
const kids = await p.$$eval(D('frow'), es => es.length);
ok(kids > 0, `opening ${biggest} shows its ${kids} fields`);
const kidMonths = await p.$eval(D('frow'), e => e.querySelectorAll('[data-m]').length);
ok(kidMonths === 7, `  and a field row carries the same seven months as its city (${kidMonths})`);
const kidDashes = await p.$$eval(`${D('frow')} ${D('hcell')}[data-none="1"]`, es => es.length);
const kidHist = await p.$$eval(`${D('frow')} ${D('hcell')}`, es => es.length);
ok(kidHist > 0, `  CONTROL: ${kidHist} field history cells exist, so a zero dash count would mean something`);
console.log(`    ${kidDashes} of them dash — the same rule one level down`);

// ══ 8. THE CITY IS THE SUM OF ITS FIELDS, IN THE HISTORY COLUMNS TOO ══════════════════════════
const foots = await p.evaluate((city) => {
  const r1 = v => Math.round(v * 10) / 10;
  const row = [...document.querySelectorAll('[data-testid="crow"]')].find(e => e.dataset.c === city);
  const kidsEls = [];
  let n = row.nextElementSibling;
  while (n && n.dataset.testid !== 'crow') { if (n.dataset.testid === 'frow') kidsEls.push(n); n = n.nextElementSibling; }
  const out = [];
  for (let k = 0; k < 3; k++) {
    const cityCell = row.querySelectorAll('[data-testid="hcell"]')[k];
    if (cityCell.dataset.none === '1') continue;
    const sum = r1(kidsEls.reduce((a, e) => {
      const c = e.querySelectorAll('[data-testid="hcell"]')[k];
      return a + (c && c.dataset.none !== '1' ? r1(Number(c.dataset.v)) : 0); }, 0));
    out.push({ m: cityCell.dataset.m, row: r1(Number(cityCell.dataset.v)), fields: sum });
  }
  return out;
}, biggest);
ok(foots.length > 0 && foots.every(f => Math.abs(f.row - f.fields) < 0.051),
  `each history column foots to its fields (${foots.map(f => `${f.m} ${f.row.toFixed(1)}=${f.fields.toFixed(1)}`).join(', ')})`);

// ══ 9. GEOMETRY ═══════════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1440]) {
  await load(vw);
  await toggle();
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    `${vw}px: no page-level horizontal scroll with history open`);
  ok(await p.evaluate(() => {
    const s = document.querySelector('[data-testid="fg-cities"]').closest('.overflow-x-auto');
    return s.scrollWidth > s.clientWidth ? getComputedStyle(s).overflowX === 'auto' : true; }),
    `  ${vw}px: the table scrolls in its own container, never the page`);
  ok(await p.$$eval(`${D('grain')} button, ${D('fg-sort')} button, ${D('histtog')}`,
    es => es.length > 0 && es.every(e => e.getBoundingClientRect().height >= 32)),
    `  ${vw}px: every control clears 32px`);
  ok(await p.$eval(`${D('crow')} td:first-child`, e => getComputedStyle(e).position) === 'sticky',
    `  ${vw}px: the city name stays put while the months scroll`);
}

ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
await b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
