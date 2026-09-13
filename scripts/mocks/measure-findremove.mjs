import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:950} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=950) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/find-and-remove.html'); await p.waitForTimeout(160); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(140); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. A NAME YOU CANNOT GUESS BECOMES FINDABLE ══════════════════════════════
// Ryan: "the hattrick and some fields no way to says its hattrick leander."
// The CARD is called "Hat / The Hattrick". No venue is spelled that way, so no
// amount of exact typing off the card reaches "Hattrick Leander".
await go('find');
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='hattrick', 'typing part of the name');
ok(await vis('[data-testid="bind-cands"]'), '  lists the fields in Finance that contain it');
const cands = await p.$$('[data-testid="cand"]');
ok(cands.length===2, `  both of them (${cands.length}), not a table of 61`);
const names = await p.$$eval('[data-testid="cand"] .cn', es=>es.map(e=>e.textContent.trim()));
ok(names.includes('Hattrick Leander'), `  including the one nobody could have typed: ${JSON.stringify(names)}`);
ok(names.includes('The Hattrick'), '  and the one they were thinking of');
ok(/match "hattrick"/.test(await T('[data-testid="bind-cands-hd"]')),
  `and the list says what it is showing: "${await T('[data-testid="bind-cands-hd"]')}"`);
const leanderMeta = await p.$eval('[data-testid="cand"][data-id="57"] .cm', e=>e.textContent.trim());
ok(/Austin/.test(leanderMeta) && /launches/.test(leanderMeta),
  `each candidate carries its city and launch date: "${leanderMeta}"`);

// NOTHING IS CHOSEN FOR YOU. This is the whole difference from auto-matching.
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='hattrick',
  'CONTROL: the box is untouched until a candidate is clicked');
ok(!await vis('[data-testid="bind-match"]'), '  CONTROL: and nothing is offered as a link yet');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='create',
  '  CONTROL: the action is still a create, because nothing has been picked');

await p.click('[data-testid="cand"][data-id="57"]'); await p.waitForTimeout(140);
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='Hattrick Leander', 'clicking one fills the name');
ok(await vis('[data-testid="bind-match"]'), '  and it resolves to the offer it always did');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='link', '  as a link, not a create');
ok(await p.$eval('[data-testid="bind-launch"]', e=>e.value)==='2026-11-14', '  with that field\'s launch date brought in');
ok(!await vis('[data-testid="bind-cands"]'), '  and the list steps out of the way once the name is exact');

// ══ 2. A FIELD ANOTHER CARD HOLDS IS SHOWN, NOT HIDDEN ═══════════════════════
// Hiding it makes the name look like it does not exist, so the person types it again.
await go('find');
ok(await p.$eval('[data-testid="cand"][data-id="52"]', e=>e.disabled),
  'a field another card already holds is listed but cannot be picked');
ok(await p.$eval('[data-testid="cand"][data-id="52"]', e=>e.dataset.held)==='1', '  and is marked as held');
const heldMeta = await p.$eval('[data-testid="cand"][data-id="52"] .cm', e=>e.textContent.trim());
ok(/already linked to/.test(heldMeta), `  saying who has it: "${heldMeta}"`);
ok(!await p.$eval('[data-testid="cand"][data-id="57"]', e=>e.disabled),
  'CONTROL: an unclaimed one in the same list is pickable');
const dis = await p.$eval('[data-testid="cand"][data-id="52"]', e=>getComputedStyle(e).backgroundColor);
const en  = await p.$eval('[data-testid="cand"][data-id="57"]', e=>getComputedStyle(e).backgroundColor);
ok(dis!==en, `  CONTROL: and the two look different (${dis} vs ${en}), on top of the words`);

// the exact-name refusal is unchanged
await go('claimed');
ok(await vis('[data-testid="bind-dupe"]'), 'typing a held field\'s exact name is still refused');
ok(/already linked to the card/.test(await T('[data-testid="bind-dupe"]')), '  naming that card');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.disabled), '  and cannot be saved');
ok(!/—/.test(await T('[data-testid="bind-dupe"]')), '  CONTROL: and no em-dash in it');

// a search that matches nothing shows nothing
await p.fill('[data-testid="bind-newname"]', 'zzzq'); await p.waitForTimeout(140);
ok(!await vis('[data-testid="bind-cands"]'), 'CONTROL: a name matching nothing lists nothing');
await p.fill('[data-testid="bind-newname"]', 'h'); await p.waitForTimeout(140);
ok(!await vis('[data-testid="bind-cands"]'), 'CONTROL: and one letter is not a search');

