import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:950} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=950) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/pick-field.html'); await p.waitForTimeout(160); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(140); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };
const names = () => p.$$eval('[data-testid="cand"] .cn', es=>es.map(e=>e.textContent.trim()));

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE MODAL ROW WAS STATING SOMETHING FALSE ═════════════════════════════
// Ryan opened Ann Richards and the Field row said "Nothing in Finance carries
// this name." Ann Richards School (#65) is right there. The row ran only the
// exact-match rule and never called candidatesFor, so it had not looked.
await go('row');
const meta = await T('[data-testid="m-field-meta"]');
ok(!/Nothing in Finance/.test(meta), 'the Field row no longer claims nothing exists when something does');
ok(/could be this one/.test(meta), `  it says how many could be: "${meta.slice(0,58)}…"`);
ok(/Ann Richards School/.test(meta), '  and names the likeliest, so the answer is visible without opening anything');
ok(await T('[data-testid="m-field-btn"]')==='Find the field…',
  `and the button stops saying Create: "${await T('[data-testid="m-field-btn"]')}"`);
ok(await p.$eval('[data-testid="m-field-btn"]', e=>e.dataset.kind)==='find', '  and is marked as a find');

// CONTROL: a card that genuinely matches nothing still says so.
await go('rownone');
ok(/Nothing in Finance looks like this name/.test(await T('[data-testid="m-field-meta"]')),
  'CONTROL: RR MPC, which matches nothing, still says nothing looks like it');
ok(await T('[data-testid="m-field-btn"]')==='Create…', '  CONTROL: and still offers Create');
ok(await p.$eval('[data-testid="m-field"]', e=>e.dataset.cands)==='0', '  CONTROL: because the search really did return nothing');

// ══ 2. THE LIST IS ON SCREEN BEFORE YOU TYPE ═════════════════════════════════
// "i have to remember names" — so nothing may depend on remembering one.
await go('seeded');
ok(await vis('[data-testid="bind-cands"]'), 'opening the dialog shows the list with no typing at all');
ok((await names()).includes('Ann Richards School'), `  already carrying the answer: ${JSON.stringify(await names())}`);
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='create',
  '  CONTROL: and still nothing is picked — the action is a create until a row is clicked');
await p.click('[data-testid="cand"][data-id="65"]'); await p.waitForTimeout(140);
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='Ann Richards School', 'clicking a row fills the name');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='link', '  and it becomes a link');
ok(await vis('[data-testid="bind-match"]'), '  with the offer it always showed');

// ══ 3. AN EMPTY BOX IS A BROWSE, NOT A BLANK ═════════════════════════════════
await go('browse');
ok(await p.$eval('[data-testid="bind-newname"]', e=>e.value)==='', 'the box can be cleared');
ok(await vis('[data-testid="bind-cands"]'), '  and an empty box lists every field rather than nothing');
const all = await names();
const TOTAL = all.length;
ok(TOTAL>=20, `  all of them (${TOTAL})`);
ok(new RegExp(`All ${TOTAL} fields`).test(await T('[data-testid="bind-cands-hd"]')), '  and says so');
ok(/Type to narrow/.test(await T('[data-testid="bind-cands-hint"]')), '  and what to do about it');
const cityHds = await p.$$eval('[data-testid="cand-city"]', es=>es.map(e=>e.textContent.trim()));
ok(cityHds.length>=3, `  grouped by city (${cityHds.join(", ")}), because a flat list of 14 is the same problem`);
const sc = await p.$eval('.scroll', e=>({sh:e.scrollHeight, ch:e.clientHeight}));
ok(sc.sh>sc.ch, `  and the list scrolls (${sc.sh} in ${sc.ch}) rather than growing the dialog off screen`);
await go('seeded');
const narrowed = await names();
ok(narrowed.length < all.length, `CONTROL: typing narrows it (${narrowed.length} of ${all.length})`);
ok(await p.$$eval('[data-testid="cand-city"]', es=>es.length)===0,
  '  CONTROL: and a narrowed list drops the city headings, because it is short');

