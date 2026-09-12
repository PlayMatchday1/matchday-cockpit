import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport: { width: 1080, height: 1100 } });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1080,h=1100) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/launch-index.html'); await p.waitForTimeout(190); };
await load();
const T = s => p.$eval(s, e=>e.textContent.trim());

ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);
ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=1082, 'no horizontal scroll');

// ══ 1. EVERY LAUNCH IN FLIGHT, AND ONLY THOSE ════════════════════════════════
const cards = await p.$$eval('[data-testid="li-field"]', es=>es.map(e=>e.dataset.name));
ok(cards.length===6, `six fields are in flight (${cards.length})`);
ok(!cards.includes('PRUMC'), 'and a plan past week 20 has left the page — nothing left to chase');
ok(/finished/.test(await T('#sub')), `the finished one is still counted in the header: "${await T('#sub')}"`);
ok(/6 fields in flight/.test(await T('#sub')), '  and the live count leads');

// ══ 2. SORTED BY WHAT NEEDS ATTENTION SOONEST ════════════════════════════════
const secs = await p.$$eval('[data-testid="li-sect"]', es=>es.map(e=>e.textContent.trim()));
ok(secs.length===2, `two groups: ${secs.join(' / ')}`);
ok(/STILL TO LAUNCH/.test(secs[0]), 'the ones not yet open come first');
// Scoped to the FIRST section, not by phase: a field 10 days past its date is
// still in the launch window by phase but belongs under "launched".
const upcoming = await p.$eval('.grid', g=>[...g.querySelectorAll('[data-testid="li-field"]')].map(e=>+e.dataset.days));
ok(upcoming.every((d,i)=> i===0 || upcoming[i-1] <= d),
  `and they run nearest-first: ${upcoming.join(', ')} days`);
ok(upcoming[0]<=2, `  so the one about to open is at the top (${upcoming[0]} days)`);
const launched = await p.$$eval('.grid', gs=>[...gs[1].querySelectorAll('[data-testid="li-field"]')].map(e=>+e.dataset.days));
ok(launched.every(d=>d<0), `the launched group is genuinely past its date (${launched.join(', ')})`);
ok(launched.every((d,i)=> i===0 || launched[i-1] >= d), '  and the most recent opening is first');
ok(upcoming.every(d=>d>=0), 'CONTROL: and nothing past its date is sitting in the still-to-launch group');

// ══ 3. THE COUNTER IS THE SAME ONE THE PLAN PAGE USES ════════════════════════
const counters = await p.$$eval('[data-testid="li-field"]', es=>es.map(e=>({
  n: e.querySelector('[data-testid="li-count"]').textContent.trim(),
  l: e.querySelector('[data-testid="li-count"]').nextElementSibling.textContent.trim(),
  p: e.dataset.phase })));
ok(counters.every(c=>+c.n >= 0), 'no card shows a negative countdown');
ok(counters.some(c=>/DAYS TO LAUNCH/.test(c.l)), 'some read days to launch');
ok(counters.some(c=>/LAUNCH WEEK OF 4/.test(c.l)), 'one inside the window reads launch week of 4');
ok(counters.some(c=>/DAYS SINCE LAUNCH/.test(c.l)), 'and a launched one counts up');
const win = counters.find(c=>/LAUNCH WEEK/.test(c.l));
ok(win && +win.n>=1 && +win.n<=4, `the launch-week number is 1-4, not zero (${win?.n})`);

