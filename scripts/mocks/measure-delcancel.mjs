import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/delete-cancelled.html'); await p.waitForTimeout(170); };
const D = t => `[data-testid="${t}"]`;
const T = t => p.$eval(D(t), e=>e.textContent.replace(/\s+/g,' ').trim());
const has = async t => (await p.$(D(t))) !== null;
const vis = async t => { const e = await p.$(D(t)); return e ? await e.isVisible() : false; };
const scen = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(150); };
const chip = id => `${D("chip")}[data-id="${id}"]`;
const pick = async id => { await p.click(chip(id)); await p.waitForTimeout(150); };
const CX = 18603;           // the match the scenario switch edits
const OTHER_CX = 18605;     // a second cancelled match, the control for "only that one went"

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE CANCELLED MATCH IS FINDABLE, AND THE TOGGLE IS WHAT FINDS IT ══════
ok(await T("counts")==="8 matches · 2 cancelled", `the counts are on screen: "${await T("counts")}"`);
ok(await has("chip"), 'the grid has matches');
const cxBg = await p.$eval(chip(CX), e=>getComputedStyle(e).backgroundColor);
const liveBg = await p.$eval(chip(18601), e=>getComputedStyle(e).backgroundColor);
ok(cxBg!==liveBg, `a cancelled match looks different from a live one (${cxBg} vs ${liveBg})`);
ok((await p.$eval(chip(CX), e=>getComputedStyle(e).textDecorationLine)).includes("line-through"),
  '  and is struck through, so colour is not the only signal');

await p.click(D("showcx")); await p.waitForTimeout(150);
ok(await p.$(chip(CX))===null, 'turning the toggle off hides the cancelled matches');
ok(await p.$(chip(18601))!==null, '  CONTROL: the live ones stay');
ok(await T("counts")==="8 matches · 2 cancelled", '  CONTROL: and the counts do NOT move, because nothing was deleted');
await p.click(D("showcx")); await p.waitForTimeout(150);
ok(await p.$(chip(CX))!==null, 'and back on again');

// ══ 2. A LIVE MATCH HAS NO DELETE AT ALL ════════════════════════════════════
// Not a disabled button. The control does not exist on a match that is not cancelled.
await scen("live");
await pick(CX);
ok(await T("p-state")==="SCHEDULED", 'the scenario match is not cancelled');
ok(!await has("danger"), 'there is NO delete section on a live match');
ok(!await has("del"), '  CONTROL: not a disabled button, no button');
await pick(18601);
ok(!await has("del"), 'CONTROL: nor on any other live match');

// ══ 3. CANCELLED, BUT PLAYERS STILL ATTACHED ════════════════════════════════
// Retool relies on the operator having cleared the roster first. This checks.
await scen("players");
await pick(CX);
ok(await T("p-state")==="CANCELLED", 'the match is cancelled');
ok(await T("p-players")==="3", '  and still carries 3 players');
ok(await has("del"), 'the delete control is present');
ok(await p.$eval(D("del"), e=>e.disabled), '  and disabled');
const why = await T("blocked");
ok(/3 players are still attached/.test(why), `with the reason and the count: "${why.slice(0,44)}…"`);
ok(/refunded/.test(why), '  and what deleting would destroy');
await p.click(D("del")).catch(()=>{});
await p.waitForTimeout(120);
ok(!await has("scrim"), 'CONTROL: clicking it opens no confirm');

// ══ 4. CANCELLED AND EMPTY: THE ONE CASE THAT DELETES ═══════════════════════
await scen("clean");
await pick(CX);
ok(await T("p-players")==="0", 'nobody is attached');
ok(!await p.$eval(D("del"), e=>e.disabled), 'the delete control is live');
ok(!await has("blocked"), '  CONTROL: and there is no refusal to read');

