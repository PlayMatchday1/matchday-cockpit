import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport: { width: 980, height: 1100 } });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=980,h=1100) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/launch-plan.html'); await p.waitForTimeout(190); };
await load();
const T = s => p.$eval(s, e=>e.textContent.trim());
const R = s => p.$eval(s, e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,b:r.bottom,r:r.right};});

ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);
ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=982, 'no horizontal scroll');

// ══ 1. THE THREE COUNTERS RYAN ASKED FOR ═════════════════════════════════════
// "a days till launch and launch and post launch counter type thing"
ok(await T('[data-testid="lp-count"]')==='27', `the countdown is the hero number: ${await T('[data-testid="lp-count"]')}`);
ok(/DAYS TO LAUNCH/.test(await T('[data-testid="lp-countlabel"]')), 'labelled as days to launch');
ok(/Oct/.test(await T('[data-testid="lp-date"]')), `with the date under it: "${await T('[data-testid="lp-date"]')}"`);
ok(/BUILD-UP/.test(await T('[data-testid="lp-phase"]')), 'and the phase named');
// The SAME hero answers all three of Ryan's questions. Drive it to each for real.
const go = async w => { await p.click(`.sw button[data-w="${w}"]`); await p.waitForTimeout(140); };
await go('win');
ok(await T('[data-testid="lp-count"]')==='2' && /LAUNCH WEEK OF 4/.test(await T('[data-testid="lp-countlabel"]')),
  'inside the window it reads "launch week 2 of 4", never a negative countdown');
ok(/LAUNCH WINDOW/.test(await T('[data-testid="lp-phase"]')), '  and the phase follows');
await go('post');
ok(await T('[data-testid="lp-count"]')==='53' && /DAYS SINCE LAUNCH/.test(await T('[data-testid="lp-countlabel"]')),
  'after the window it counts up: 53 days since launch');
ok(/SUSTAIN/.test(await T('[data-testid="lp-phase"]')), '  and the phase follows again');
await go('pre');
ok(await T('[data-testid="lp-count"]')==='27', 'CONTROL: and back to the countdown');

// ══ 2. PROGRESS, AND OVERDUE AS ITS OWN FACT ═════════════════════════════════
ok(/5 of 24 done/.test(await T('[data-testid="lp-done"]')), `progress is stated: "${await T('[data-testid="lp-done"]')}"`);
// Nothing can be late in week 1, and the page does not invent an alarm.
ok(await p.$('[data-testid="lp-overdue"]')===null, 'in week 1 nothing is overdue, and nothing pretends to be');
await go('win');
ok(await p.$('[data-testid="lp-overdue"]')!==null, 'once windows have closed, overdue is called out separately');
ok(/5 overdue/.test(await T('[data-testid="lp-overdue"]')), `  "${await T('[data-testid="lp-overdue"]')}"`);
await go('post');
ok(/12 overdue/.test(await T('[data-testid="lp-overdue"]')), '  and it grows as more windows close (12)');
await go('win');
const bar = await p.$$eval('.bar i', es=>es.map(e=>({c:e.className, w:e.getBoundingClientRect().width})));
ok(bar.length===2, 'the meter carries both done and overdue as separate fills');
ok(bar.every(x=>x.w>0), '  both with real width');
const gap = await p.$eval('.bar', e=>getComputedStyle(e).gap);
ok(parseFloat(gap)>=2, `and a ${gap} surface gap between them, so they do not read as one block`);
ok(await p.$eval('.bar', e=>!!e.getAttribute('aria-label')), 'the meter is labelled for a screen reader');

// ══ 3. THE TIMELINE ══════════════════════════════════════════════════════════
const wks = await p.$$eval('.wk', es=>es.length);
ok(wks===20, `twenty weeks, one cell each (${wks})`);
const today = await p.$$eval('.wk[data-today="1"]', es=>es.map(e=>e.dataset.w));
ok(today.length===1 && today[0]==='6', `today is marked, once, on week ${today[0]}`);
await go('pre');
ok((await p.$$eval('.wk[data-today="1"]', es=>es.map(e=>e.dataset.w)))[0]==='1',
  'CONTROL: and it moves with the date — week 1 before launch');
await go('win');
const phases = await p.$$eval('.wk', es=>es.map(e=>e.dataset.ph));
ok(phases.slice(0,4).every(x=>x==='pre') && phases.slice(4,8).every(x=>x==='launch')
   && phases.slice(8).every(x=>x==='post'),
  'weeks 1-4 build-up, 5-8 the launch window, 9-20 sustain — the sheet\'s own bands');