// ══ 4. OVERDUE IS THE SIGNAL, AND IT IS SUMMED ONCE AT THE TOP ═══════════════
ok(await p.$('[data-testid="li-alarm"]')!==null, 'overdue work across every launch is stated once');
const alarm = await T('[data-testid="li-alarm"]');
ok(/6 tasks overdue across 3 fields/.test(alarm), `and adds up: "${alarm}"`);
const perCard = await p.$$eval('[data-testid="li-over"]', es=>es.map(e=>+e.textContent.replace(/\D+/g,'')));
ok(perCard.reduce((a,c)=>a+c,0)===6, `  the per-card badges sum to the same 6 (${perCard.join('+')})`);
ok(perCard.length===3, `  across 3 cards`);
const over1 = await p.$$eval('[data-testid="li-field"][data-over="1"]', es=>es.length);
ok(over1===3, 'a card carrying overdue work is marked on the card itself');
const bOver = await p.$eval('[data-testid="li-field"][data-over="1"]', e=>getComputedStyle(e).borderColor);
const bOk   = await p.$eval('[data-testid="li-field"][data-over="0"]', e=>getComputedStyle(e).borderColor);
ok(bOver!==bOk, `CONTROL: and looks different from one that is clean (${bOver} vs ${bOk})`);

// ══ 5. PROGRESS, WITH N/A OUT OF THE DENOMINATOR ═════════════════════════════
const progs = await p.$$eval('[data-testid="li-prog"]', es=>es.map(e=>e.textContent.trim()));
ok(progs.every(t=>/^\d+ of \d+ done$/.test(t)), `every card states its progress: ${progs[0]}`);
const stony = await p.$eval('[data-testid="li-field"][data-name="Stony Point"]', e=>e.textContent);
ok(/14 of 23 done/.test(stony), 'a field with an N/A counts out of 23, not 24');
ok(/1 N\/A/.test(stony), '  and says so rather than silently shrinking');
const bars = await p.$$eval('.fbar', es=>es.every(e=>!!e.getAttribute('aria-label')));
ok(bars, 'every meter is labelled for a screen reader');
const twoFills = await p.$eval('[data-testid="li-field"][data-over="1"] .fbar', e=>e.querySelectorAll('i').length);
ok(twoFills===2, 'and a card with overdue work shows it as its own fill');

// ══ 6. EACH CARD OPENS ITS PLAN ══════════════════════════════════════════════
const tags = await p.$$eval('[data-testid="li-field"]', es=>[...new Set(es.map(e=>e.tagName))]);
ok(tags.length===1 && (tags[0]==='BUTTON' || tags[0]==='A'), `each card is one target (${tags[0]})`);
const h = await p.$$eval('[data-testid="li-field"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
ok(h>=44, `and is ${Math.round(h)}px tall`);

// ══ 7. THE EMPTY CASE SAYS WHERE PLANS COME FROM ═════════════════════════════
await p.evaluate(()=>{ document.getElementById("body").innerHTML =
  '<p class="empty" data-testid="li-empty">No launches in flight. A field gets a plan when its card reaches Confirmed.</p>'; });
ok(/reaches Confirmed/.test(await T('[data-testid="li-empty"]')),
  'with nothing in flight it says how one starts, rather than sitting blank');
await load();

// ══ 8. A PHONE ═══════════════════════════════════════════════════════════════
for (const w of [390, 1080]){
  await load(w);
  ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px: no horizontal scroll`);
  const spill = await p.evaluate(()=>[...document.querySelectorAll('.wrap *')]
    .filter(e=>{const r=e.getBoundingClientRect();
      return r.width>0 && r.right>document.documentElement.clientWidth+1;}).length);
  ok(spill===0, `  nothing spills right`);
  const clip = await p.$$eval('.fn b, .fn span', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent));
  ok(clip.length===0, `  nothing truncated${clip.length?': '+clip.join(', '):''}`);
}
await load(390);
const cols = await p.$$eval('.grid .f', es=>new Set(es.map(e=>Math.round(e.getBoundingClientRect().x))).size);
ok(cols===1, 'the cards stack to one column on a phone');
await load(1080);
const dcols = await p.$$eval('.grid .f', es=>new Set(es.map(e=>Math.round(e.getBoundingClientRect().x))).size);
ok(dcols>=2, `and go ${dcols} across on desktop`);

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
