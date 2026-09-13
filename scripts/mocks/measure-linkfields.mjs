import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/link-fields.html'); await p.waitForTimeout(160); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(130); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const box = s => p.$eval(s, e=>e.getBoundingClientRect().toJSON());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE CONTROL ON THE CARD IS SMALL ══════════════════════════════════════
// Today: a full-width bordered button, 34px tall, under a separate "no field
// record yet" line. Ryan: "i dont like the craete the field big button. just
// make it a little tiny button".
await go('board');
const chip = await box('[data-testid="card"][data-id="c3"] [data-testid="card-link"]');
const card = await box('[data-testid="card"][data-id="c3"]');
ok(chip.height<=26, `the control is ${Math.round(chip.height)}px tall, not 34`);
ok(chip.width < card.width*0.62, `and ${Math.round(chip.width)}px wide inside a ${Math.round(card.width)}px card — not full width`);
ok(chip.width < card.width-20, '  CONTROL: it is genuinely inset, not a full-bleed button with padding');
ok(!/no field record yet/i.test(await T('[data-testid="card"][data-id="c3"]')),
  'the separate "no field record yet" line is gone — the control says it');

// ══ 2. THE CHIP NAMES THE FIELD IT WILL LINK TO ══════════════════════════════
// "all these have fields so need an easy way to say that on them." The card's
// own title already matches an existing fin_venues row for some of them; the
// card says WHICH, rather than offering the same blank Create to everything.
const linkChip = await T('[data-testid="card"][data-id="c1"] [data-testid="card-link"]');
ok(/Link/.test(linkChip) && /Westlake/.test(linkChip),
  `a card whose name already matches a field says so on the card: "${linkChip}"`);
ok(await p.$eval('[data-testid="card"][data-id="c1"] [data-testid="card-link"]', e=>e.dataset.kind)==='link',
  '  and is marked as a link, not a create');
const newChip = await T('[data-testid="card"][data-id="c3"] [data-testid="card-link"]');
ok(/New field/i.test(newChip) && !/Link/.test(newChip),
  `CONTROL: a card matching nothing offers a new field instead: "${newChip}"`);
ok(await p.$eval('[data-testid="card"][data-id="c3"] [data-testid="card-link"]', e=>e.dataset.kind)==='new',
  '  CONTROL: and is marked as a create');
const cLink = await p.$eval('[data-testid="card"][data-id="c1"] [data-testid="card-link"]', e=>getComputedStyle(e).borderTopColor);
const cNew  = await p.$eval('[data-testid="card"][data-id="c3"] [data-testid="card-link"]', e=>getComputedStyle(e).borderTopColor);
ok(cLink!==cNew, `the two read differently at a glance too (${cLink} vs ${cNew}) — colour on top of the label, never instead of it`);
ok(await p.$('[data-testid="card"][data-id="c2"] [data-testid="card-link"]')===null,
  'CONTROL: a card that already has a field carries no control at all');
ok(/days to launch/.test(await T('[data-testid="card"][data-id="c2"] [data-testid="card-countdown"]')),
  '  it carries its countdown instead');

// ══ 3. THE UNBOUND CARD IS STILL DISTINGUISHABLE ═════════════════════════════
const eU = await p.$eval('[data-testid="card"][data-id="c3"]', e=>getComputedStyle(e).borderLeftWidth);
const eB = await p.$eval('[data-testid="card"][data-id="c2"]', e=>getComputedStyle(e).borderLeftWidth);
ok(eU!==eB, `a card with no field still reads differently from one with (${eU} vs ${eB})`);

ok(await p.$eval('[data-testid="card"][data-id="n1"]', e=>e.dataset.needs)==='0',
  'CONTROL: an unbound card OUTSIDE Confirmed is not marked at all — it is not late, it is not there yet');
ok(await p.$eval('[data-testid="card"][data-id="n1"]', e=>getComputedStyle(e).borderLeftWidth)===eB,
  '  CONTROL: and carries no amber edge');
ok(await p.$('[data-testid="card"][data-id="n1"] [data-testid="card-link"]')===null,
  '  CONTROL: and no chip');

// ══ 4. THE WHOLE CONTROL LIVES IN THE EDIT CARD MODAL ════════════════════════
// "just make it a little tiny button in here" — in here is the edit card modal.
await go('modal-none');
ok(await vis('[data-testid="card-modal"]'), 'the edit card modal opens');
ok(await vis('[data-testid="m-field"]'), 'and carries a Field row');
ok(/No field record/i.test(await T('[data-testid="m-field-name"]')), '  which says there is none yet');
const mMeta = await T('[data-testid="m-field-meta"]');
ok(/Nothing in Finance carries this name/i.test(mMeta), `  and what will happen: "${mMeta.slice(0,52)}…"`);
ok(/Create/.test(await T('[data-testid="m-field-btn"]')), '  with the control to fix it');
const mBtn = await box('[data-testid="m-field-btn"]');
ok(mBtn.height>=34, `  the modal's control is ${Math.round(mBtn.height)}px — the full-size one, because there is room here`);

