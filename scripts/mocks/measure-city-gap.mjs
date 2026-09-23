import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const CANDIDATES = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDIDATES.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const D = t => `[data-testid="${t}"]`;
const load = async (w=1200) => { await p.setViewportSize({width:w,height:900});
  await p.goto(new URL('./city-gap.html', import.meta.url).href); await p.waitForTimeout(150); };
const cell = (c,t) => p.$eval(`${D('crow')}[data-c="${c}"] ${D(t)}`, e=>e.textContent.trim());
const num = s => Number(String(s).replace(/[^0-9.]/g,''));

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE CITY ROWS MUST SUM TO THE KPI TILES ═════════════════════════════
// The page's three tiles read SEP 16.9 / DEC 28.2 / TO FIND 11.3. If the city rollup does not
// add up to those, the page contradicts itself and the city view is the one that is wrong.
const rows = await p.$$eval(D('crow'), es=>es.map(e=>e.dataset.c));
ok(rows.length===7, `seven cities (${rows.length})`);
const sum = async t => (await Promise.all(rows.map(c => cell(c,t)))).reduce((s,v)=>s+num(v),0);
const sSep = await sum('sep'), sDec = await sum('dec'), sGap = await sum('gap');
ok(Math.abs(sSep-16.9)<0.05, `the Sep column sums to ${sSep.toFixed(1)}, matching SEP SO FAR 16.9`);
ok(Math.abs(sDec-28.2)<0.05, `  the Dec column sums to ${sDec.toFixed(1)}, matching DEC GOAL 28.2`);
ok(Math.abs(sGap-11.3)<0.05, `  the Gap column sums to ${sGap.toFixed(1)}, matching TO FIND 11.3`);
ok(Math.abs((sDec-sSep)-sGap)<0.05, '  CONTROL: gap is Dec minus Sep, not a fourth number');

// ══ 2. THE FOOTER IS THE SAME ARITHMETIC, NOT A SECOND SOURCE ══════════════
ok(num(await p.$eval(D('tsep'),e=>e.textContent))===Number(sSep.toFixed(1)), 'the total row equals the column it sits under');
ok(num(await p.$eval(D('tgap'),e=>e.textContent))===Number(sGap.toFixed(1)), '  and so does its gap');

// ══ 3. THE RAMP IS LINEAR, SO CITY AND FIELD AGREE BY CONSTRUCTION ═════════
// sum(sep + (dec-sep)k) = sum(sep) + (sum(dec)-sum(sep))k. If a build ramps cities some other
// way, the city view stops matching the fields inside it and nobody can see why.
for (const c of ['Austin','Dallas']){
  const sep=num(await cell(c,'sep')), dec=num(await cell(c,'dec'));
  const oct=num(await cell(c,'oct')), nov=num(await cell(c,'nov'));
  ok(Math.abs(oct-(sep+(dec-sep)/3))<0.06, `  ${c}: Oct ${oct} is one third of the climb`);
  ok(Math.abs(nov-(sep+2*(dec-sep)/3))<0.06, `  ${c}: Nov ${nov} is two thirds`);
  ok(oct>sep && nov>oct && dec>nov, `  CONTROL: ${c} ramps monotonically`);
}
const tOct = num(await p.$$eval(`${D('tot')} td`, es=>es[3].textContent));
const cOct = await sum('oct');
ok(Math.abs(tOct-cOct)<0.1, `the estate Oct ramp ${tOct} equals the sum of city ramps ${cOct.toFixed(1)}`);

// ══ 4. DERIVED MONTHS LOOK DERIVED ═════════════════════════════════════════
// Oct and Nov are a computed suggestion, Dec is a number somebody typed. They must not read
// with equal authority or the ramp becomes a commitment nobody made.
const wt = await p.evaluate(() => { const g=s=>getComputedStyle(document.querySelector(s));
  return { oct:g('[data-testid="oct"]'), dec:g('[data-testid="dec"]'), sep:g('[data-testid="sep"]') }; });
ok(parseInt(wt.dec.fontWeight,10) > parseInt(wt.oct.fontWeight,10),
  `Dec (${wt.dec.fontWeight}) outweighs the ramp (${wt.oct.fontWeight})`);
ok(wt.oct.color !== wt.dec.color, '  CONTROL: and is a different ink, not weight alone');
ok(parseInt(wt.sep.fontWeight,10) > parseInt(wt.oct.fontWeight,10), '  CONTROL: so does the September actual');

