/* THE MOCK'S ASSERTIONS, RUN AGAINST THE REAL PAGE. Only the loader and the selector scope
   change; every ok(...) body is the mock's. The scope is needed because the real page carries
   other cards and an unscoped `.card` would measure whichever came first. */
import { chromium } from 'playwright';
import { storageStateFor, installHarnessGuard } from '../e2e/_session.mjs';
installHarnessGuard();
process.loadEnvFile('/Users/ryanmancuso/Code/matchday-cockpit/.env.local');
const BASE='http://localhost:3000';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const ctx = await b.newContext({ storageState, viewport:{width:1200,height:900} });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const D = t => `[data-testid="member-share"] [data-testid="${t}"]`;
const CARD = '[data-testid="member-share"]';
let loaded = false;
const load = async (w=1200,h=900) => {
  await p.setViewportSize({width:w,height:h});
  if (!loaded) { await p.goto(`${BASE}/membership`, { waitUntil:'domcontentloaded' });
    await p.waitForSelector(CARD, { timeout: 300000 }); loaded = true; }
  await p.evaluate(s => { const e=document.querySelector(s+' .scroll'); if(e) e.scrollLeft=0; }, CARD);
  await p.waitForTimeout(250); };
const at = (tid,g,m) => p.$eval(`${D(tid)}[data-g="${g}"][data-m="${m}"]`, e=>e.textContent.trim());

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. MONTHS RUN ACROSS THE TOP ═══════════════════════════════════════════
const cols = await p.$$eval(D('mcol'), es=>es.map(e=>e.dataset.m));
ok(cols.length>=19, `every month since launch as a column (${cols.length})`);
ok(/^[A-Z][a-z]{2} 20\d\d$/.test(cols[0]), `  the current month is column 1 (${cols[0]})`);
ok(/^[A-Z][a-z]{2} 20\d\d$/.test(cols[cols.length-1]), `  history runs rightward to the launch month (${cols[cols.length-1]})`);
ok(new Set(cols).size===cols.length, '  CONTROL: no month repeats');
const rowsN = await p.$$eval(CARD+' tbody tr', es=>es.length);
ok(rowsN===13, `thirteen rows: three groups of three, three headings, and a bare price row (${rowsN})`);
ok(await p.$$eval(D('grp'), es=>es.length)===3, '  CONTROL: three headings, none over the one-row price group');

// ══ 1b. THE PRICE ROW ══════════════════════════════════════════════════════
// George's item 4, "average member price per spot per month". One row, not a card and not a
// city breakdown: the page's own city filter is the drill-down. Same figure the tile above
// shows, extended to every month.
for (const [m,v] of [['Jun 2026','$7.85'],['Jul 2026','$7.34'],['Aug 2026','$9.01'],['Sep 2026','$12.70']]){
  ok(await at('partc','price',m)===v, `  price ${m} is ${v}, matching the tile above`);
}
const plab = await p.$eval(`${D('part')}[data-g="price"] .lab`, e=>e.textContent.trim());
ok(/price/i.test(plab) && /played/i.test(plab),
  `  its own label carries both the metric and the denominator ("${plab}")`);
// CONTROL: played is not booked. The spots row above divides by booked, and the two differ by
// 11-15%, so a price computed on booked would be quietly wrong and look fine.
const booked = Number((await at('wholec','spots','Aug 2026')).replace(/[^0-9]/g,''));
const rev = Number((await at('partc','rev','Aug 2026')).replace(/[^0-9]/g,''));
ok(Math.abs(rev/booked - 9.01) > 0.5,
  `  CONTROL: $9.01 is not revenue over BOOKED spots, which would be $${(rev/booked).toFixed(2)}`);
ok(await p.$(`${D('whole')}[data-g="price"]`)===null, '  CONTROL: the price group has no total row');

// ══ 2. THE FIGURE IS THE POINT, THE SHARE IS SECONDARY ═════════════════════
// Ryan: "make the number the main point, % could be secondary". So this is a type-weight
// assertion, not a layout one: the part figure must outweigh the share on every axis.
const sz = await p.evaluate((CARD) => {
  const g = s => { const c = getComputedStyle(document.querySelector(s));
    return { px: parseFloat(c.fontSize), w: parseInt(c.fontWeight, 10), col: c.color }; };
  return { num:g(CARD+' [data-testid="vnum"]'), pct:g(CARD+' [data-testid="vpct"]'), whole:g(CARD+' .t') };
}, CARD);
ok(sz.num.px > sz.pct.px, `the figure (${sz.num.px}px) is larger than the share (${sz.pct.px}px)`);
ok(sz.num.w >= sz.pct.w, `  and no lighter (${sz.num.w} vs ${sz.pct.w})`);
ok(sz.num.col !== sz.pct.col, '  CONTROL: and a different ink, so weight is not the only cue');
ok(sz.num.px > sz.whole.px, `  CONTROL: the part outweighs its own total too (${sz.whole.px}px)`);

// ══ 3. EVERY SHARE IS CHECKABLE AGAINST THE TWO FIGURES ABOVE IT ═══════════
const mrev = await at('partc','rev','Aug 2026');
const trev = await at('wholec','rev','Aug 2026');
const srev = await at('sharec','rev','Aug 2026');
ok(mrev==='$18,930' && trev==='$91,819', `Aug revenue reads ${mrev} of ${trev}`);
ok(srev==='20.6%', `  and its share renders as ${srev}`);
/* DERIVED, NOT PINNED, and the section heading is the argument: "every share is checkable
   against the two figures above it". Against a live page that is stronger than any constant. The
   mock's spots and players samples are not production (Aug spots read 1,934/8,520 against a real
   2,377/8,992); its REVENUE rows are exact. */