await go('modal-bound');
ok(/Crossbar Rowlett/.test(await T('[data-testid="m-field-name"]')), 'a bound card names its field in the modal');
const bMeta = await T('[data-testid="m-field-meta"]');
ok(/Dallas/.test(bMeta) && /launches/.test(bMeta) && /days to launch/.test(bMeta),
  `  with city, launch date and countdown: "${bMeta}"`);
ok(/Change/.test(await T('[data-testid="m-field-btn"]')), '  and Change rather than Create');
ok(await p.$eval('[data-testid="m-field"]', e=>e.dataset.state)==='bound', '  CONTROL: the row knows it is bound');
await go('modal-none');
ok(await p.$eval('[data-testid="m-field"]', e=>e.dataset.state)==='none', '  CONTROL: and knows when it is not');

// ══ 5. THE DIALOG IS PREFILLED WITH THE CARD'S OWN NAME ══════════════════════
// This is the difference between "type 27 field names exactly" and "read the
// offer". No picker and no fuzzy matching: the string was already on the card.
await go('prefill');
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='Westlake',
  'opening the dialog from a card pre-types that card\'s name');
ok(await vis('[data-testid="bind-match"]'), '  so the offer is on screen without typing a character');
const off = await T('[data-testid="bind-match"]');
ok(/Westlake/.test(off) && /Austin/.test(off) && /already launches/.test(off),
  `  naming the field, its city and its launch date: "${off.slice(0,56)}…"`);
ok(/different field, change the name/i.test(off), '  with the way out if it is not the same field');
ok(await p.$eval('[data-testid="bind-launch"]', e=>e.value)==='2026-07-01', '  and the existing date is brought in');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='link', '  the action is a link');
ok(!await p.$eval('[data-testid="bind-save"]', e=>e.disabled), '  and it can be saved at once — two taps for the whole card');
ok(await p.$('[data-testid="bind-venue"]')===null, 'CONTROL: still no picker');
ok(await p.$('[data-testid="bind-existing"]')===null, 'CONTROL: and no pick-or-create switch');

// the prefill is a starting point, not a lock
await p.fill('[data-testid="bind-newname"]', 'Westlake North'); await p.waitForTimeout(130);
ok(!await vis('[data-testid="bind-match"]'), 'editing the name drops the offer');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='create', '  CONTROL: and it becomes a create');
ok(await vis('[data-testid="bind-city"]'), '  which asks nothing but states the city it takes off the card');
const cityTxt = await T('[data-testid="bind-city"]');
ok(/per match/i.test(cityTxt) && /needing one/i.test(cityTxt), `  and the billing it gets: "${cityTxt.slice(0,60)}…"`);
// A COST IS NULL, NEVER ZERO, WHEN IT IS NOT RECORDED (fieldEconomics.ts:19)
ok(!/\$0|free|no cost|costs nothing(?! )/i.test(cityTxt.replace(/not as a field that costs nothing/i,'')),
  '  CONTROL: and never says the field is free until a rate is set');

// the taken case survives the prefill
await go('board');
await p.click('[data-testid="card"][data-id="c1"] [data-testid="card-link"]'); await p.waitForTimeout(130);
await p.fill('[data-testid="bind-newname"]', 'Crossbar Rowlett'); await p.waitForTimeout(130);
ok(await vis('[data-testid="bind-dupe"]'), 'a field another card already holds is still refused');
ok(/already linked to the card/.test(await T('[data-testid="bind-dupe"]')), '  naming that card');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.disabled), '  and cannot be saved');

// ══ 6. THE DIALOG STACKS OVER THE MODAL, IT DOES NOT REPLACE IT ══════════════
// The modal holds unsaved title and to-do edits in local state. Closing it to
// open the bind dialog would throw them away.
await go('stacked');
ok(await vis('[data-testid="card-modal"]'), 'reaching for the field from the modal leaves the modal open');
ok(await vis('[data-testid="bind-dialog"]'), '  with the bind dialog over it');
const zM = await p.$eval('#modalScrim', e=>+getComputedStyle(e).zIndex);
const zB = await p.$eval('#bindScrim',  e=>+getComputedStyle(e).zIndex);
ok(zB>zM, `  and above it (${zB} over ${zM}), not behind`);
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='Stony Point', '  prefilled from that card too');
await p.click('[data-testid="bind-cancel"]'); await p.waitForTimeout(130);
ok(!await vis('[data-testid="bind-dialog"]'), 'Cancel closes the bind dialog');
ok(await vis('[data-testid="card-modal"]'), '  CONTROL: and returns to the card, not to the board');

// ══ 7. MATCH FIELDS — 27 CARDS WITHOUT LEAVING THE SCREEN ════════════════════
// "all these have fields so need an easy way to say that on them."
await go('board');
ok(await p.$eval('[data-testid="col-unlinked"]', e=>e.tagName)==='BUTTON',
  'the column header\'s count is the way in');