// ══ 5. THE GAP CARRIES ITS BAND, AND THE BANDS ARE NOT ALL ONE ═════════════
const bands = await p.$$eval(D('dot'), es=>es.map(e=>e.dataset.b));
ok(new Set(bands).size>=2, `the dots use ${new Set(bands).size} bands, not one`);
ok(bands[0]==='behind', `  the worst gap leads and is flagged behind (${bands[0]})`);
const gaps = await Promise.all(rows.map(c=>cell(c,'gap')));
ok(gaps.every((g,i)=>i===0||num(gaps[i-1])>=num(g)), `  CONTROL: rows are in gap order (${gaps.join(' ')})`);

// ══ 6. NEW FIELDS ARE PART OF THE CITY GAP AND MUST BE VISIBLE ═════════════
// The page keeps existing fields and slots in two separate tables. A city's December goal spans
// both, so the rollup is the only place they meet — and closing a gap by signing a field is a
// different job from running more nights at one you have.
const af = await cell('Austin','fields');
ok(/\+2 new/.test(af), `Austin names its unsigned fields ("${af}")`);
const okc = await cell('OKC','fields');
ok(!/new/.test(okc), `  CONTROL: a city with none says nothing ("${okc}")`);
ok(/no goal/.test(await cell('Dallas','fields')), '  and a field with no December target is named, not counted as zero');