// The bars encode how much is running, so they must actually vary and peak at launch.
const hs = await p.$$eval('.wk i', es=>es.map(e=>e.getBoundingClientRect().height));
ok(new Set(hs.map(h=>Math.round(h))).size>=4, `the week bars vary (${new Set(hs.map(h=>Math.round(h))).size} distinct heights)`);
const peak = hs.indexOf(Math.max(...hs)) + 1;
ok(peak>=5 && peak<=8, `and they peak inside the launch window (week ${peak})`);
ok(hs[19] < Math.max(...hs), 'CONTROL: the last week is not the peak — the shape is real, not flat');
const bandN = await p.$$eval('[data-testid="lp-band"]', es=>es.length);
ok(bandN===3, 'the three phases are named under the strip');
const gaps = await p.$eval('.weeks', e=>getComputedStyle(e).gap);
ok(parseFloat(gaps)>=2, `with a ${gaps} gap between marks`);

// ══ 4. STATUS IS NEVER COLOUR ALONE ══════════════════════════════════════════
const states = await p.$$eval('[data-testid="lp-state"]', es=>es.map(e=>e.textContent.trim()));
ok(states.length>0, `every task carries a written state (${states.length})`);
ok(states.every(s=>/OVERDUE|DUE NOW|DONE|NOT YET/.test(s)), '  in words, not only a colour');
// Open every phase so identity and state are measured across all 23, not one band.
const openAll = async () => { for (const k of ['pre','launch','post']){
  const isOpen = await p.$eval(`[data-phase="${k}"]`, e=>e.dataset.open==='1');
  if (!isOpen) { await p.click(`[data-phase="${k}"] .gh`); await p.waitForTimeout(110); } } };
const shownTasks = () => p.$$eval('[data-testid="lp-task"]', es=>es.filter(e=>e.offsetParent!==null).length);
await openAll();
ok(await shownTasks()===24, `with every phase open, all 24 tasks are on screen (${await shownTasks()})`);
const distinct = await p.$$eval('[data-testid="lp-state"]',
  es=>[...new Set(es.filter(e=>e.offsetParent!==null).map(e=>getComputedStyle(e).color))].length);
ok(distinct>=3, `and the states are distinguishable by colour too (${distinct})`);
// SCOPE IS NOT COLOUR-ENCODED, and that is the cut the validator demanded.
// Seven hues cannot separate under --pairs all: green↔orange ΔE 3.2 (protan),
// pink↔orange ΔE 12.9 (normal). The dot carried nothing the label did not.
ok(await p.$('.t .dot')===null, 'scope carries no colour dot — seven hues cannot be told apart');
const scopes = await p.$$eval('.scope', es=>[...new Set(es.filter(e=>e.offsetParent!==null)
  .map(e=>e.textContent.trim()))]);
ok(scopes.length===7, `all seven scopes are named in words (${scopes.length})`);
ok(scopes.includes('Ops'), '  including the new Ops scope');
const scopeInk = await p.$$eval('.scope', es=>[...new Set(es.map(e=>getComputedStyle(e).color))].length);
ok(scopeInk===1, 'CONTROL: every scope chip wears the same ink — no text in a series colour');

// ══ 5. ASSIGNMENT ════════════════════════════════════════════════════════════
const owners = await p.$$eval('[data-testid="lp-owner"]', es=>es.map(e=>e.dataset.unassigned));
ok(owners.length>0, `every task has an owner control (${owners.length})`);
ok(owners.includes('1'), 'an unassigned task is possible');
const unass = await T('[data-testid="lp-owner"][data-unassigned="1"]');
ok(/Assign/.test(unass), `  and says so rather than sitting blank: "${unass}"`);
const oStyle = await p.$$eval('[data-testid="lp-owner"]', es=>{
  const a=es.find(e=>e.dataset.unassigned==='1'), b=es.find(e=>e.dataset.unassigned==='0');
  return [getComputedStyle(a).borderStyle, getComputedStyle(b).borderStyle]; });