// ══ 3. A PLAN CAN BE REMOVED ═════════════════════════════════════════════════
// Ryan: "some fields we might not want to have a launch plan for and should be
// able to remove it." Keswick is week 2 of 4 with 0 of 24 done and 10 overdue.
await go('plan');
ok(await vis('[data-testid="plan-remove"]'), 'the plan page carries a way to remove the plan');
const rmBtn = await p.$eval('[data-testid="plan-remove"]', e=>e.getBoundingClientRect().toJSON());
ok(rmBtn.height<=36, `  as a quiet control, not a hazard (${Math.round(rmBtn.height)}px)`);
ok(await p.$('[data-testid="rm-dialog"]').then(e=>e.isVisible()).then(v=>!v),
  '  CONTROL: and it does not delete anything on its own');
await p.click('[data-testid="plan-remove"]'); await p.waitForTimeout(150);
ok(await vis('[data-testid="rm-dialog"]'), 'it asks first');
ok(/Keswick ATL Field 2/.test(await T('[data-testid="rm-sub"]')), '  naming the field');

// WHAT IS ACTUALLY BEING THROWN AWAY
const loss0 = await T('[data-testid="rm-loss"]');
ok(/24 tasks/.test(loss0), `  and the count: "${loss0.slice(0,46)}…"`);
ok(/nothing anybody did is lost/.test(loss0), '  and that nothing anybody did is lost, because nothing was ticked');
await go('worked');
await p.click('[data-testid="plan-remove"]'); await p.waitForTimeout(150);
const loss1 = await T('[data-testid="rm-loss"]');
ok(/12/.test(loss1), `CONTROL: a plan somebody HAS worked says how much: "${loss1.slice(0,58)}…"`);
ok(/not recoverable/.test(loss1), '  CONTROL: and that it is not recoverable');
ok(loss0!==loss1, '  CONTROL: the two are not the same sentence');

// WHAT SURVIVES IT
const sticky = await T('[data-testid="rm-sticky"]');
ok(/field, its launch date and this card all stay/.test(sticky), 'and what it does NOT touch');
ok(/not come back on its own/.test(sticky), '  including that the repair pass will not re-seed it');
ok(!/—/.test(sticky), '  CONTROL: no em-dash');

// ══ 4. AFTER IT IS GONE ══════════════════════════════════════════════════════
await p.click('[data-testid="rm-cancel"]'); await p.waitForTimeout(140);
ok(!await vis('[data-testid="rm-dialog"]'), 'Cancel closes it');
ok(await vis('[data-testid="task"]'), '  CONTROL: and the plan is still there');
await go('gone');
ok(await vis('[data-testid="plan-gone"]'), 'a removed plan says so');
ok(!await vis('[data-testid="task"]'), '  CONTROL: with no tasks left on the page');
ok(!await vis('[data-testid="plan-counter"]'), '  CONTROL: and no launch-week counter, because there is nothing to count');
const why = await T('[data-testid="plan-gone-why"]');
ok(/Somebody removed it on/.test(why), `  and when: "${why.slice(0,40)}…"`);
ok(/still a field with a launch date/.test(why), '  and that the field itself is unharmed');
ok(await vis('[data-testid="plan-restart"]'), 'and a plan can be started again from here');
ok(/dated from that same launch date/.test(why), '  saying what starting one would do');
await p.click('[data-testid="plan-restart"]'); await p.waitForTimeout(150);
ok(await vis('[data-testid="task"]'), 'CONTROL: starting one brings the tasks back');
ok(!await vis('[data-testid="plan-gone"]'), '  CONTROL: and clears the removed notice');

// ══ 5. A PHONE ═══════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['find','claimed','plan','worked','confirm','gone']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('find');
  const ch = await p.$$eval('[data-testid="cand"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(ch>=44, `  candidate rows are ${Math.round(ch)}px`);
  const ci = await p.$$eval('[data-testid="cand"] .cn', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
  ok(ci===0, '  and no candidate name is clipped');
  await go('confirm');
  const rb = await p.$$eval('[data-testid="rm-dialog"] .df button', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(rb>=44, `  the confirm's buttons are ${Math.round(rb)}px`);
  const rw = await p.$eval('[data-testid="rm-dialog"]', e=>e.getBoundingClientRect().width);
  ok(rw<=w-20, `  and it fits the screen (${Math.round(rw)} in ${w})`);
}

// the two confirm buttons must not sit on top of each other at phone width
await load(390); await go('confirm');
const rows = await p.$$eval('[data-testid="rm-dialog"] .df button',
  es=>es.map(e=>Math.round(e.getBoundingClientRect().y)));
ok(new Set(rows).size>=1, `the confirm's buttons lay out cleanly at 390 (${rows.length} buttons)`);
const overlap = await p.evaluate(()=>{
  const bs=[...document.querySelectorAll('[data-testid="rm-dialog"] .df button')].map(e=>e.getBoundingClientRect());
  for(let i=0;i<bs.length;i++)for(let j=i+1;j<bs.length;j++){
    const a=bs[i],b=bs[j];
    if(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom) return true;
  } return false;
});
ok(!overlap, '  CONTROL: and none of them overlaps another');

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
