import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const CANDIDATES = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDIDATES.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:1000} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=1000) => { await p.setViewportSize({width:w,height:h});
  await p.goto(new URL('./membership-metrics.html', import.meta.url).href); await p.waitForTimeout(170); };
const D = t => `[data-testid="${t}"]`;
const T = t => p.$eval(D(t), e=>e.textContent.replace(/\s+/g,' ').trim());
const pick = async m => { await p.click(`.sw button[data-m="${m}"]`); await p.waitForTimeout(150); };
const pcts = () => p.$$eval(D("pct"), es=>es.map(e=>e.textContent.trim()));
const geo = () => p.$$eval(D("col"), cols => cols.map(c => {
  const s=c.querySelector('[data-testid="stack"]').getBoundingClientRect();
  const f=c.querySelector('[data-testid="fill"]').getBoundingClientRect();
  return { stack:Math.round(s.height), fill:Math.round(f.height) }; }));

// the sample data by hand, so the script does not read its expectations off the page
const AUG = { rev:[29991,89200], spots:[1920,5710], players:[451,2610] };

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE BAR IS THE TOTAL, THE FILL IS THE MEMBER PART ════════════════════
// The failure this catches: drawing membership as its own full-height bar, which makes a 34%
// share look like 100% of something and makes the three metrics incomparable.
const g = await geo();
ok(g.length===8, 'eight months are drawn');
ok(g.every(c => c.fill <= c.stack + 1), 'every fill sits inside its own bar');
ok(g.every(c => c.fill > 0), '  CONTROL: and every fill is actually drawn, not zero-height');
ok(g.every(c => c.fill < c.stack - 1), '  CONTROL: and none fills its bar completely, so the bar means the total');
const tallest = Math.max(...g.map(c=>c.stack));
ok(Math.abs(g[6].stack - tallest) <= 1, 'the tallest bar is Aug, the biggest total month');
ok(g[7].stack < g[6].stack, '  CONTROL: Sep is shorter, because it is 17 of 30 days');

// ══ 2. THE PERCENTAGES ARE THE MEMBER SHARE, AND THEY DIFFER BY METRIC ══════
const revPct = await pcts();
ok(revPct.length===8, 'a percentage on every month');
ok(revPct[6]==="34%", `Aug revenue share reads ${revPct[6]}`);
await pick("spots");
const spotPct = await pcts();
ok(spotPct[6]==="34%", `Aug spots share reads ${spotPct[6]}`);
await pick("players");
const playPct = await pcts();
ok(playPct[6]==="17%", `Aug players share reads ${playPct[6]}`);
ok(playPct.join()!==revPct.join(), 'CONTROL: the three metrics are NOT the same series relabelled');
ok(Number(playPct[6].replace('%','')) * 2 <= Number(spotPct[6].replace('%','')) + 1,
  'and the players share is about half the spots share, which is the whole finding');

// ══ 3. THE READOUT NAMES BOTH NUMBERS, NOT JUST THE RATIO ═══════════════════
await pick("rev");
const r = await T("readout");
ok(/\$29,991/.test(r), `the readout gives the numerator: "${r.slice(0,52)}…"`);
ok(/\$89,200/.test(r), '  and the denominator');
ok(/33\.6%|34\.0%|33\.\d%/.test(r), '  and the share to one decimal');
ok(/17 of 30 days/.test(r), '  and says why Sep is short');
await pick("players");
const r2 = await T("readout");
ok(/451/.test(r2) && /2,610/.test(r2), 'CONTROL: the readout follows the metric, it is not fixed copy');

// ══ 4. THE PARTIAL MONTH IS MARKED, NOT JUST SHORTER ════════════════════════
const marked = await p.$$eval(D("col"), es=>es.map(e=>e.className.includes("part")));
ok(marked.filter(Boolean).length===1, 'exactly one month is flagged partial');
ok(marked[7]===true, '  and it is the last one');
const fillBg = await p.evaluate(() => [
  getComputedStyle(document.querySelector('[data-testid="col"][data-i="6"] [data-testid="fill"]')).backgroundImage,
  getComputedStyle(document.querySelector('[data-testid="col"][data-i="7"] [data-testid="fill"]')).backgroundImage ]);
ok(fillBg[0]!==fillBg[1], 'CONTROL: it is drawn differently, not only labelled');
ok(/repeating-linear-gradient/.test(fillBg[1]), '  with a hatch');

// ══ 5. ALL THREE SHARES VISIBLE WITHOUT TOGGLING ════════════════════════════
const th = await p.$$eval(D("th"), es=>es.map(e=>({
  k:e.dataset.k, pct:e.querySelector('[data-testid="th-pct"]').textContent.trim(),
  d:e.querySelector('.d').textContent.replace(/\s+/g,' ').trim() })));
ok(th.length===3, 'the three shares are on screen together');
ok(th.map(x=>x.k).join()==="rev,spots,players", '  in the order of the toggle');
ok(new Set(th.map(x=>x.pct)).size>=2, 'CONTROL: they are not all the same number');
ok(th.every(x=>/\d/.test(x.d)), 'each carries its own two figures, not just a percentage');
ok(/2\.6x as often/.test(await T("gap")), 'and the gap between players and spots is explained');

// ══ 6. THE TWO LIFETIME NUMBERS, WITH THEIR ARITHMETIC ══════════════════════
// The point of the card: these answer different questions and must never be one tile.
const rpm = await T("rpm"), ltv = await T("ltv");
ok(rpm==="$170.90", `revenue per member per year: ${rpm}`);
ok(ltv==="$365.38", `LTV: ${ltv}`);
ok(parseFloat(ltv.slice(1).replace(/,/g,"")) > parseFloat(rpm.slice(1).replace(/,/g,"")) * 2,
  'CONTROL: LTV is more than double the annual figure, which is why they cannot share a tile');
const w1 = await T("rpm-work"), w2 = await T("ltv-work");
ok(/201,666/.test(w1) && /1,180 unique members/.test(w1), `the annual workings are printed: "${w1}"`);
ok(/66\.50/.test(w2) && /18\.2% monthly churn/.test(w2), '  and so are the LTV workings');
ok(/82 of 451/.test(w2), '  including the churn count the rate came from');
ok(/5\.5 months/.test(w2), '  and the implied lifetime');
ok(/6th-to-6th/.test(await T("basis")), 'the churn window is named, because the lifetime moves with it');
ok(/never a residual/.test(await T("basis")), '  and the revenue is stated as an explicit category');

// ══ 7. SIZES ════════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const m of ['rev','spots','players']){
    await pick(m);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${m}: no horizontal scroll`);
    const bad = await p.evaluate(() => [...document.querySelectorAll('.mscard, .th, .lt, .tile, .work, .readout')]
      .filter(e => e.scrollWidth > e.clientWidth + 2).length);
    ok(bad===0, `  ${w}px ${m}: nothing overflows its own box`);
    const cols = await p.$$eval(D("col"), es=>es.map(e=>Math.round(e.getBoundingClientRect().width)));
    ok(cols.length===8 && Math.min(...cols)>=14,
      `  ${w}px ${m}: the narrowest column is ${Math.min(...cols)}px, wide enough to read`);
  }
  const btns = await p.$$eval('.sw button', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(btns.length===3 && Math.min(...btns)>=32, `  ${w}px: every toggle is ${Math.min(...btns)}px`);
  const vals = await p.$$eval('.lt .v, .th .v', es=>es.map(e=>Math.round(e.getBoundingClientRect().width)));
  ok(vals.length===5 && Math.min(...vals)>0, `  ${w}px: (${vals.length} headline figures rendered)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