ok(oStyle[0]!==oStyle[1], `CONTROL: assigned and unassigned look different (${oStyle.join(' vs ')})`);
const oh = await p.$$eval('[data-testid="lp-owner"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
ok(oh>=26, `and the control is ${Math.round(oh)}px — pressable`);

// ══ 6. THE CURRENT PHASE IS THE ONE THAT IS OPEN ═════════════════════════════
await load(); await go('win');   // fresh, after the open-everything pass above
const open = await p.$$eval('[data-testid="lp-group"]', es=>es.filter(e=>e.dataset.open==='1').map(e=>e.dataset.phase));
ok(open.length===1 && open[0]==='launch', `only the phase you are in is open (${open[0]})`);
await go('pre');
ok((await p.$$eval('[data-testid="lp-group"][data-open="1"]', es=>es.map(e=>e.dataset.phase)))[0]==='pre',
  'CONTROL: which phase that is follows the date');
await go('win');
const counts = await p.$$eval('[data-testid="lp-groupcount"]', es=>es.map(e=>e.textContent.trim()));
ok(counts.length===3, 'every phase shows its own progress even when collapsed');
ok(counts.some(c=>/overdue/.test(c)), `  and names its overdue count: "${counts.find(c=>/overdue/.test(c))}"`);
const tasksShown = await shownTasks();
ok(tasksShown>0 && tasksShown<24, `only that phase's tasks are on screen (${tasksShown} of 24)`);
// Collapsing and opening is real. Open a phase that is currently closed.
await p.click('[data-phase="pre"] .gh'); await p.waitForTimeout(140);
ok(await p.$$eval('[data-testid="lp-group"][data-open="1"]', es=>es.length)===2, 'another phase can be opened alongside');
await p.click('[data-phase="pre"] .gh'); await p.waitForTimeout(140);
ok(await p.$$eval('[data-testid="lp-group"][data-open="1"]', es=>es.length)===1, 'and closed again');
// WHICH PHASES ARE OPEN SURVIVES AN EDIT. It was derived from the current week,
// so every tick, N/A or add slammed the groups shut under whoever was working.
await p.click('[data-phase="post"] .gh'); await p.waitForTimeout(140);
const openedBefore = await p.$$eval('[data-testid="lp-group"][data-open="1"]', es=>es.map(e=>e.dataset.phase).sort());
await p.click('[data-phase="post"] [data-testid="lp-na"]'); await p.waitForTimeout(160);
const openedAfter = await p.$$eval('[data-testid="lp-group"][data-open="1"]', es=>es.map(e=>e.dataset.phase).sort());
ok(JSON.stringify(openedBefore)===JSON.stringify(openedAfter),
  `an edit leaves the groups as the operator left them (${openedAfter.join(', ')})`);
await p.click('[data-phase="post"] [data-testid="lp-na"]'); await p.waitForTimeout(160);

// ══ 7. EVERY TASK FROM THE PLAYBOOK IS ACCOUNTED FOR ═════════════════════════
const all = await p.evaluate(()=>{
  const out=[]; document.querySelectorAll('[data-testid="lp-group"]').forEach(g=>{});
  return null; });
const totals = await p.$$eval('[data-testid="lp-groupcount"]', es=>es.map(e=>+e.textContent.trim().split('/')[1].split(' ')[0]));
ok(totals.reduce((a,c)=>a+c,0)===24, `the three phases hold all 24 tasks (${totals.join(' + ')})`);
// THE SPLIT HAS TO SPLIT SOMETHING. Grouping on the start week put 18 of 23 into
// Build-up and left Sustain empty; three phases that do not divide the work are
// three headings.
ok(totals.every(n=>n>0), `and no phase is empty (${totals.join(' / ')})`);
ok(Math.max(...totals) <= 12, `  nor does one phase swallow the plan (biggest is ${Math.max(...totals)})`);
// Within a group, anything late or live sorts above anything not.
await openAll();
const order = await p.$eval('[data-phase="launch"] .glist', e=>
  [...e.querySelectorAll('[data-testid="lp-task"]')].map(t=>t.dataset.state));
const rank = {over:0, now:1, soon:2, done:3};
ok(order.every((s,i)=> i===0 || rank[order[i-1]] <= rank[s]),
  `late and live tasks sort above the rest: ${order.join(' → ')}`);

// ══ 7b. N/A FOR A FIELD, AND ADD/REMOVE FOR A CITY'S OWN ═════════════════════
// Ryan: "we need to be able to add and remove tasks because some will have
// specific ones for the city" then "or maybe just mark some as N/A for a field".
// Both, split by origin: a playbook task is marked N/A (the record of skipping it
// survives and it can come back); only a task somebody ADDED can be removed.
await load(); await openAll();
const TPL = () => p.evaluate(()=>window.TEMPLATE.length);
ok(await TPL()===24, 'the playbook template holds 24 tasks');
ok(await p.$$eval('[data-testid="lp-na"]', es=>es.length)===24, 'every playbook task offers N/A');
ok(await p.$('[data-testid="lp-remove"]')===null, 'CONTROL: and none of them offers Remove');

const T2 = s => p.$eval(s, e=>e.textContent.trim());
const doneLine = () => T2('[data-testid="lp-done"]');
ok(/of 24 done/.test(await doneLine()), `the denominator starts at 24: "${await doneLine()}"`);
const actBefore = await p.$$eval('.wk i', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
await p.click('[data-testid="lp-na"]'); await p.waitForTimeout(160);
ok(/of 23 done/.test(await doneLine()), `marking one N/A drops the denominator: "${await doneLine()}"`);
ok(/1 N\/A/.test(await T2('.pline')), `  and says how many are N/A rather than hiding it: "${await T2('.pmut')}"`);
ok(await p.$$eval('[data-testid="lp-task"]', es=>es.length)===24,
  'the task is still on the page — N/A is not deletion');
const naRow = await p.$('[data-testid="lp-task"][data-state="na"]');
ok(naRow!==null, 'and it reads as N/A');
const naDeco = await p.$eval('[data-testid="lp-task"][data-state="na"] .tt',
  e=>getComputedStyle(e).textDecorationLine);
ok(naDeco.includes('line-through'), `  struck through, not just faint (${naDeco})`);
const actAfter = await p.$$eval('.wk i', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
ok(JSON.stringify(actBefore)!==JSON.stringify(actAfter), 'the timeline stops counting it too');
ok(await TPL()===24, 'CONTROL: and the template is untouched');
// It comes back.
await p.click('[data-testid="lp-task"][data-state="na"] [data-testid="lp-na"]'); await p.waitForTimeout(160);
ok(/of 24 done/.test(await doneLine()), 'putting it back restores the denominator');
ok(await p.$('[data-testid="lp-task"][data-state="na"]')===null, '  and it is a normal task again');

// Adding a task for this city.
await p.click('[data-testid="lp-add"]'); await p.waitForTimeout(160);
ok(await p.$('[data-testid="lp-adddlg"]')!==null, 'a task can be added for this field');
ok(/this field/i.test(await T2('[data-testid="lp-adddlg"] .dh')), '  and it says the plan, not the playbook, is what changes');
ok(await p.$eval('[data-testid="lp-add-save"]', e=>e.disabled), 'with no title and no weeks it cannot be saved');
await p.fill('[data-testid="lp-add-title"]', 'Get the HOA notice posted at the gate'); await p.waitForTimeout(140);
await p.fill('[data-testid="lp-add-w1"]', '9'); await p.waitForTimeout(120);
await p.fill('[data-testid="lp-add-w2"]', '3'); await p.waitForTimeout(140);
ok(await p.$('[data-testid="lp-add-badweek"]')!==null, 'an end week before the start is refused with the reason');
ok(await p.$eval('[data-testid="lp-add-save"]', e=>e.disabled), '  and cannot be saved');
await p.fill('[data-testid="lp-add-w2"]', '11'); await p.waitForTimeout(140);
ok(await p.$('[data-testid="lp-add-lands"]')!==null, 'a valid range says which phase it lands in');
ok(/Sustain/.test(await T2('[data-testid="lp-add-lands"]')), `  from its deadline: "${await T2('[data-testid="lp-add-lands"]')}"`);
await p.click('[data-testid="lp-add-save"]'); await p.waitForTimeout(180);
await openAll();
ok(/of 25 done/.test(await doneLine()), `the added task counts: "${await doneLine()}"`);
ok(await TPL()===24, 'CONTROL: and the template STILL holds 24 — the next field does not inherit it');
const custom = await p.$$eval('[data-testid="lp-custom"]', es=>es.length);
ok(custom===1, 'it is marked as added here, so nobody mistakes it for playbook');
const inPost = await p.$eval('[data-phase="post"] .glist', e=>
  !!e.querySelector('[data-testid="lp-custom"]'));
ok(inPost, 'and it sits in Sustain, where its deadline put it');

// Only the added one can be removed, and removal asks first.
ok(await p.$$eval('[data-testid="lp-remove"]', es=>es.length)===1, 'exactly one task offers Remove');
await p.click('[data-testid="lp-remove"]'); await p.waitForTimeout(160);
ok(await p.$('[data-testid="lp-rmconfirm"]')!==null, 'removing asks first rather than acting on one tap');
await p.click('[data-testid="lp-rm-no"]'); await p.waitForTimeout(160);
ok(/of 25 done/.test(await doneLine()), 'CONTROL: Keep it leaves the task alone');
await p.click('[data-testid="lp-remove"]'); await p.waitForTimeout(160);
await p.click('[data-testid="lp-rm-yes"]'); await p.waitForTimeout(180);
ok(/of 24 done/.test(await doneLine()), `and Remove takes it out: "${await doneLine()}"`);
ok(await p.$('[data-testid="lp-custom"]')===null, '  with nothing left behind');
ok(await TPL()===24, 'the template survived every one of those operations');

// ══ 7c. GETTING BACK, AND GETTING SIDEWAYS ═══════════════════════════════════
// A plan you can only reach from a kanban board is a plan you stop opening.
await load();
ok(await p.$('[data-testid="lp-back"]')!==null, 'there is a way back to all launches');
ok(/All launches/.test(await T('[data-testid="lp-back"]')), `  and it says where it goes: "${await T('[data-testid="lp-back"]')}"`);
const sw = await p.$$eval('[data-testid="lp-fieldswitch"] option', es=>es.map(e=>e.textContent.trim()));
ok(sw.length>=4, `and a switcher listing the other plans (${sw.length})`);
ok(sw.every(o=>/\d+d (to launch|since)/.test(o)),
  `each carrying its own countdown, so you can pick by urgency: "${sw[0]}"`);
const sel = await p.$eval('[data-testid="lp-fieldswitch"]', e=>e.options[e.selectedIndex].textContent.trim());
ok(/Crossbar Rowlett/.test(sel), `the plan you are on is the one selected: "${sel}"`);
const swd = sw.map(o=>{ const m=/(\d+)d (to launch|since)/.exec(o); return m[2]==='since' ? -(+m[1]) : +m[1]; });
const up = swd.filter(d=>d>=0);
ok(up.every((d,i)=> i===0 || up[i-1] <= d), `and they are ordered nearest-launch-first: ${swd.join(', ')}`);
const swH = await p.$eval('[data-testid="lp-fieldswitch"]', e=>e.getBoundingClientRect().height);
ok(swH>=36, `the switcher is ${Math.round(swH)}px`);
const bkH = await p.$eval('[data-testid="lp-back"]', e=>e.getBoundingClientRect().height);
ok(bkH>=36, `and the back control is ${Math.round(bkH)}px`);

// ══ 8. A PHONE ═══════════════════════════════════════════════════════════════
for (const w of [390, 980]){
  await load(w);
  ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px: no horizontal scroll`);
  const spill = await p.evaluate(()=>[...document.querySelectorAll('.wrap *')]
    .filter(e=>{const r=e.getBoundingClientRect();
      return r.width>0 && r.right>document.documentElement.clientWidth+1;}).length);
  ok(spill===0, `  nothing spills right`);
  const cn = await R('[data-testid="lp-count"]');
  ok(cn.h>=40, `  the countdown is still the biggest thing on screen (${Math.round(cn.h)}px)`);
  const gh = await p.$$eval('.gh', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(gh>=44, `  the phase headers are ${Math.round(gh)}px`);
  const tk = await p.$$eval('.tick', es=>Math.min(...es.filter(e=>e.offsetParent!==null)
    .map(e=>e.getBoundingClientRect().height)));
  ok(tk>=22, `  the tickboxes are ${Math.round(tk)}px`);
}
await load(390);
const wk = await R('.weeks');
ok(wk.w<=374, `the 20-week strip fits the phone (${Math.round(wk.w)}px) rather than scrolling`);
// The bands truncated to "BUILD-..." at 390 before the short labels went in.
const bandClip = await p.$$eval('[data-testid="lp-band"]',
  es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.trim()));
ok(bandClip.length===0, `no phase band is cut off at 390${bandClip.length?': '+bandClip.join(', '):''}`);
const bandTxt = await p.$$eval('[data-testid="lp-band"]', es=>es.map(e=>e.innerText.trim()));
ok(bandTxt.every(t=>/W\d+–\d+/.test(t)), `and each still carries its week range: ${bandTxt.join(' / ')}`);
await load(980);
const bandWide = await p.$$eval('[data-testid="lp-band"]', es=>es.map(e=>e.innerText.trim()));
ok(bandWide.some(t=>/BUILD-UP/.test(t)), `CONTROL: the full label comes back when there is room: "${bandWide[0]}"`);
await load(390);
const heroOrder = await p.evaluate(()=>{
  const c=document.querySelector('[data-testid="lp-count"]').getBoundingClientRect();
  const t=document.querySelector('[data-testid="lp-weeks"]').getBoundingClientRect();
  const g=document.querySelector('[data-testid="lp-group"]').getBoundingClientRect();
  return c.bottom<=t.top+1 && t.bottom<=g.top+1; });
ok(heroOrder, 'countdown, then the timeline, then the tasks — in that order down the page');

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