// ══ 4. THE SUBSTRING RULE I SPECCED FINDS NONE OF THESE ══════════════════════
// I wrote "substring, case-insensitive" into the prompt. It works for "Ann
// Richards" and fails for most of the real backlog, because the card's name is
// not INSIDE the field's name — they only share a word.
const cases = [
  ['katy',  'Katy ISC',                'KISC (Katy Intl)'],
  ['onion', 'OC / Onion Creek - AMSA', 'Onion Creek'],
  ['crock', 'Crockett HS (AISD)',      'Crockett High School'],
  ['star',  'STAR Soccer Complex',     'STAR'],
];
for (const [key, cardTitle, wanted] of cases){
  await load(); await go('words');
  await p.evaluate(k => window.__openBind(k), key);
  await p.waitForTimeout(140);
  const got = await names();
  const nNew = +await T('[data-testid="cmp-new"]');
  const nOld = +await T('[data-testid="cmp-old"]');
  ok(got.includes(wanted), `"${cardTitle}" finds "${wanted}"`);
  ok(nOld===0, `  CONTROL: the shipped substring rule returns ${nOld} for the same string`);
  ok(nNew>0, `  and the word rule returns ${nNew}`);
}
// CONTROL: the word rule did not simply match everything
await load(); await go('words'); await p.evaluate(() => window.__openBind('katy')); await p.waitForTimeout(160);
const katyList = await names();
ok(katyList.length>0 && katyList.length<20, `CONTROL: it is still a filter, not the whole table (${katyList.length} of 14)`);
ok(!katyList.includes('Westlake'), '  CONTROL: an unrelated field is not in it');
// CONTROL: a whole-string substring that the old rule DID catch still works
await p.fill('[data-testid="bind-newname"]', 'parmer'); await p.waitForTimeout(140);
ok((await names()).includes('PARMER Stadium'), 'CONTROL: a case the substring rule handled still works');
ok(+await T('[data-testid="cmp-old"]')>0, '  CONTROL: and the old rule agrees on that one, so nothing regressed');

// ══ 4b. THE TOP HIT WAS WRONG ON THREE OF SEVEN ══════════════════════════════
// Claude Code's own item-14 walk: "Lou Fusz Athletic Complex" -> Wheatley Heights
// Sport Complex, "STAR Soccer Complex" -> Soccer Central, and Katy ISC -> ATH Katy.
// One cause: "Complex", "Soccer" and "Park" are in many venue names, so they match
// everything and tell you nothing. The four-word stoplist I wrote does not cover it.
await load(); await go('generic');
const lfTop = await T('[data-testid="cmp-top"]');
ok(/^Lou Fusz/.test(lfTop), `"Lou Fusz Athletic Complex" now tops with ${lfTop}, not a Complex somewhere else`);
const lfNames = await names();
ok(!lfNames.includes('Wheatley Heights Sport Complex'),
  `  CONTROL: the other Complex is gone from the list entirely: ${JSON.stringify(lfNames)}`);
ok(lfNames.every(n=>/Lou Fusz/.test(n)), '  CONTROL: and every candidate is actually a Lou Fusz');

await load(); await go('generic2');
const stTop = await T('[data-testid="cmp-top"]');
ok(stTop==='STAR', `"STAR Soccer Complex" now tops with ${stTop}, not Soccer Central`);
// "soccer" is in ONE venue name in this corpus, so it stays a discriminator and
// Soccer Central stays listed. That is the rule being honest rather than my taste:
// it is ranked BELOW the real answer, not dropped by a word I disliked.
const stNames = await names();
ok(stNames.indexOf('STAR') < stNames.indexOf('Soccer Central'),
  `  Soccer Central ranks below it rather than being hand-dropped: ${JSON.stringify(stNames)}`);
ok(stNames.length<=4, `  CONTROL: and the list is still short (${stNames.length})`);

// the derived list is visible, and it is derived rather than typed
const stopTxt = await T('[data-testid="cmp-stop"]');
ok(/complex/.test(stopTxt) && /park/.test(stopTxt),
  `the words it ignored are named and were computed from the table: "${stopTxt}"`);
