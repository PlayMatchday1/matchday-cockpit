/* The REAL page, driven. Read only: it never presses a control that writes. */
try { process.loadEnvFile('.env.local'); } catch { /* already set */ }
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = 'rmancuso@playmatchday.com';
const URL_ = `${BASE}/growth/daily-matches`;
const { storageState } = await storageStateFor(ADMIN, BASE);
const b = await chromium.launch();
const ctx = await b.newContext({ storageState, viewport: { width: 1400, height: 1000 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const D = t => `[data-testid="${t}"]`;
const num = s => Number(String(s).replace(/[^0-9.\-]/g, ''));

const load = async (w = 1400) => {
  await p.setViewportSize({ width: w, height: 1000 });
  await p.goto(URL_, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(D('fg-existing'), { timeout: 30000 });
};
await load();
ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);

const tiles = async () => ({
  sep: await p.$eval(D('fg-now-v'), e => e.textContent.trim()),
  dec: await p.$eval(D('fg-goal-v'), e => e.textContent.trim()),
  gap: await p.$eval(D('fg-gap-v'), e => e.textContent.trim()),
});
const tilesField = await tiles();
console.log(`\nTILES in field mode: ${tilesField.sep} / ${tilesField.dec} / ${tilesField.gap}\n`);

// ── 4. FIELD MODE IS UNCHANGED. Capture a real field row BEFORE the grain exists on screen. ────
const probeKey = await p.$eval(D('fg-row'), e => e.dataset.key);
const fieldBefore = await p.$eval(`${D('fg-row')}[data-key="${probeKey}"]`, e => ({
  actual: e.querySelector('[data-testid="fg-actual"]').textContent.trim(),
  dec: e.querySelector('[data-testid="fg-goal-Dec"]').value,
  gap: e.querySelector('[data-testid="fg-gap-cell"]').textContent.trim(),
  oct: e.querySelector('[data-testid="fg-goal-Oct"]').value,
}));
const fieldRowCount = await p.$$eval(D('fg-row'), es => es.length);
const monthBars = await p.$$eval('[data-testid^="fg-bar-"]', es => es.length);
ok(fieldRowCount > 20 && monthBars === 12, `field mode: ${fieldRowCount} field rows and ${monthBars} month bars`);
ok(await p.$(D('crow')) === null, '  CONTROL: and no city rows at all');

// ── SWITCH ─────────────────────────────────────────────────────────────────────────────────────
ok(await p.$(D('grain')) !== null, 'the Fields / Cities toggle is on the page');
await p.click(D('grain-city'));
await p.waitForSelector(D('crow'), { timeout: 10000 });

// ── 7. THE TILES DO NOT FOLLOW THE GRAIN ───────────────────────────────────────────────────────
const tilesCity = await tiles();
ok(JSON.stringify(tilesCity) === JSON.stringify(tilesField),
  `the tiles are identical in both grains (${tilesCity.sep} / ${tilesCity.dec} / ${tilesCity.gap})`);

// ── 1/2. THE CITY ROWS SUM TO THE TILES ────────────────────────────────────────────────────────
const rows = await p.$$eval(D('crow'), es => es.map(e => e.dataset.c));
console.log(`city rows: ${rows.join(' | ')}\n`);
const cellOf = (c, t) => p.$eval(`${D('crow')}[data-c="${c}"] ${D(t)}`, e => e.textContent.trim());
/* SUM THE FULL-PRECISION data-v, NOT THE ROUNDED TEXT. A one-decimal sum of one-decimal rows is
   exactly the fault this page's header records: the sheet it replaces claims 16.7 for rows that add
   to 16.6. Summing what is printed reproduces that fault inside the assertion. */
const rawOf = (c, t) => p.$eval(`${D('crow')}[data-c="${c}"] ${D(t)}`, e => Number(e.dataset.v));
const sumCol = async t => (await Promise.all(rows.map(c => rawOf(c, t)))).reduce((s, v) => s + v, 0);
const sSep = await sumCol('sep'), sDec = await sumCol('dec'), sGap = await sumCol('gap'), sOct = await sumCol('oct'), sNov = await sumCol('nov');
const r1 = v => v.toFixed(1);
ok(r1(sSep) === num(tilesCity.sep).toFixed(1), `the Sep column sums to ${r1(sSep)}, matching the tile's ${tilesCity.sep}`);
ok(r1(sDec) === num(tilesCity.dec).toFixed(1), `  the Dec column sums to ${r1(sDec)}, matching the tile's ${tilesCity.dec}`);
ok(r1(sGap) === num(tilesCity.gap).toFixed(1), `  the Gap column sums to ${r1(sGap)}, matching the tile's ${tilesCity.gap}`);
ok(Math.abs((sDec - sSep) - sGap) < 1e-6, '  CONTROL: gap is Dec minus Sep, not a fourth number');
ok(rows.length >= 5, `  CONTROL: ${rows.length} rows, so the sum is not one row wearing a total`);

// the footer is the same arithmetic, not a second source
const foot = async t => Number(await p.$eval(D(t), e => e.dataset.v));
ok(Math.abs(await foot('tsep') - sSep) < 1e-3, `the total row equals the column it sits under (${(await foot('tsep')).toFixed(3)})`);
ok(Math.abs(await foot('tdec') - sDec) < 1e-3, `  and so does December (${(await foot('tdec')).toFixed(3)})`);
ok(Math.abs(await foot('tgap') - sGap) < 1e-3, `  and its gap (${(await foot('tgap')).toFixed(3)})`);
ok(Math.abs(await foot('toct') - sOct) < 1e-3, `  and October (${(await foot('toct')).toFixed(3)})`);
ok(Math.abs(await foot('tnov') - sNov) < 1e-3, `  and November (${(await foot('tnov')).toFixed(3)})`);
// CONTROL: the printed one-decimal column does NOT add up, which is why the assertion above reads
// data-v. If these ever coincide the control has stopped controlling.
const printedSep = (await Promise.all(rows.map(c => cellOf(c, 'sep')))).reduce((s, v) => s + num(v), 0);
ok(Math.abs(printedSep - sSep) > 1e-6,
  `  CONTROL: the printed column adds to ${printedSep.toFixed(1)} against ${r1(sSep)}, so full precision is not a free choice`);

// ── 3. DERIVED MONTHS LOOK DERIVED ─────────────────────────────────────────────────────────────
const wt = await p.evaluate(() => { const g = s => { const c = getComputedStyle(document.querySelector(s)); return { w: parseInt(c.fontWeight, 10), col: c.color }; };
  return { oct: g('[data-testid="oct"]'), dec: g('[data-testid="dec"]'), sep: g('[data-testid="sep"]') }; });
ok(wt.dec.w > wt.oct.w, `Dec (${wt.dec.w}) outweighs the ramp (${wt.oct.w})`);
ok(wt.dec.col !== wt.oct.col, '  CONTROL: and is a different ink, not weight alone');
ok(wt.sep.w > wt.oct.w, '  CONTROL: so does the September actual');

// ── 5. THE BANDS ───────────────────────────────────────────────────────────────────────────────
const bands = await p.$$eval(D('dot'), es => es.map(e => e.dataset.b));
ok(new Set(bands).size >= 2, `the dots use ${new Set(bands).size} bands, not one (${bands.join(' ')})`);
const gaps = await Promise.all(rows.map(c => cellOf(c, 'gap')));
const cityGaps = gaps.slice(0, rows.length - (rows.includes('No city set') ? 1 : 0));
ok(cityGaps.every((g, i) => i === 0 || num(cityGaps[i - 1]) >= num(g)), `  CONTROL: real cities are in gap order (${cityGaps.join(' ')})`);
/* THE BUCKET IS LAST ONLY IF IT EXISTS. It pinned "No city set" as the final row, and once the
   slots were given cities the bucket stopped existing and the assertion reported a defect that was
   its own. Conditional on presence, and the control says which branch ran. */
const bucketAt = rows.indexOf('No city set');
ok(bucketAt === -1 || bucketAt === rows.length - 1,
  bucketAt === -1 ? `  CONTROL: no unassigned bucket today, every slot carries a city`
                  : `  the No city set bucket is last, so it does not lead a ranking of cities`);

// ── 3. "+N new" AND "no goal" ──────────────────────────────────────────────────────────────────
const fieldsCells = Object.fromEntries(await Promise.all(rows.map(async c => [c, await cellOf(c, 'fields')])));
console.log('\nfields column:'); for (const [c, v] of Object.entries(fieldsCells)) console.log(`   ${c.padEnd(14)} ${v}`);
const withNew = Object.entries(fieldsCells).filter(([, v]) => /new/.test(v));
const without = Object.entries(fieldsCells).filter(([, v]) => !/new/.test(v));
ok(withNew.length > 0, `  ${withNew.length} rows name their unsigned fields`);
ok(without.length > 0 && without.every(([, v]) => !/\+0/.test(v)), `  CONTROL: the ${without.length} with none say nothing rather than "+0 new"`);
ok(Object.values(fieldsCells).some(v => /no goal/.test(v)), '  a city carrying absent December targets says so');

// ── 6. THE CHART IS ON ONE SCALE ───────────────────────────────────────────────────────────────
const cols = await p.$$eval(D('col'), es => es.map(e => e.dataset.c));
ok(cols.join() === rows.join(), `the chart draws the same ${cols.length} cities in the same order`);
const acts = await p.$$eval(D('bact'), es => es.map(e => ({ c: e.dataset.c, h: Number(e.getAttribute('height')), v: Number(e.dataset.v) })));
const goals = await p.$$eval(D('bgoal'), es => es.map(e => ({ c: e.dataset.c, h: Number(e.getAttribute('height')), v: Number(e.dataset.v) })));
const two = acts.filter(a => a.v > 0.3).slice(0, 2);
ok(two.length === 2 && Math.abs((two[0].h / two[1].h) - (two[0].v / two[1].v)) < 0.03,
  `  CONTROL: one scale — ${two[0].c}/${two[1].c} draws ${(two[0].h / two[1].h).toFixed(2)} against ${(two[0].v / two[1].v).toFixed(2)}`);
ok(goals.every((g, i) => g.h >= acts[i].h - 0.5), 'every goal bar stands at or above its actual');
ok(Math.min(...acts.map(a => a.h)) > 0, '  CONTROL: the smallest city still draws, rather than vanishing');

// ── 5b. THE DRAWER ─────────────────────────────────────────────────────────────────────────────
// PRESENCE BEFORE ABSENCE: prove the city rows rendered before asserting no drawer is open.
ok(rows.length > 0 && await p.$$eval(D('frow'), es => es.length) === 0,
  `${rows.length} city rows rendered and no drawer is open at rest`);
ok(await p.$$eval(D('crow'), es => es.every(e => e.getAttribute('aria-expanded') === 'false')),
  '  CONTROL: every city row says aria-expanded="false"');

const biggest = rows[0];
await p.click(`${D('crow')}[data-c="${biggest}"]`);
await p.waitForTimeout(150);
const openN = await p.$$eval(`${D('frow')}[data-c="${biggest}"]`, es => es.length);
ok(openN > 1, `a click opens ${biggest} and shows its ${openN} fields`);
ok(await p.$eval(`${D('crow')}[data-c="${biggest}"]`, e => e.getAttribute('aria-expanded')) === 'true', '  and aria-expanded flips');
ok(await p.$$eval(D('frow'), es => es.length) === openN, '  CONTROL: opening one city opened nobody else');

// THE ROWS SUM TO THE ROW THEY SIT UNDER
const fcol = async t => (await p.$$eval(`${D('frow')}[data-c="${biggest}"] ${D(t)}`, es => es.map(e => e.dataset.v)))
  .reduce((s, v) => s + (v === '' || v == null ? 0 : Number(v)), 0);
const fSep = await fcol('fsep'), fDec = await fcol('fdec'), fOct = await fcol('foct');
ok(Math.abs(fSep - await rawOf(biggest, 'sep')) < 1e-3, `  its fields sum to ${fSep.toFixed(3)}, matching its September (${(await rawOf(biggest, 'sep')).toFixed(3)})`);
ok(Math.abs(fDec - await rawOf(biggest, 'dec')) < 1e-3, `  and to ${fDec.toFixed(3)}, matching its December (${(await rawOf(biggest, 'dec')).toFixed(3)})`);
ok(Math.abs(fOct - await rawOf(biggest, 'oct')) < 1e-3, `  and its October ramp is the sum of its fields' ramps (${fOct.toFixed(3)} against ${(await rawOf(biggest, 'oct')).toFixed(3)})`);
ok(fSep > 0 && fDec > 0, '  CONTROL: both sums are non-zero, so the match is not two empty columns');

// A FIELD WITH NO DECEMBER TARGET READS "no goal"
/* "no goal" APPEARS ONLY IF SOME FIELD LACKS A DECEMBER TARGET. Pinning it to the largest city
   failed the day every Austin field had one. Find a city that actually has such a field, from the
   Fields column the page itself renders, and open that one. */
const noGoalCity = (await Promise.all(rows.map(async (c) => ({ c, f: await cellOf(c, 'fields') }))))
  .find((x) => /no goal/.test(x.f))?.c;
if (noGoalCity) {
  if (noGoalCity !== biggest) { await p.click(`${D('crow')}[data-c="${noGoalCity}"]`); await p.waitForTimeout(150); }
  const gapsIn = await p.$$eval(`${D('frow')}[data-c="${noGoalCity}"] ${D('fgap')}`, es => es.map(e => e.textContent.trim()));
  ok(gapsIn.some(g => /no goal/.test(g)), `  ${noGoalCity}: a field with no December target reads "no goal" (${gapsIn.join(' / ')})`);
  ok(gapsIn.some(g => /^[+-]/.test(g) || g === '0.0'), '  CONTROL: and the others show a gap figure');
  if (noGoalCity !== biggest) { await p.click(`${D('crow')}[data-c="${noGoalCity}"]`); await p.waitForTimeout(150); }
} else {
  ok(true, '  CONTROL: no city carries a field without a December target today, so there is nothing to render');
}

// SUBORDINATE, NOT A SECOND TABLE
const sub = await p.evaluate(() => {
  const f = document.querySelector('[data-testid="frow"] td'), c = document.querySelector('[data-testid="crow"] td');
  const g = e => getComputedStyle(e);
  return { fPad: parseFloat(g(f).paddingLeft), cPad: parseFloat(g(c).paddingLeft), fSize: parseFloat(g(f).fontSize), cSize: parseFloat(g(c).fontSize) };
});
ok(sub.fPad > sub.cPad, `  field rows are indented (${sub.fPad}px against ${sub.cPad}px)`);
ok(sub.fSize < sub.cSize, `  CONTROL: and smaller (${sub.fSize}px against ${sub.cSize}px), not indent alone`);

/* NEW FIELDS: A DASH, NEVER A ZERO. Open whichever city actually holds unsigned fields rather than
   the bucket, which stopped existing once the slots were given cities. */
const newFieldCity = (await Promise.all(rows.map(async (c) => ({ c, f: await cellOf(c, 'fields') }))))
  .find((x) => /new/.test(x.f))?.c;
ok(!!newFieldCity, `CONTROL: a city holding unsigned fields exists to open (${newFieldCity ?? 'none'})`);
await p.click(`${D('crow')}[data-c="${newFieldCity}"]`);
await p.waitForTimeout(200);
const newSeps = await p.$$eval(`${D('frow')}[data-kind="slot"] ${D('fsep')}`, es => es.map(e => e.textContent.trim()));
ok(newSeps.length > 0 && newSeps.every(v => !/[0-9]/.test(v)), `  all ${newSeps.length} new fields show a dash for the current month, never 0.0`);
ok(await p.$$eval(D('newtag'), es => es.length) === newSeps.length, `  CONTROL: and all ${newSeps.length} carry a NEW tag`);

// KEYBOARD
await p.click(`${D('crow')}[data-c="${biggest}"]`);            // shut it
await p.click(`${D('crow')}[data-c="${newFieldCity}"]`);      // shut it
await p.waitForTimeout(200);
ok(await p.$$eval(D('frow'), es => es.length) === 0, 'a second click shuts a drawer again');
const last = rows[rows.length - 2];
await p.focus(`${D('crow')}[data-c="${last}"]`);
await p.keyboard.press('Enter');
await p.waitForTimeout(150);
ok(await p.$$eval(`${D('frow')}[data-c="${last}"]`, es => es.length) > 0, `Enter opens a focused row (${last})`);

// ── 5c. A FIELD READS THE SAME IN BOTH GRAINS ──────────────────────────────────────────────────
await p.click(`${D('crow')}[data-c="${biggest}"]`);
await p.waitForTimeout(150);
const oneField = await p.$$eval(`${D('frow')}[data-c="${biggest}"]`, es => es.map(e => ({
  name: e.dataset.f, sep: e.querySelector('[data-testid="fsep"]').textContent.trim(),
  dec: e.querySelector('[data-testid="fdec"]').textContent.trim(),
})).filter(f => /[0-9]/.test(f.sep) && /[0-9]/.test(f.dec))[0]);
await p.click(D('grain-field'));
await p.waitForSelector(D('fg-existing'), { timeout: 10000 });
const inField = await p.$$eval(D('fg-row'), es => es.map(e => ({
  name: e.querySelector('td b')?.textContent.trim(),
  sep: e.querySelector('[data-testid="fg-actual"]').textContent.trim(),
  dec: e.querySelector('[data-testid="fg-goal-Dec"]').value,
})));
const match = inField.find(f => f.name === oneField.name);
ok(!!match && match.sep === oneField.sep && match.dec === oneField.dec,
  `${oneField.name} reads the same in both grains (Sep ${oneField.sep} / Dec ${oneField.dec} against ${match?.sep} / ${match?.dec})`);

// ── 4. FIELD MODE IS UNCHANGED AFTER THE ROUND TRIP ────────────────────────────────────────────
const fieldAfter = await p.$eval(`${D('fg-row')}[data-key="${probeKey}"]`, e => ({
  actual: e.querySelector('[data-testid="fg-actual"]').textContent.trim(),
  dec: e.querySelector('[data-testid="fg-goal-Dec"]').value,
  gap: e.querySelector('[data-testid="fg-gap-cell"]').textContent.trim(),
  oct: e.querySelector('[data-testid="fg-goal-Oct"]').value,
}));
ok(JSON.stringify(fieldAfter) === JSON.stringify(fieldBefore),
  `field mode is unchanged after the round trip (${JSON.stringify(fieldBefore)})`);
ok(await p.$$eval(D('fg-row'), es => es.length) === fieldRowCount, `  CONTROL: and still ${fieldRowCount} rows`);
ok(await p.$$eval('[data-testid^="fg-bar-"]', es => es.length) === 12, '  CONTROL: and the twelve month bars are back');

// ── 8. SIZES ───────────────────────────────────────────────────────────────────────────────────
for (const w of [390, 1200]) {
  await load(w);
  await p.click(D('grain-city'));
  await p.waitForSelector(D('crow'), { timeout: 10000 });
  ok(await p.evaluate(() => document.documentElement.scrollWidth) <= w + 2,
    `${w}px: no page-level horizontal scroll (${await p.evaluate(() => document.documentElement.scrollWidth)} against ${w})`);
  const g = await p.$eval(`${D('fg-cities')}`, e => { const c = e.closest('.overflow-x-auto'); return { sw: c.scrollWidth, cw: c.clientWidth }; });
  ok(w === 1200 ? g.sw <= g.cw + 2 : g.sw > g.cw + 2, `  ${w}px: the table ${w === 1200 ? 'fits' : 'scrolls in its own container'} (${g.sw} / ${g.cw})`);
  const h = await p.$$eval(`${D('grain')} button, ${D('fg-sort')} button`, es => es.map(e => Math.round(e.getBoundingClientRect().height)));
  ok(Math.min(...h) >= 32, `  ${w}px: every control is ${Math.min(...h)}px`);
}

ok(errs.length === 0, `no page errors across the whole run${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