await p.click(D("del")); await p.waitForTimeout(160);
ok(await vis("scrim"), 'it opens a confirm rather than deleting');
const what = await T("d-what");
ok(/ATH Pearland/.test(what), `the confirm names the field: "${what}"`);
ok(/Wed 16 Sep 2026/.test(what), '  the date');
ok(/9:15 PM/.test(what), '  the time');
ok(new RegExp(String(CX)).test(what), '  and the match id');
const warn = await T("d-warn");
ok(/cannot be restored/.test(warn), 'and says it cannot be undone');
ok(/cancellation figures/.test(warn), '  naming the reports it changes, which is the point of doing it');

// KEEP IT does nothing at all.
await p.click(D("d-cancel")); await p.waitForTimeout(150);
ok(!await has("scrim"), 'Keep it closes the confirm');
ok(await p.$(chip(CX))!==null, '  CONTROL: the match is still in the grid');
ok(await T("counts")==="8 matches · 2 cancelled", '  CONTROL: and the counts are untouched');

// ══ 5. THE DELETE, AND THE NUMBER THAT IS THE WHOLE POINT ═══════════════════
await p.click(D("del")); await p.waitForTimeout(150);
await p.click(D("d-go")); await p.waitForTimeout(170);
ok(await p.$(chip(CX))===null, 'confirming removes the match from the grid');
ok(await T("counts")==="7 matches · 1 cancelled",
  `and BOTH counts drop: "${await T("counts")}"`);
ok(await p.$(chip(OTHER_CX))!==null, 'CONTROL: the other cancelled match is untouched');
ok(await p.$(chip(18601))!==null, '  CONTROL: so is every live one');
ok(await has("p-empty"), 'the panel returns to empty, because what it described is gone');
ok(!await has("scrim"), '  and the confirm is closed');

// ══ 6. THE DESTRUCTIVE CONTROL IS NOT BESIDE THE ROUTINE ONES ═══════════════
await load(); await pick(CX);
const geo = await p.evaluate(() => {
  const d = document.querySelector('[data-testid="danger"]').getBoundingClientRect();
  const kv = document.querySelector('.kv').getBoundingClientRect();
  const btn = document.querySelector('[data-testid="del"]');
  const cs = getComputedStyle(document.querySelector('[data-testid="danger"]'));
  return { below: d.top >= kv.bottom, rule: cs.borderTopWidth, h: btn.getBoundingClientRect().height,
           solid: getComputedStyle(btn).backgroundColor };
});
ok(geo.below, 'delete sits below the match facts, not among them');
ok(parseFloat(geo.rule)>0, '  separated by a rule');
ok(geo.h>=32, `  and is ${Math.round(geo.h)}px`);
ok(geo.solid==="rgb(255, 255, 255)",
  'CONTROL: the button in the panel is outlined, not a solid red invitation to click');
await p.click(D("del")); await p.waitForTimeout(150);
const confirmBg = await p.$eval(D("d-go"), e=>getComputedStyle(e).backgroundColor);
ok(confirmBg!=="rgb(255, 255, 255)", '  and only the CONFIRM button is solid');

// ══ 7. SIZES ════════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['clean','players','live']){
    await scen(s); await pick(CX);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
    const bad = await p.evaluate(() => [...document.querySelectorAll('.card, .cell, .pbody, .dlg')]
      .filter(e => e.scrollWidth > e.clientWidth + 2).length);
    ok(bad===0, `  ${w}px ${s}: nothing overflows its own box`);
  }
  await scen('clean'); await pick(CX);
  const btns = await p.$$eval('.sw button, .tog, .btn', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(btns.length>=5, `  (${btns.length} controls to measure)`);
  ok(Math.min(...btns)>=32, `  every control is ${Math.round(Math.min(...btns))}px`);
  await p.click(D("del")); await p.waitForTimeout(150);
  const dlg = await p.$eval('.dlg', e=>Math.round(e.getBoundingClientRect().width));
  ok(dlg<=w-24, `  the confirm fits the screen (${dlg}px inside ${w}px)`);
  const dbt = await p.$$eval('.dbtns .btn', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(dbt.length===2 && Math.min(...dbt)>=32, `  and its two buttons are ${Math.min(...dbt)}px`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