// ══ 6b. THE CHART FOLLOWS THE GRAIN, ON ONE SCALE ══════════════════════════
// A month chart cannot show a per-city gap, which is the whole request. In city mode the pair is
// September actual against the December goal and the distance between them IS the gap.
const cols = await p.$$eval(D('col'), es=>es.map(e=>e.dataset.c));
ok(cols.length===7 && cols[0]==='Austin', `the chart draws seven cities, worst gap first (${cols[0]})`);
ok(cols.join()===rows.join(), '  CONTROL: chart order matches table order, so the eye carries down');
const hs = await p.$$eval(D('bact'), es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
const gs = await p.$$eval(D('bgoal'), es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
ok(gs.every((g,i)=>g>hs[i]), 'every goal bar stands above its actual, because every city has a gap');
// ONE SCALE: Austin's actual (5.8) must be taller than Houston's (4.1) by the same ratio the
// numbers are. A per-column scale would make every city look equally far along.
ok(Math.abs(hs[0]/hs[1] - 5.8/4.1) < 0.06,
  `  CONTROL: bars are on one scale, Austin/Houston draws ${(hs[0]/hs[1]).toFixed(2)} against ${(5.8/4.1).toFixed(2)}`);
ok(hs[hs.length-1] > 0, '  CONTROL: the smallest city still draws, rather than vanishing');

// ══ 6c. THE TILES DO NOT FOLLOW THE GRAIN ══════════════════════════════════
// They are the number the company is held to. Seven per-city tiles would answer nothing.
const tiles = await p.$$eval(`${D('tiles')} .tv`, es=>es.map(e=>e.textContent.trim()));
ok(tiles.join(' ')==='16.9 28.2 11.3', `the tiles stay estate-level (${tiles.join(' / ')})`);

// ══ 6d. THE DRAWER: FIELDS UNDER A CITY ════════════════════════════════════
// Ryan: "should have drop down per city to see the fields under each city if you want".
// "If you want" is the spec: collapsed by default, because seven cities open at once is just the
// field table with extra steps.
const hiddenAtRest = await p.$$eval(D('frow'), es=>es.every(e=>e.hidden));
ok(hiddenAtRest, 'every drawer is shut at rest');
ok(await p.$eval(`${D('crow')}[data-c="Austin"]`, e=>e.getAttribute('aria-expanded'))==='false',
  '  and says so to a screen reader');

await p.click(`${D('crow')}[data-c="Austin"]`);
await p.waitForTimeout(140);
const openAustin = await p.$$eval(`${D('frow')}[data-c="Austin"]`, es=>es.filter(e=>!e.hidden).length);
ok(openAustin===11, `opening Austin shows its 11 fields (${openAustin})`);
const openHouston = await p.$$eval(`${D('frow')}[data-c="Houston"]`, es=>es.filter(e=>!e.hidden).length);
ok(openHouston===0, '  CONTROL: and opens nobody else');
ok(await p.$eval(`${D('crow')}[data-c="Austin"]`, e=>e.getAttribute('aria-expanded'))==='true',
  '  aria-expanded flips');

// THE ASSERTION THAT MATTERS. A drawer whose rows do not add up to the row you opened is worse
// than no drawer: it invites arithmetic that fails, on a page whose whole job is a gap.
const fsum = async (t) => (await p.$$eval(`${D('frow')}[data-c="Austin"] ${D(t)}`,
  es => es.map(e=>e.textContent.trim()))).reduce((s,v)=> s + (v==='—' ? 0 : Number(v.replace(/[^0-9.]/g,''))), 0);
const aSep = await fsum('fsep'), aDec = await fsum('fdec');
ok(Math.abs(aSep - num(await cell('Austin','sep'))) < 0.05,
  `  Austin's fields sum to its September (${aSep.toFixed(1)} against ${await cell('Austin','sep')})`);
ok(Math.abs(aDec - num(await cell('Austin','dec'))) < 0.05,
  `  and to its December (${aDec.toFixed(1)} against ${await cell('Austin','dec')})`);

// A NEW FIELD HAS NO SEPTEMBER, and that is a dash rather than a zero.
const newTags = await p.$$eval(`${D('frow')}[data-c="Austin"] ${D('newtag')}`, es=>es.length);
ok(newTags===2, `  the two unsigned fields are tagged NEW (${newTags})`);
const zilker = await p.$eval(`${D('frow')}[data-f="Zilker Park"] ${D('fsep')}`, e=>e.textContent.trim());
ok(zilker==='—', `  and carry no September actual ("${zilker}")`);

// A FIELD WITH NO DECEMBER TARGET SAYS SO IN ITS OWN GAP CELL — the rule the field table already
// follows. Not a zero, not an omission.
await p.click(`${D('crow')}[data-c="Houston"]`);
await p.waitForTimeout(140);
const noGoals = await p.$$eval(`${D('frow')}[data-c="Houston"] .nogoal`, es=>es.map(e=>e.textContent.trim()));
ok(noGoals.length===1 && noGoals[0]==='no goal', `  a field with no December target reads "${noGoals[0]}" in its gap cell`);

await p.click(`${D('crow')}[data-c="Austin"]`);
await p.waitForTimeout(140);
ok(await p.$$eval(`${D('frow')}[data-c="Austin"]`, es=>es.every(e=>e.hidden)), 'clicking again shuts it');
ok(await p.$$eval(`${D('frow')}[data-c="Houston"]`, es=>es.some(e=>!e.hidden)), '  CONTROL: and leaves Houston open');

// KEYBOARD. A row that only opens on click is a row half the people cannot open.
await p.focus(`${D('crow')}[data-c="OKC"]`);
await p.keyboard.press('Enter');
await p.waitForTimeout(140);
ok(await p.$$eval(`${D('frow')}[data-c="OKC"]`, es=>es.some(e=>!e.hidden)), 'Enter opens a focused row');

await load();

// ══ 7. SIZES AND THEMES ════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px: no page scroll`);
  const g = await p.$eval('.scroll', e=>({sw:e.scrollWidth, cw:e.clientWidth}));
  ok(w===1200 ? g.sw<=g.cw+2 : g.sw>g.cw+2, `  ${w}px: the table ${w===1200?'fits':'scrolls in its own container'}`);
  const btns = await p.$$eval('.seg button', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(Math.min(...btns)>=32, `  ${w}px: controls are ${Math.min(...btns)}px`);
}
for (const theme of ['light','dark']){
  await load();
  await p.evaluate(t=>document.documentElement.setAttribute('data-theme',t), theme);
  await p.waitForTimeout(110);
  const c = await p.evaluate(() => { const g=s=>getComputedStyle(document.querySelector(s));
    return { card:g('.card').backgroundColor, ink:g('[data-testid="sep"]').color,
             ramp:g('[data-testid="oct"]').color, fill:g('.prog i').backgroundColor }; });
  ok(c.card!=='rgba(0, 0, 0, 0)', `${theme}: the card paints its own background`);
  ok(c.ink!==c.card, `  ${theme}: the actual is not the card colour`);
  ok(c.ramp!==c.ink, `  ${theme}: the ramp stays recessive against it`);
  ok(c.fill!==c.card, `  ${theme}: the progress fill is visible`);
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