await p.click('[data-testid="col-unlinked"]'); await p.waitForTimeout(150);
ok(await vis('[data-testid="match-dialog"]'), '  and opens the whole backfill as one list');
const rows = await p.$$('[data-testid="match-row"]');
ok(rows.length===3, `every unbound confirmed card gets a row (${rows.length})`);
ok(await p.$$eval('[data-testid="match-row"] [data-testid="mr-name"]', es=>es.every(e=>e.value.length>0)),
  '  each prefilled with that card\'s own name');
const r1 = await T('[data-testid="match-row"][data-id="c1"] [data-testid="mr-res"]');
ok(/Links to/.test(r1) && /Westlake/.test(r1), `  and resolved on sight: "${r1.slice(0,48)}…"`);
ok(await p.$eval('[data-testid="match-row"][data-id="c1"] [data-testid="mr-date"]', e=>e.value)==='2026-07-01',
  '  with the existing launch date brought in');
ok(!await p.$eval('[data-testid="match-row"][data-id="c1"] [data-testid="mr-go"]', e=>e.disabled),
  '  so a matched row is ready to link');
const r3 = await T('[data-testid="match-row"][data-id="c3"] [data-testid="mr-res"]');
ok(/No field carries this name/.test(r3) && /Creates/.test(r3),
  `CONTROL: an unmatched row says it will create instead: "${r3.slice(0,48)}…"`);
ok(await p.$eval('[data-testid="match-row"][data-id="c3"] [data-testid="mr-go"]', e=>e.disabled),
  '  CONTROL: and cannot go, because it has no launch date yet');
// the name is editable, which is how a card named differently from its field gets fixed
await p.fill('[data-testid="match-row"][data-id="c4"] [data-testid="mr-name"]', 'The Hattrick');
await p.waitForTimeout(140);
const r4 = await T('[data-testid="match-row"][data-id="c4"] [data-testid="mr-res"]');
ok(/Links to/.test(r4) && /Hattrick/.test(r4),
  `correcting a row's name resolves it live: "Hat / The Hattrick" -> "${r4.slice(0,40)}…"`);
ok(await p.$eval('[data-testid="match-row"][data-id="c4"] [data-testid="mr-date"]', e=>e.value)==='2026-10-02',
  '  and brings that field\'s date in');
ok(await p.$$('[data-testid="match-all"]').then(a=>a.length===0),
  'CONTROL: there is no Link all — a person still confirms each row');
const mtx = await T('[data-testid="match-dialog"]');
ok(/Nothing is linked until you press Link/.test(mtx), 'and the list says so before any of it is pressed');
ok(/nothing is sent to anybody/i.test(mtx), '  along with the fact that nobody is messaged');

// ══ 8. A PHONE ═══════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['board','modal-none','modal-bound','prefill','stacked','match']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('prefill');
  const db = await p.$$eval('[data-testid="bind-dialog"] .df button', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(db>=44, `  the bind dialog's buttons are ${Math.round(db)}px`);
  const di = await p.$$eval('[data-testid="bind-dialog"] input', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(di>=44, `  and its inputs ${Math.round(di)}px`);
  const dw = await p.$eval('[data-testid="bind-dialog"]', e=>e.getBoundingClientRect().width);
  ok(dw<=w-20, `  it fits the screen (${Math.round(dw)} in ${w})`);
  await go('match');
  const mi = await p.$$eval('[data-testid="match-row"] input', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(mi>=44, `  the match rows' inputs are ${Math.round(mi)}px`);
  const mg = await p.$$eval('[data-testid="mr-go"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(mg>=36, `  and their buttons ${Math.round(mg)}px`);
  const mw = await p.$eval('[data-testid="match-dialog"]', e=>e.getBoundingClientRect().width);
  ok(mw<=w-20, `  the list fits too (${Math.round(mw)} in ${w})`);
}

// at 390 the chip must not push the card wider or wrap to two lines
await load(390); await go('board');
const cl = await p.$$eval('.ct', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
ok(cl===0, 'no card title is clipped at 390');
const ch = await p.$$eval('[data-testid="card-link"]', es=>Math.max(...es.map(e=>e.getBoundingClientRect().height)));
ok(ch<=26, `the chip is still one line at 390 (${Math.round(ch)}px)`);
const inCard = await p.evaluate(()=>{
  const c=document.querySelector('[data-testid="card"][data-id="c1"]').getBoundingClientRect();
  const k=document.querySelector('[data-testid="card"][data-id="c1"] [data-testid="card-link"]').getBoundingClientRect();
  return k.right<=c.right-2 && k.left>=c.left-1;
});
ok(inCard, '  and sits inside its card, not over the edge');
await go('match');
const stack = await p.$$eval('[data-testid="match-row"][data-id="c1"] .mgrid > *',
  es=>new Set(es.map(e=>Math.round(e.getBoundingClientRect().y))).size);
ok(stack===2, 'the match row\'s name and date stack at 390 rather than squeezing side by side');
await load(1200); await go('match');
const side = await p.$$eval('[data-testid="match-row"][data-id="c1"] .mgrid > *',
  es=>new Set(es.map(e=>Math.round(e.getBoundingClientRect().y))).size);
ok(side===1, 'CONTROL: and sit side by side at 1200');

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
