import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/bind-confirmed.html'); await p.waitForTimeout(170); };
await load();
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(120); };
const T = s => p.$eval(s, e=>e.textContent.trim());
const stageOf = id => p.$eval(`[data-testid="card"][data-id="${id}"]`,
  e => e.closest('.col').dataset.testid);

ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE MOVE AND THE BINDING ARE ONE ACTION ═══════════════════════════════
// A card cannot sit in Confirmed with no field: that is the state that makes the
// whole launch plan unbuildable, and it is the state the app is in today.
await go('drop');
ok(await p.$('[data-testid="bind-dialog"]')!==null, 'dropping on Confirmed asks for the field to create');
ok(await stageOf('c1')==='col-negotiation',
  'and the card has NOT moved yet — the stage change is not committed until the binding is');
await p.click('[data-testid="bind-cancel"]'); await p.waitForTimeout(120);
ok(await p.$('[data-testid="bind-dialog"]')===null, 'Cancel closes it');
ok(await stageOf('c1')==='col-negotiation', 'CONTROL: and leaves the card where it started, not in Confirmed');

// ══ 2. THERE IS NO PICKER, BECAUSE THERE IS NOTHING TO PICK ══════════════════
// A field reaching Confirmed has never existed before. Offering a list of fields
// that do was a choice nobody could make correctly.
await go('drop');
ok(await p.$('[data-testid="bind-venue"]')===null, 'no existing-field picker');
ok(await p.$('[data-testid="bind-existing"]')===null, '  and no pick-or-create switch');
ok(await p.$('[data-testid="bind-newname"]')!==null, 'just a name for the field being created');

// ══ 2b. BOTH FACTS ARE REQUIRED ══════════════════════════════════════════════
ok(await p.$eval('[data-testid="bind-save"]', e=>e.disabled), 'with neither name nor date, it cannot be saved');
await p.fill('[data-testid="bind-newname"]', 'Crossbar Rowlett North'); await p.waitForTimeout(140);
ok(await p.$eval('[data-testid="bind-save"]', e=>e.disabled), '  a name alone is not enough');
await p.fill('[data-testid="bind-launch"]', '2026-11-06');
await p.dispatchEvent('[data-testid="bind-launch"]', 'change'); await p.waitForTimeout(140);
ok(!await p.$eval('[data-testid="bind-save"]', e=>e.disabled), 'with both, it can');
ok(await p.$('[data-testid="bind-preview"]')!==null, 'and it says what saving will create before you press it');
ok(/24 tasks/.test(await T('[data-testid="bind-preview"]')), '  the task count from the playbook, including the Ops prerequisite');
ok(/Nothing is sent/.test(await T('[data-testid="bind-preview"]')), '  and that nobody is messaged');

// ══ 3. THE DATE IS THE ANCHOR, SO IT IS SHOWN AS ONE ═════════════════════════
await go('ready');
ok(/days to launch/.test(await T('[data-testid="bind-cd"]')),
  `the date reads back as a countdown while you pick it: "${await T('[data-testid="bind-cd"]')}"`);
ok(await p.$eval('[data-testid="bind-launch"]', e=>e.type)==='date', 'and it is a real date input');

// ══ 3b. fin_venues NEEDS THREE COLUMNS, NOT ONE ══════════════════════════════
// Probed against the live table: venue_name alone fails on city, then on
// billing_type. Both are NOT NULL with no default.
await go('drop');
ok(await p.$('[data-testid="bind-city"]')!==null, 'the city is shown, because the row cannot be written without one');
ok(/from the card/.test(await T('[data-testid="bind-city"]')), '  and it comes off the card rather than being asked for');
ok(/per match/i.test(await T('[data-testid="bind-dialog"]')), 'the billing type it will get is stated');
ok(/needing one|needs one|work item/i.test(await T('[data-testid="bind-dialog"]')),
  '  along with what that means in Finance until a rate is entered');
// A COST IS NULL, NEVER ZERO, WHEN IT IS NOT RECORDED (fieldEconomics.ts:19).
// The copy must not imply the field costs nothing until somebody sets a rate.
const billTxt = await T('[data-testid="bind-dialog"]');
ok(!/\$0|free|no cost|costs nothing/i.test(billTxt), 'and never implies the field costs nothing until a rate is set');

