import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const CANDIDATES = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDIDATES.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto(new URL('./funnel.html', import.meta.url).href); await p.waitForTimeout(170); };
const D = t => `[data-testid="${t}"]`;
const T = t => p.$eval(D(t), e=>e.textContent.replace(/\s+/g,' ').trim());
const has = async t => (await p.$(D(t))) !== null;
const mode = async m => { await p.click(`.sw button[data-r="${m}"]`); await p.waitForTimeout(150); };
const chip = async c => { await p.click(`${D("chip")}[data-c="${c}"]`); await p.waitForTimeout(150); };
const rows = () => p.$$eval(D("ent"), es=>es.map(e=>e.dataset.n));
const cell = (row,key) => p.evaluate(({row,key}) => {
  const ns=[...document.querySelectorAll('[data-testid="ent"]')];
  const i=ns.findIndex(n=>n.dataset.n===row); if(i<0) return null;
  const cs=[...document.querySelectorAll('[data-testid="cv"]')].slice(i*5,(i+1)*5);
  const c=cs.find(x=>x.dataset.k===key); if(!c) return null;
  const f=c.querySelector('[data-testid="cvfill"]');
  return { pct:c.querySelector('[data-testid="cvv"]').textContent.trim(),
           open:!!c.querySelector('[data-testid="open"]'), na:c.classList.contains("na"),
           fill:f?Math.round(f.getBoundingClientRect().width):null,
           track:f?Math.round(f.parentElement.getBoundingClientRect().width):null,
           title:c.getAttribute("title") }; }, {row,key});

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE DROPS ARE THE CONTENT, AND THEY ARE THE BIGGEST THING ════════════
// The shipped page makes the COUNTS huge and the conversions the smallest grey text on screen.
// A funnel is about where people fall away, so the drop carries the type weight.
const sizes = await p.evaluate(() => ({
  pct: parseFloat(getComputedStyle(document.querySelector('[data-testid="cvv"]')).fontSize),
  count: parseFloat(getComputedStyle(document.querySelector('.cvn')).fontSize),
  name: parseFloat(getComputedStyle(document.querySelector('[data-testid="ent"]')).fontSize) }));
ok(sizes.pct > sizes.count * 1.4, `the drop (${sizes.pct}px) outweighs its count (${sizes.count}px)`);
ok(sizes.pct >= sizes.name, `  and is at least as loud as the row name (${sizes.name}px)`);
ok(await p.$$eval(D("cv"), es=>es.length)===20, 'five drops across four period rows');

// ══ 2. FIVE DROPS, NOT SIX COUNTS ═══════════════════════════════════════════
const ths = await p.$$eval(D("th"), es=>es.map(e=>e.textContent.replace(/\s+/g,' ').trim()));
ok(ths.length===5, `five drop columns (${ths.length})`);
ok(/Registrations\s*of downloads/.test(ths[0]), `the first is ${ths[0]}`);
ok(/1 match\s*within 30 days/.test(ths[1]), '  then 1 match within 30 days');
ok(/10 matches\s*within 180 days/.test(ths[4]), '  then 10 matches within 180 days');
ok(new Set(ths.map(t=>t.replace(/all open/,''))).size===5, '  CONTROL: five distinct headers, not one repeated');

// ══ 3. OPEN IS SELECTIVE, NOT STAMPED ON EVERY CELL ═════════════════════════
// The failure this prevents: 28 identical badges, which is noise rather than information.
ok(await has("colopen"), 'a column where every row is still open says so ONCE, in its header');
const perCell = await p.$$eval(D("open"), es=>es.length);
const allCells = await p.$$eval(D("cv"), es=>es.length);
ok(perCell>0, `${perCell} cells carry their own open badge`);
ok(perCell < allCells, `  CONTROL: not all ${allCells} of them`);
const sep = await cell("Sep 2026","m1"), aug = await cell("Aug 2026","m1");
ok(sep.open===true && aug.open===false,
  'within one column, Sep is open at 30 days and Aug is closed, so the badge varies');
const augM3 = await cell("Aug 2026","m3");
ok(augM3.open===true, 'CONTROL: and Aug is open on the 60-day stage in the same row');

// ══ 4. NO EMPTY MONTH IS DRAWN AS DATA ══════════════════════════════════════
const names = await rows();
ok(!names.some(n=>/Oct/.test(n)), 'no future month is listed');
ok(names[0]==="Sep 2026", `the first row is the real current month, ${names[0]}`);
ok(!await has("notstarted"), 'CONTROL: and the not-started treatment is not being used to pad');
const zeroCells = await p.$$eval(D("cvv"), es=>es.filter(e=>e.textContent.trim()==="0.0%").length);
ok(zeroCells===0, 'CONTROL: no row of zeroes anywhere in the period view');

