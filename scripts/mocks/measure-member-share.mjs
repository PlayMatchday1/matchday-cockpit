import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const CANDIDATES = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDIDATES.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const D = t => `[data-testid="${t}"]`;
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto(new URL('./member-share.html', import.meta.url).href); await p.waitForTimeout(150); };
const at = (tid,g,m) => p.$eval(`${D(tid)}[data-g="${g}"][data-m="${m}"]`, e=>e.textContent.trim());

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. MONTHS RUN ACROSS THE TOP ═══════════════════════════════════════════
const cols = await p.$$eval(D('mcol'), es=>es.map(e=>e.dataset.m));
ok(cols.length===19, `nineteen month columns (${cols.length})`);
ok(cols[0]==='Sep 2026', `  the current month is column 1 (${cols[0]})`);
ok(cols[cols.length-1]==='Mar 2025', `  history runs rightward to the launch month (${cols[cols.length-1]})`);
ok(new Set(cols).size===cols.length, '  CONTROL: no month repeats');
const rowsN = await p.$$eval('tbody tr', es=>es.length);
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
const sz = await p.evaluate(() => {
  const g = s => { const c = getComputedStyle(document.querySelector(s));
    return { px: parseFloat(c.fontSize), w: parseInt(c.fontWeight, 10), col: c.color }; };
  return { num:g('[data-testid="vnum"]'), pct:g('[data-testid="vpct"]'), whole:g('.t') };
});
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
ok(await at('sharec','spots','Aug 2026')==='22.7%', '  spots 1,934 of 8,520 is 22.7%');
ok(await at('sharec','players','Aug 2026')==='13.8%', '  players 441 of 3,186 is 13.8%');
const three = [srev, await at('sharec','spots','Aug 2026'), await at('sharec','players','Aug 2026')];
ok(new Set(three).size===3, `  CONTROL: the three shares differ (${three.join(' / ')}), so the rows are not wired to one source`);

// ══ 3b. THE CURRENT MONTH NEEDS NO SCROLL, AT EITHER WIDTH ═════════════════
// "I do want to start at the current month." The test is not the column ORDER, it is whether
// the figure is on screen at rest. 390px is the one that can fail.
for (const w of [390, 1200]){
  await load(w);
  const vis = await p.$eval(`${D('partc')}[data-g="rev"][data-m="Sep 2026"]`, (e, lab) => {
    const r = e.getBoundingClientRect();
    const l = document.querySelector('.lab').getBoundingClientRect();
    return { left: r.left, right: r.right, labRight: l.right, vw: window.innerWidth };
  });
  ok(vis.right <= vis.vw + 1 && vis.left >= vis.labRight - 1,
    `${w}px: the current month is fully visible at rest, clear of the sticky label`);
}
await load();

// ══ 4. THE LABEL COLUMN SURVIVES THE SCROLL ════════════════════════════════
// Nineteen columns fit no screen. Without this every figure past the fold is unattributable.
const stick = await p.$$eval('.lab', es=>[...new Set(es.map(e=>getComputedStyle(e).position))]);
ok(stick.length===1 && stick[0]==='sticky', `the label column is sticky (${stick.join(',')})`);
const before = await p.$eval(`${D('part')}[data-g="rev"] .lab`, e=>Math.round(e.getBoundingClientRect().left));
await p.$eval('.scroll', e=>{ e.scrollLeft = 600; });
await p.waitForTimeout(120);
const after = await p.$eval(`${D('part')}[data-g="rev"] .lab`, e=>Math.round(e.getBoundingClientRect().left));
ok(Math.abs(after-before)<=1, `  and holds position through a 600px scroll (${before} → ${after})`);
const opaque = await p.$eval(`${D('part')}[data-g="rev"] .lab`, e=>getComputedStyle(e).backgroundColor);
ok(opaque!=='rgba(0, 0, 0, 0)', '  CONTROL: and is opaque, so figures do not slide under it');

// ══ 5. NO PROSE ════════════════════════════════════════════════════════════
const words = await p.$eval('.card', e => { const c=e.cloneNode(true);
  c.querySelectorAll('table').forEach(t=>t.remove());
  return c.textContent.replace(/\s+/g,' ').trim(); });
ok(words.split(' ').filter(Boolean).length<=4, `everything outside the table is ${words.split(' ').filter(Boolean).length} words ("${words}")`);
ok(await p.$('.bar')===null && await p.$('.note')===null, '  CONTROL: no bars, no callout');

// ══ 6. IT DOES NOT TAKE THE PAGE ═══════════════════════════════════════════
// Ryan: "I dont want it to take up the whole membership page." Transposing bought this — the
// nineteen months are a horizontal scroll now, not nineteen rows of vertical.
for (const w of [390, 1200]){
  await load(w);
  const h = await p.$eval('.card', e=>Math.round(e.getBoundingClientRect().height));
  ok(h<=420, `${w}px: the card is ${h}px tall, under a 420px budget`);
  ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `  ${w}px: no page scroll`);
  const g = await p.$eval('.scroll', e=>({sw:e.scrollWidth, cw:e.clientWidth}));
  ok(g.sw>g.cw+2, `  ${w}px: the months scroll inside their own container`);
}
for (const theme of ['light','dark']){
  await load();
  await p.evaluate(t=>document.documentElement.setAttribute('data-theme',t), theme);
  await p.waitForTimeout(110);
  const c = await p.evaluate(() => { const px=s=>getComputedStyle(document.querySelector(s));
    return { card:px('.card').backgroundColor, num:px('[data-testid="vnum"]').color,
             pct:px('[data-testid="vpct"]').color, lab:px('.lab').backgroundColor }; });
  ok(c.card!=='rgba(0, 0, 0, 0)', `${theme}: the card paints its own background`);
  ok(c.num!==c.card, `  ${theme}: the figure is not the card colour`);
  ok(c.pct!==c.num, `  ${theme}: the share is recessive against it`);
  ok(c.lab===c.card, `  ${theme}: the sticky column matches the card, not a seam`);
}
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