const num = t => Number(String(t).replace(/[$,]/g,''));
for (const g of ['rev','spots','players']) {
  const pv = num(await at('partc',g,'Aug 2026')), wv = num(await at('wholec',g,'Aug 2026'));
  const sv = await at('sharec',g,'Aug 2026');
  ok(sv === (wv>0 ? (pv/wv*100).toFixed(1)+'%' : '—'),
    `  ${g}: ${pv.toLocaleString()} of ${wv.toLocaleString()} renders as ${sv}`);
}
const three = [srev, await at('sharec','spots','Aug 2026'), await at('sharec','players','Aug 2026')];
ok(new Set(three).size===3, `  CONTROL: the three shares differ (${three.join(' / ')}), so the rows are not wired to one source`);

// ══ 3b. THE CURRENT MONTH NEEDS NO SCROLL, AT EITHER WIDTH ═════════════════
// "I do want to start at the current month." The test is not the column ORDER, it is whether
// the figure is on screen at rest. 390px is the one that can fail.
for (const w of [390, 1200]){
  await load(w);
  const cur = cols[0];
  const vis = await p.$eval(`${D('partc')}[data-g="rev"][data-m="${cur}"]`, (e, lab) => {
    const r = e.getBoundingClientRect();
    const l = document.querySelector(lab).getBoundingClientRect();
    return { left: r.left, right: r.right, labRight: l.right, vw: window.innerWidth };
  }, CARD+' .lab');
  ok(vis.right <= vis.vw + 1 && vis.left >= vis.labRight - 1,
    `${w}px: the current month is fully visible at rest, clear of the sticky label`);
}
await load();

// ══ 4. THE LABEL COLUMN SURVIVES THE SCROLL ════════════════════════════════
// Nineteen columns fit no screen. Without this every figure past the fold is unattributable.
const stick = await p.$$eval(CARD+' .lab', es=>[...new Set(es.map(e=>getComputedStyle(e).position))]);
ok(stick.length===1 && stick[0]==='sticky', `the label column is sticky (${stick.join(',')})`);
const before = await p.$eval(`${D('part')}[data-g="rev"] .lab`, e=>Math.round(e.getBoundingClientRect().left));
await p.$eval(CARD+' .scroll', e=>{ e.scrollLeft = 600; });
await p.waitForTimeout(120);
const after = await p.$eval(`${D('part')}[data-g="rev"] .lab`, e=>Math.round(e.getBoundingClientRect().left));
ok(Math.abs(after-before)<=1, `  and holds position through a 600px scroll (${before} → ${after})`);
const opaque = await p.$eval(`${D('part')}[data-g="rev"] .lab`, e=>getComputedStyle(e).backgroundColor);
ok(opaque!=='rgba(0, 0, 0, 0)', '  CONTROL: and is opaque, so figures do not slide under it');

// ══ 5. NO PROSE ════════════════════════════════════════════════════════════
const words = await p.$eval(CARD, e => { const c=e.cloneNode(true);
  c.querySelectorAll('table').forEach(t=>t.remove());
  return c.textContent.replace(/\s+/g,' ').trim(); });
ok(words.split(' ').filter(Boolean).length<=4, `everything outside the table is ${words.split(' ').filter(Boolean).length} words ("${words}")`);
ok(await p.$(CARD+' .bar')===null && await p.$(CARD+' .note')===null, '  CONTROL: no bars, no callout');

// ══ 6. IT DOES NOT TAKE THE PAGE ═══════════════════════════════════════════
// Ryan: "I dont want it to take up the whole membership page." Transposing bought this — the
// nineteen months are a horizontal scroll now, not nineteen rows of vertical.
for (const w of [390, 1200]){
  await load(w);
  const h = await p.$eval(CARD, e=>Math.round(e.getBoundingClientRect().height));
  ok(h<=420, `${w}px: the card is ${h}px tall, under a 420px budget`);
  ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `  ${w}px: no page scroll`);
  const g = await p.$eval(CARD+' .scroll', e=>({sw:e.scrollWidth, cw:e.clientWidth}));
  ok(g.sw>g.cw+2, `  ${w}px: the months scroll inside their own container`);
}
for (const theme of ['light','dark']){
  await load();
  await p.evaluate(t=>document.documentElement.setAttribute('data-theme',t), theme);
  await p.waitForTimeout(110);
  const c = await p.evaluate((CARD) => { const px=s=>getComputedStyle(document.querySelector(s));
    return { card:px(CARD).backgroundColor, num:px(CARD+' [data-testid="vnum"]').color,
             pct:px(CARD+' [data-testid="vpct"]').color, lab:px(CARD+' .lab').backgroundColor }; }, CARD);
  ok(c.card!=='rgba(0, 0, 0, 0)', `${theme}: the card paints its own background`);
  ok(c.num!==c.card, `  ${theme}: the figure is not the card colour`);
  ok(c.pct!==c.num, `  ${theme}: the share is recessive against it`);
  ok(c.lab===c.card, `  ${theme}: the sticky column matches the card, not a seam`);
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