// ══ 5. THE BAR IS A RATE ON ONE SCALE, SO CELLS COMPARE ACROSS ROWS ═════════
const ytd = await cell("2026 YTD","m1"), marAug = await cell("Mar – Aug","m1");
ok(ytd.fill < marAug.fill, `48.6% draws shorter than 49.8% (${ytd.fill} vs ${marAug.fill}px)`);
ok(ytd.track === marAug.track, '  CONTROL: on the same track width, so the lengths are comparable');
ok(ytd.fill>0 && ytd.fill<ytd.track, '  CONTROL: drawn, and not full, so length means something');
const tiny = await cell("Sep 2026","m3");
ok(tiny.fill>0, 'CONTROL: even 11.9% is drawn rather than vanishing');

// ══ 6. EVERY DROP CAN BE CHECKED BY HAND ════════════════════════════════════
ok(/471 of 1,405/.test(sep.title ?? ""), `the cell carries its two counts: "${sep.title}"`);
ok(sep.pct==="33.5%", `  and 471/1405 renders as ${sep.pct}`);

// ══ 7. CITIES ═══════════════════════════════════════════════════════════════
await mode("city");
ok(await p.$eval('#picker', e=>!e.hidden), 'the picker appears with cities');
const cs = await rows();
ok(cs.length===7 && cs[0]==="Austin", `seven cities, largest first (${cs[0]})`);
const dlDrop = await cell("Austin","reg");
ok(dlDrop.na===true && dlDrop.pct==="—", 'CONTROL: the downloads drop dashes on a city row');
ok(/cannot be split by city/.test(await T("foot")), '  and the footer says why');
await chip("OKC"); await chip("St. Louis");
ok((await rows()).length===5, 'deselecting two leaves five');
ok(/5 of 7 cities/.test(await T("sub")), '  and the count follows');
for (const c of ["Austin","San Antonio","Houston","Dallas","Atlanta"]) await chip(c);
ok((await rows()).length>=1, 'CONTROL: the table never empties itself');
await mode("period");
ok(await p.$eval('#picker', e=>e.hidden), 'the picker hides again with periods');
ok(await p.$eval('#picker', e=>getComputedStyle(e).display)==="none",
  '  CONTROL: actually display:none, not just the attribute losing to display:flex');

// ══ 8. NESTING: NO DROP ABOVE 100% ══════════════════════════════════════════
for (const m of ["period","city"]){
  await load(); await mode(m);
  const ns = await rows(); let n=0;
  for (const r of ns) for (const k of ["reg","m1","m3","m5","m10"]){
    const c = await cell(r,k); if (!c || c.na) continue;
    const v = parseFloat(c.pct);
    if (v > 100) ok(false, `${m} ${r} ${k}: ${c.pct} exceeds 100%`);
    n++;
  }
  ok(n>=15, `${m}: ${n} drops checked`);
  ok(true, `  ${m}: none exceeds 100%`);
}

// ══ 9. SIZES AND THEMES ═════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const m of ["period","city"]){
    await mode(m);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${m}: no page scroll`);
    const bad = await p.evaluate(() => [...document.querySelectorAll('.card, .head, .foot, .picker')]
      .filter(e => e.scrollWidth > e.clientWidth + 2).length);
    ok(bad===0, `  ${w}px ${m}: nothing outside the table overflows`);
  }
  const g = await p.$eval('.scroll', e=>({ sw:e.scrollWidth, cw:e.clientWidth }));
  ok(w===1200 ? g.sw<=g.cw+2 : g.sw>g.cw+2,
    `  ${w}px: the table ${w===1200?"fits":"scrolls in its own container"}`);
  const btns = await p.$$eval('.sw button', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(Math.min(...btns)>=32, `  ${w}px: controls are ${Math.min(...btns)}px`);
}
for (const theme of ["light","dark"]){
  await load();
  await p.evaluate(t=>document.documentElement.setAttribute("data-theme",t), theme);
  await p.waitForTimeout(120);
  const c = await p.evaluate(() => {
    const px = s => getComputedStyle(document.querySelector(s));
    return { card: px('.card').backgroundColor, ink: px('[data-testid="cvv"]').color,
             fill: px('[data-testid="cvfill"]').backgroundColor }; });
  ok(c.card!=="rgba(0, 0, 0, 0)", `${theme}: the card paints its own background`);
  ok(c.ink!==c.card, `  ${theme}: the drop figure is not the card colour`);
  ok(c.fill!==c.card, `  ${theme}: nor is the bar`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