// ══ 4. AN EXACT MATCH IS AN OFFER, NOT A REFUSAL ═════════════════════════════
// 12 of the 27 cards already in Confirmed name a venue that exists, 9 with a
// launch date. Refusing an exact match left all 12 with no way forward: the only
// control was Create, and Create was refused.
await go('link');
ok(await p.$('[data-testid="bind-match"]')!==null, 'typing the name of a field that exists offers to link to it');
const match = await T('[data-testid="bind-match"]');
ok(/Westlake/.test(match) && /Austin/.test(match), `  naming the field and its city: "${match.slice(0,44)}…"`);
ok(/already launches/.test(match), '  and the launch date it already carries');
ok(/different field, change the name/i.test(match), '  with the way out if it is not the same field');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='link', 'the action becomes a link, not a create');
ok(/Link/.test(await T('[data-testid="bind-save"]')), `  and says so: "${await T('[data-testid="bind-save"]')}"`);
ok(await p.$eval('[data-testid="bind-launch"]', e=>e.value)==='2026-07-01',
  'the existing launch date is brought in rather than retyped');
ok(!await p.$eval('[data-testid="bind-save"]', e=>e.disabled), '  so a matched field with a date can be saved at once');
ok(await p.$('[data-testid="bind-city"]')===null, 'CONTROL: linking asks for no city — the venue already has one');

// ══ 4b. BUT A VENUE ANOTHER CARD ALREADY HAS IS STILL REFUSED ════════════════
// "The Hattrick" and "Hat / The Hattrick" are both sitting in Confirmed.
await go('dupe');
ok(await p.$('[data-testid="bind-dupe"]')!==null, 'a field another card already claimed is refused');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.disabled), '  and cannot be saved');
const why = await T('[data-testid="bind-dupe"]');
ok(/already linked to the card/.test(why), `  naming the card that has it: "${why.slice(0,46)}…"`);
ok(/unlink that card first/i.test(why), '  and what to do about it');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='taken', 'and the mode says taken, not create');
await go('ready');
ok(!await p.$eval('[data-testid="bind-save"]', e=>e.disabled), 'CONTROL: a name nobody has used saves fine');
ok(await p.$('[data-testid="bind-dupe"]')===null, '  and shows no collision warning');
ok(await p.$('[data-testid="bind-match"]')===null, '  and offers no link');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='create', '  it is a create');

// ══ 6. THE CARDS ALREADY IN CONFIRMED ════════════════════════════════════════
// A migration cannot invent this link. The backfill has to be visible.
await go('board');
ok(await p.$('[data-testid="col-unlinked"]')!==null, 'the Confirmed column says how many have no field record');
ok(/1 without a field/.test(await T('[data-testid="col-unlinked"]')), `  with the count: "${await T('[data-testid="col-unlinked"]')}"`);
ok(await p.$('[data-testid="card"][data-id="c3"] [data-testid="card-link"]')!==null,
  'and a card with no field carries the control to create one');
ok(await p.$('[data-testid="card"][data-id="c2"] [data-testid="card-link"]')===null,
  'CONTROL: a card that has one does not');
const unboundEdge = await p.$eval('[data-testid="card"][data-id="c3"]', e=>getComputedStyle(e).borderLeftWidth);
const boundEdge   = await p.$eval('[data-testid="card"][data-id="c2"]', e=>getComputedStyle(e).borderLeftWidth);
ok(unboundEdge!==boundEdge, `a card with no field is distinguishable at a glance (${unboundEdge} vs ${boundEdge})`);
await p.click('[data-testid="card"][data-id="c3"] [data-testid="card-link"]'); await p.waitForTimeout(140);
ok(await p.$('[data-testid="bind-dialog"]')!==null, 'and it opens the same dialog, not a second one');
ok(/Stony Point/.test(await T('[data-testid="bind-dialog"] .dh')), '  named for that card');

// ══ 7. A BOUND CARD SHOWS THE COUNTDOWN ══════════════════════════════════════
await go('board');
const cd = await T('[data-testid="card"][data-id="c2"] [data-testid="card-countdown"]');
ok(/days to launch/.test(cd), `a card with a field carries its countdown on the board: "${cd}"`);
ok(await p.$('[data-testid="card"][data-id="c3"] [data-testid="card-countdown"]')===null,
  'CONTROL: one without a field has no countdown, because it has no date');

// ══ 8. A PHONE ═══════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['board','drop','dupe']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('drop');
  const btns = await p.$$eval('.df button', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(btns>=44, `  the dialog's buttons are ${Math.round(btns)}px`);
  const inputs = await p.$$eval('.fld input, .fld select', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(inputs>=40, `  and its inputs are ${Math.round(inputs)}px`);
  const dw = await p.$eval('.dlg', e=>e.getBoundingClientRect().width);
  ok(dw<=w-20, `  the dialog fits the screen (${Math.round(dw)} in ${w})`);
}
await load(390); await go('board');
const clip = await p.$$eval('.ct', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
ok(clip===0, 'no card title is truncated at 390');
const cols = await p.$$eval('.col', es=>new Set(es.map(e=>Math.round(e.getBoundingClientRect().x))).size);
ok(cols===1, 'and the columns stack to one at phone width');

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