ok(!/hattrick/.test(stopTxt) && !/richards/.test(stopTxt),
  '  CONTROL: a word that appears in one or two names is NOT ignored');

// CONTROL: the cases that were already right stay right
await load(); await go('seeded');
ok(await T('[data-testid="cmp-top"]')==='Ann Richards School', 'CONTROL: Ann Richards is unaffected');
await load(); await go('words'); await p.evaluate(()=>window.__openBind('crock')); await p.waitForTimeout(150);
ok(await T('[data-testid="cmp-top"]')==='Crockett High School',
  'CONTROL: Crockett still finds Crockett High School, even though "school" is now ignored');
await load(); await go('words'); await p.evaluate(()=>window.__openBind('onion')); await p.waitForTimeout(150);
ok((await names()).includes('Onion Creek'), 'CONTROL: Onion Creek still found');

// CONTROL: a name made only of common words is still searchable
await load(); await go('browse');
await p.fill('[data-testid="bind-newname"]', 'Soccer Central'); await p.waitForTimeout(150);
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='link',
  'CONTROL: a venue whose name is ALL common words is still reachable by typing it in full');

// ══ 5. TWO FIELDS WITH THE SAME NAME, SORTED BY THE CARD'S OWN CITY ══════════
// Hattrick #3 is Austin and Hattrick T. #52 is Houston. Neither is picked.
await load(); await go('city');
const hl = await names();
ok(hl.includes('Hattrick') && hl.includes('Hattrick T.'), `both Hattricks are listed: ${JSON.stringify(hl)}`);
ok(hl.indexOf('Hattrick') < hl.indexOf('Hattrick T.'),
  '  and the one in the card\'s own city is first, because the card already knows its city');
ok(await p.$eval('[data-testid="bind-save"]', e=>e.dataset.mode)==='create',
  '  CONTROL: neither is picked — the save is still a create');
const hm = await p.$eval('[data-testid="cand"][data-id="52"] .cm', e=>e.textContent.trim());
ok(/no launch date yet/.test(hm), `a field with no launch date says so rather than showing nothing: "${hm}"`);
// CONTROL: the stoplist keeps "the" from dragging in unrelated fields
ok(!hl.includes('Westlake'), '  CONTROL: and the three-letter words in "Hat / The Hattrick" drag nothing else in');

// ══ 6. A HELD FIELD IS STILL LISTED AND STILL REFUSED ════════════════════════
await load(); await go('browse');
ok(await p.$eval('[data-testid="cand"][data-id="51"]', e=>e.disabled), 'a field another card holds is listed but not pickable');
ok(/already linked to/.test(await p.$eval('[data-testid="cand"][data-id="51"] .cm', e=>e.textContent)),
  '  and names who has it');
ok(!await p.$eval('[data-testid="cand"][data-id="5"]', e=>e.disabled), 'CONTROL: a free one in the same list is pickable');

// ══ 7. A PHONE ═══════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['row','rownone','seeded','browse','words','city']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('browse');
  const ch = await p.$$eval('[data-testid="cand"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(ch>=44, `  rows are ${Math.round(ch)}px`);
  const clip = await p.$$eval('[data-testid="cand"] .cn',
    es=>es.filter(e=>e.scrollWidth>e.clientWidth+1 || e.scrollHeight>e.clientHeight+1).length);
  ok(clip===0, '  and no field name is cut off: long ones wrap rather than ellipsing');
  const dh = await p.$eval('[data-testid="bind-dialog"]', e=>e.getBoundingClientRect().height);
  ok(dh<=h0(w), `  the dialog stays ${Math.round(dh)}px, inside the viewport, because the list scrolls`);
  const dw = await p.$eval('[data-testid="bind-dialog"]', e=>e.getBoundingClientRect().width);
  ok(dw<=w-20, `  and fits the width (${Math.round(dw)} in ${w})`);
}
function h0(){ return 950; }

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
