/* 2026 Daily Matches — cities by default, the nine planned fields placed, and the no-goal fold.
 *
 * Ryan: "make the cities view the default. Move the no city fields into the corresponding cities
 * and add the additional cities just here we have a plan for later / I should be able to add
 * fields and cities for the plans. need to hide the fields with no goals, mainly old fields"
 *
 * Every figure is production, read 2026-09-24. Run: node measure-city-default.mjs
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const CANDIDATES = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDIDATES.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); c ? pass++ : fail++; };
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
const D = t => `[data-testid="${t}"]`;
const load = async (w = 1200, h = 900) => { await p.setViewportSize({ width: w, height: h });
  await p.goto(new URL('./city-default.html', import.meta.url).href); await p.waitForTimeout(150); };
const txt = s => p.$eval(s, e => e.textContent.trim());
const num = async s => Number((await txt(s)).replace(/[^0-9.\-]/g, ''));
const cityRow = c => `${D('crow')}[data-c="${c}"]`;
const cellOf = async (c, t) => p.$eval(`${cityRow(c)} ${D(t)}`, e => Number(e.textContent.trim().replace(/[^0-9.\-]/g, '')));

await load();
ok(errs.length === 0, `no script errors${errs.length ? ': ' + errs[0] : ''}`);

// ══ 1. CITIES IS WHAT THE PAGE OPENS ON ════════════════════════════════════
const pressed = await p.$eval(`${D('grain')} button[aria-pressed="true"]`, e => e.dataset.g);
ok(pressed === 'city', `the grain at load is Cities (${pressed})`);
ok(await p.$$eval(D('crow'), es => es.length) > 0, '  and city rows are what render');
// CONTROL: a DEFAULT, not a removal. Field mode has to still be one click away, or this stopped
// being a default and became a feature deletion.
const fieldBtn = await p.$(`${D('grain')} button[data-g="field"]`);
ok(fieldBtn !== null, '  CONTROL: the Fields button is still there');
ok(await p.$eval(`${D('grain')} button[data-g="field"]`, e => e.getAttribute('aria-pressed')) === 'false',
  '  CONTROL: and it is unpressed, so this is a default rather than a removal');

// ══ 2. NOTHING SITS IN "NO CITY SET" ANY MORE ══════════════════════════════
// All nine planned fields carried a null city and named their city in their own title. Placed,
// the bucket has nothing left in it, so it must not render as an empty row either.
const cities = await p.$$eval(D('crow'), es => es.map(e => e.dataset.c));
ok(!cities.includes('No city set'), `no "No city set" row (${cities.length} cities)`);
ok(cities.length === 9, `  nine cities (${cities.join(', ')})`);
const slotCities = await p.$$eval(`${D('frow')}[data-kind="slot"]`, es => es.map(e => e.dataset.c));
ok(slotCities.length === 9, `  all nine planned fields are placed (${slotCities.length})`);
ok(slotCities.every(c => c !== 'No city set'), '  CONTROL: and none of them is in the bucket');

// ══ 3. THE ONE THING THAT MAKES A FREE-TEXT BOX UNSAFE ═════════════════════
// Production carries THREE spellings of one market right now: the goal row renders "OKC" off
// fin_venues.city, the planned field is titled "New Field - Oklahoma", and Field Pipeline calls
// it "Oklahoma City". Typed, those become two rows. Grouped on a normalised key, one.
ok(cities.filter(c => /okla|OKC/i.test(c)).length === 1,
  `Oklahoma City is one row, not two (${cities.filter(c => /okla|OKC/i.test(c)).join(' + ')})`);
ok(cities.includes('Oklahoma City'), '  and it renders under the label, not the code');
ok(!cities.includes('OKC') && !cities.includes('Oklahoma'), '  CONTROL: neither "OKC" nor "Oklahoma" is a second row');
const okcFields = await p.$$eval(`${D('frow')}[data-c="Oklahoma City"]`, es => es.map(e => e.dataset.f));
ok(okcFields.length === 2 && okcFields.some(f => /Scissortail/.test(f)) && okcFields.some(f => /Oklahoma/.test(f)),
  `  CONTROL: the existing field and the planned one are in the SAME row (${okcFields.join(' + ')})`);

// ══ 4. THE TILES DID NOT MOVE ══════════════════════════════════════════════
// Giving a field a city changes which row it sits in and nothing else. If the tiles move, the
// reassignment ate or invented matches.
ok(await num(D('t-sep')) === 16.3, `Sep tile still 16.3`);
ok(await num(D('t-dec')) === 28.2, `  Dec tile still 28.2`);
ok(await num(D('t-gap')) === 11.9, `  To find still 11.9`);
const tsep = await num(D('tsep')), tdec = await num(D('tdec')), tgap = await num(D('tgap'));
ok(tsep === 16.3 && tdec === 28.2, `the city rows sum to the tiles (${tsep} / ${tdec})`);
ok(tgap === 11.9, `  and the footer gap agrees (${tgap})`);
// CONTROL: gap is Dec minus Sep, not a fourth number carried separately.
ok(Math.abs((tdec - tsep) - tgap) < 0.05, '  CONTROL: gap is Dec minus Sep rather than its own figure');
// CONTROL: the sum is over CITIES, so it must fail if a city is dropped. Nine rows, summed here.
const rowSep = await p.$$eval(`${D('crow')} ${D('sep')}`, es => es.reduce((s, e) => s + Number(e.textContent), 0));
ok(Math.abs(rowSep - 16.3) <= 0.15, `  CONTROL: the nine rendered Sep figures sum to ${rowSep.toFixed(1)} against 16.3`);

// ══ 5. THE TWO CITIES WITH NO FIELD YET ════════════════════════════════════
// "add the additional cities just here we have a plan for later". A city with no field is not a
// row, because a city row is a rollup of fields — so a planned CITY is a planned FIELD in it.
for (const [c, dec] of [['San Diego', 1.0], ['Philadelphia', 0.5]]) {
  ok(cities.includes(c), `${c} is a row`);
  ok(await cellOf(c, 'dec') === dec, `  carrying its December goal of ${dec}`);
  ok(await cellOf(c, 'sep') === 0, `  and a September of 0.0, which is true: no field, no matches`);
  const f = await p.$eval(`${cityRow(c)} ${D('fields')}`, e => e.textContent.trim());
  ok(/^0\s/.test(f) && /\+1 new/.test(f), `  CONTROL: it reads "${f}", no existing fields and one planned`);
}

// ══ 6. THE FOLD: NO GOAL FOLDS, THE COUNT DOES NOT ═════════════════════════
// Ryan: "need to hide the fields with no goals, mainly old fields." MEASURED on production: all
// ten such fields read 0.0 in September and nine ran no match this month, so folding them costs
// nothing. They fold the way DORMANT already folds in field mode — out of the list, still in
// the arithmetic — and the city row keeps saying how many there are.
await p.click(cityRow('Austin'));
await p.waitForTimeout(160);
const visBefore = await p.$$eval(`${D('frow')}[data-c="Austin"]:not([hidden])`, es => es.map(e => e.dataset.f));
ok(visBefore.length === 11, `Austin opens to 11 fields, not 13 (${visBefore.length})`);
ok(!visBefore.includes('Hill Country Middle School') && !visBefore.includes('San Juan Diego'),
  '  the two with no December goal are folded out');
ok(visBefore.includes('New Field - Austin'), '  CONTROL: the planned field is NOT folded — it is work, not history');
const badge = await p.$eval(`${cityRow('Austin')} ${D('fields')}`, e => e.textContent.trim());
ok(/3 no goal/.test(badge), `  and the row still says how many are missing a target ("${badge}")`);

// THE ARITHMETIC IS UNTOUCHED BY THE FOLD. This is the assertion the whole idea rests on.
const aSep = await cellOf('Austin', 'sep'), aDec = await cellOf('Austin', 'dec');
await p.click(`${D('fold')}[data-c="Austin"]`);
await p.waitForTimeout(160);
const visAfter = await p.$$eval(`${D('frow')}[data-c="Austin"]:not([hidden])`, es => es.map(e => e.dataset.f));
ok(visAfter.length === 13, `  the fold opens to all 13 (${visAfter.length})`);
ok(await cellOf('Austin', 'sep') === aSep && await cellOf('Austin', 'dec') === aDec,
  `  CONTROL: and Austin's Sep and Dec did not move (${aSep} / ${aDec}) — the fold is length, not maths`);
ok(await p.$eval(`${D('fold')}[data-c="Austin"]`, e => e.getAttribute('aria-expanded')) === 'true',
  '  CONTROL: aria-expanded tracks it, so the state is readable to something other than an eye');

// THE DRAWER SUMS TO THE ROW IT SITS UNDER, with everything shown.
const fs = await p.$$eval(`${D('frow')}[data-c="Austin"] ${D('fsep')}`,
  es => es.map(e => e.textContent.trim()).filter(t => t !== '—').reduce((s, t) => s + Number(t), 0));
ok(Math.abs(fs - aSep) <= 0.15, `  Austin's fields sum to its September (${fs.toFixed(1)} against ${aSep})`);
const fd = await p.$$eval(`${D('frow')}[data-c="Austin"] ${D('fdec')}`,
  es => es.map(e => e.textContent.trim()).filter(t => t !== '—').reduce((s, t) => s + Number(t), 0));
ok(Math.abs(fd - aDec) <= 0.05, `  and to its December (${fd.toFixed(1)} against ${aDec})`);
// CONTROL: a no-goal field reads "no goal" in its own gap cell and is summed nowhere.
ok(await p.$eval(`${D('frow')}[data-f="San Juan Diego"] ${D('fgap')}`, e => e.textContent.trim()) === 'no goal',
  '  CONTROL: a field with no December target says so in its own cell rather than showing a zero');
ok(await p.$eval(`${D('frow')}[data-f="New Field - Austin"] ${D('fsep')}`, e => e.textContent.trim()) === '—',
  '  CONTROL: a planned field shows a dash for September, never 0.0');

// A CITY WITH NOTHING TO FOLD SHOWS NO FOLD.
ok(await p.$(`${D('fold')}[data-c="San Diego"]`) === null,
  'a city with no no-goal fields shows no fold control');
ok(await p.$(`${D('fold')}[data-c="Dallas"]`) !== null, '  CONTROL: Dallas, which has three, does');

// ══ 7. ADDING A FIELD, AND ADDING A CITY ═══════════════════════════════════
// "I should be able to add fields and cities for the plans." Cities as the default REQUIRES this:
// the "+ Add a new field" button lives on the New fields table, which only renders in field mode.
const addLabel = await p.$eval(`${D('add-field')}[data-c="Austin"]`, e => e.textContent.trim());
ok(/Austin/.test(addLabel), `the add control names its city ("${addLabel}")`);
ok(await p.$eval(`${D('add-field')}[data-c="Austin"]`, e => e.closest('tr').dataset.c) === 'Austin',
  '  and it sits inside Austin’s drawer, so the city is not a second choice to get wrong');
const closedAdd = await p.$eval(`${D('tools')}[data-c="Dallas"]`, e => e.hidden);
ok(closedAdd === true, '  CONTROL: a shut city offers no add control, because its city is not on screen');

// ══ 7b. MOVING ONE, AND DELETING ONE ═══════════════════════════════════════
// Ryan: "the no city set going into the above cities or new cities ... should be able to delete
// these when we want". The control that MOVES a planned field is its city cell, so it lives on
// the row in the drawer; the × is the one field mode already has. Without both, Cities as the
// default is a grain you can read and not maintain.
const mover = `${D('frow')}[data-f="New Field - Austin"] ${D('frow-city')}`;
ok(await p.$eval(mover, e => e.tagName) === 'SELECT', 'a planned field carries a city picker on its own row');
ok(await p.$eval(mover, e => e.value) === 'Austin', '  showing the city it is currently in');
const movOpts = await p.$$eval(`${mover} option`, es => es.map(e => e.value));
ok(movOpts.length === 12, `  offering all twelve pipeline markets, so it can move to one with no row yet (${movOpts.length})`);
ok(movOpts.includes('Chicago') && movOpts.includes('Oklahoma City'), '  including Chicago and Oklahoma City');
ok(!movOpts.includes('Oklahoma') && !movOpts.includes('OKC'),
  '  CONTROL: and not the two spellings that would split that market into a second row');
ok(await p.$(`${D('frow')}[data-f="New Field - Austin"] ${D('frow-remove')}`) !== null,
  'and a delete on the same row');
// CONTROL: neither control appears on an EXISTING field. Its city comes off fin_venues through
// the venue link and is not this page's to retype, and a venue with matches is not something a
// goal page deletes.
ok(await p.$(`${D('frow')}[data-f="NEMP"] ${D('frow-city')}`) === null,
  '  CONTROL: an existing field has no city picker — its city comes off the venue link');
ok(await p.$(`${D('frow')}[data-f="NEMP"] ${D('frow-remove')}`) === null,
  '  CONTROL: and no delete, because a venue with matches is not this page’s to remove');
const movers = await p.$$eval(D('frow-city'), es => es.length);
ok(movers === 9, `  CONTROL: exactly the nine planned fields carry one (${movers})`);

const opts = await p.$$eval(`${D('add-city-pick')} option`, es => es.map(e => e.value));
ok(opts.length === 3 && opts.every(o => ['Chicago', 'El Paso', 'Fort Worth'].includes(o)),
  `add-a-city offers only markets with no row yet (${opts.join(', ')})`);
ok(!opts.includes('Austin') && !opts.includes('San Diego'),
  '  CONTROL: a city already on the page is not offered — that is adding a field, not a city');
ok(!opts.includes('Oklahoma') && !opts.includes('OKC'),
  '  CONTROL: and the spelling that would have split OKC in two is not offerable at all');
// THE CONTROL IS A PICKER, NOT A TEXT BOX. This is the whole fix: a typed city is what produced
// three spellings of one market across three pages.
ok(await p.$eval(D('add-city-pick'), e => e.tagName) === 'SELECT', '  it is a select');
ok(await p.$$eval('input[type="text"], input:not([type])', es => es.length) === 0,
  '  CONTROL: there is no free-text city input anywhere on the page');

// ══ 8. ONE SCALE ACROSS THE CHART ══════════════════════════════════════════
// Per-column scaling would draw every city equally far along, which is the opposite of the point.
const bars = await p.$$eval(D('bact'), es => es.map(e => ({ c: e.closest('[data-c]').dataset.c,
  h: parseFloat(e.style.height), v: Number(e.dataset.v) })));
const aus = bars.find(x => x.c === 'Austin'), hou = bars.find(x => x.c === 'Houston');
ok(Math.abs((aus.h / hou.h) - (aus.v / hou.v)) < 0.02,
  `Austin's bar is taller than Houston's by the ratio the numbers are (${(aus.h / hou.h).toFixed(2)} vs ${(aus.v / hou.v).toFixed(2)})`);
ok(bars.find(x => x.c === 'San Diego').h === 0, '  CONTROL: a city with no September draws no bar at all');
const chartOrder = await p.$$eval(D('col'), es => es.map(e => e.dataset.c));
ok(chartOrder.join() === cities.join(), '  chart order matches table order, so the eye carries down');

// ══ 9. 390 AND 1200 ════════════════════════════════════════════════════════
for (const w of [390, 1200]) {
  await load(w);
  ok(await p.evaluate(() => document.documentElement.scrollWidth) <= w + 2, `${w}px: no page-level horizontal scroll`);
  const g = await p.$eval('.scroll', e => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  ok(w === 390 ? g.sw > g.cw + 2 : true, `  ${w}px: the table scrolls in its own container`);
  const small = await p.$$eval('button, select', es => es.filter(e => e.offsetParent !== null
    && e.getBoundingClientRect().height < 31.5).map(e => e.textContent.trim().slice(0, 18)));
  ok(small.length === 0, `  ${w}px: every visible control is at least 32px${small.length ? ': ' + small.join(' / ') : ''}`);
}

// ══ 10. LIGHT AND DARK ═════════════════════════════════════════════════════
for (const theme of ['light', 'dark']) {
  await load();
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  await p.waitForTimeout(110);
  const c = await p.evaluate(() => { const px = s => getComputedStyle(document.querySelector(s));
    return { card: px('.card').backgroundColor, ramp: px('[data-testid="oct"]').color,
             now: px('[data-testid="sep"]').color, body: px('body').backgroundColor }; });
  ok(c.card !== c.body, `${theme}: the card separates from the page`);
  // DERIVED MONTHS MUST NOT READ WITH THE AUTHORITY OF A TYPED ONE. Oct and Nov are a computed
  // suggestion; December is a number a person typed.
  ok(c.ramp !== c.now, `  ${theme}: the ramp months are recessive against the recorded one`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
