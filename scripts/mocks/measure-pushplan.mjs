import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1100,height:1000} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1100,h=1000) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/push-plan.html'); await p.waitForTimeout(180); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(170); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };
const C = k => `[data-testid="chan"][data-key="${k}"]`;
const val = s => p.$eval(s, e=>e.value);

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. MANY DATES PER CHANNEL, NOT ONE DATE PER MATCH ════════════════════════
// Teresa: "we can pick the channels, and only 1 date for the pushes ... What we
// think could solve this is to pick the channel, pick the date or dates."
const waPushes = await p.$$(C('wa')+' [data-testid="push"]');
ok(waPushes.length===2, `WhatsApp carries ${waPushes.length} pushes, not one`);
ok(await p.$$(C('mc')+' [data-testid="push"]').then(a=>a.length===1),
  'CONTROL: another channel carries its own count, independently');
await p.click(C('wa')+' [data-testid="add"]'); await p.waitForTimeout(170);
ok(await p.$$(C('wa')+' [data-testid="push"]').then(a=>a.length===3), 'a third can be added');
ok(await p.$$(C('mc')+' [data-testid="push"]').then(a=>a.length===1),
  '  CONTROL: and it does not touch the other channel');
// the new one sorts to the FRONT: 8h before kickoff is earlier than the 09-14 17:00 push
ok(await val(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="topic"]')==='',
  '  and the new one sorts into place by time rather than landing at the end');
await p.click(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="rm"]'); await p.waitForTimeout(170);
ok(await p.$$(C('wa')+' [data-testid="push"]').then(a=>a.length===2), 'and removed again');

// A NEW PUSH SORTS INTO PLACE BY TIME, so the row I added is not the row at the
// end. Reload rather than assume an index the sort just moved.
await load();

// ══ 2. A TOPIC PER DATE ══════════════════════════════════════════════════════
// "the topic of the push as it might vary between days."
const t0 = await val(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="topic"]');
const t1 = await val(C('wa')+' [data-testid="push"][data-i="1"] [data-testid="topic"]');
ok(t0==='New field launch' && t1==='First match at the pitch',
  `each date has its own topic: ${JSON.stringify([t0,t1])}`);
ok(t0!==t1, '  CONTROL: which is the point, they differ');

// ══ 3. A CODE PER CHANNEL ════════════════════════════════════════════════════
// "eventually, we could have multiple codes (for different channels for example)"
ok(await val(C('wa')+' [data-testid="code"]')==='SEP20', 'WhatsApp carries its own code');
ok(await val(C('mc')+' [data-testid="code"]')==='', 'CONTROL: and another channel carries none');
const ph = await p.$eval(C('mc')+' [data-testid="code"]', e=>e.placeholder);
ok(/none for this channel/.test(ph), `  with the empty state saying so: "${ph}"`);
ok(await p.$(C('fb')+' [data-testid="code"]')===null, 'CONTROL: an off channel has no code field at all');

// ══ 4. A CHANNEL ON WITH NO DATE IS STILL A REAL STATE ═══════════════════════
// Migration 0128: "push_at NULL is a real state, not an absence ... the channels
// are chosen and the send time is not settled yet."
ok(await p.$eval(C('ks'), e=>e.dataset.on)==='1', 'Klaviyo SMS is on');
ok(await p.$eval(C('ks'), e=>e.dataset.pushes)==='0', '  with no push');
ok(/needs a date/.test(await T(C('ks')+' [data-testid="cnote"]')), '  and says needs a date');
const bgNeed = await p.$eval(C('ks'), e=>getComputedStyle(e).backgroundColor);
const bgOk   = await p.$eval(C('wa'), e=>getComputedStyle(e).backgroundColor);
const bgOff  = await p.$eval(C('fb'), e=>getComputedStyle(e).backgroundColor);
ok(bgNeed!==bgOk && bgNeed!==bgOff, `and looks like neither a planned nor an off channel (${bgNeed})`);
ok(/still needs a date/.test(await T('[data-testid="sum"]')), 'the footer counts it');
// turning a channel ON gives it nothing, rather than inventing a time
await p.click(C('fb')+' [data-testid="tog"]'); await p.waitForTimeout(170);
ok(await p.$eval(C('fb'), e=>e.dataset.on)==='1', 'turning a channel on');
ok(await p.$eval(C('fb'), e=>e.dataset.pushes)==='0', '  CONTROL: gives it no date, it does not invent one');
await p.click(C('fb')+' [data-testid="tog"]'); await p.waitForTimeout(170);
ok(await p.$eval(C('fb'), e=>e.dataset.on)==='0', 'and off again');

// ══ 5. THE PUSH TIME IS THE READER'S, THE MATCH TIME IS THE PITCH'S ══════════
// Ryan: "Teresa who does this work is in Spain but us in the US need to see it
// locally. The times of the matches dont change just the push times."
await load(); await go('chi');
const kickChi = await T('[data-testid="kick"]');
const pushChi = await val(C('wa')+' [data-testid="at"]');
const relChi  = await T(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="rel"]');
await go('mad');
const kickMad = await T('[data-testid="kick"]');
const pushMad = await val(C('wa')+' [data-testid="at"]');
const relMad  = await T(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="rel"]');
ok(kickChi===kickMad, `the match time does not move: "${kickChi}" in both`);
ok(/at the pitch/.test(kickChi), '  and says whose clock it is');
ok(pushChi!==pushMad, `the push time does: ${pushChi} in Austin, ${pushMad} in Madrid`);
ok(relChi===relMad, `CONTROL: and the offset to kickoff is the same number in both: "${relChi}"`);
ok(/Europe\/Madrid/.test(await T('[data-testid="z-label"]')), 'the zone is named, so nobody guesses');
await go('chi');
ok(/America\/Chicago/.test(await T('[data-testid="z-label"]')), '  CONTROL: and it follows the reader');

// SWITCHING TO VENUE TIME SHOWS THE PITCH'S CLOCK, WITHOUT MOVING ANYTHING.
await go('venue');
const pushVen = await val(C('wa')+' [data-testid="at"]');
ok(/America\/New_York/.test(await T('[data-testid="z-label"]')), 'venue time can be asked for explicitly');
ok(pushVen!==pushChi, `  and reads differently again (${pushVen})`);
ok(await T('[data-testid="kick"]')===kickChi, '  CONTROL: the match time STILL does not move');
ok(relChi===await T(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="rel"]'),
  '  CONTROL: nor does the offset to kickoff');

// ══ 6. EDITING IN ONE ZONE MEANS THE SAME INSTANT IN THE OTHER ═══════════════
// The trap: type 9:00 AM in Madrid and have it land at 9:00 AM Central.
await go('mad');
await p.fill(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="at"]', '2026-09-14T09:00');
await p.dispatchEvent(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="at"]', 'change');
await p.waitForTimeout(200);
const editedMad = await val(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="at"]');
ok(editedMad==='2026-09-14T09:00', 'a time typed in Madrid reads back as typed');
await go('chi');
const editedChi = await val(C('wa')+' [data-testid="push"][data-i="0"] [data-testid="at"]');
ok(editedChi==='2026-09-14T02:00',
  `and in Austin the SAME INSTANT reads ${editedChi}, seven hours earlier, not the same digits`);

// ══ 7. THE TILE SUMMARISES IN THE READER'S CLOCK ═════════════════════════════
await load(); await go('chi');
const tileChi = await T('[data-testid="tile-plan"]');
await go('mad');
const tileMad = await T('[data-testid="tile-plan"]');
ok(/and 2 more/.test(tileChi), `the tile says the first push and how many more: "${tileChi}"`);
ok(tileChi!==tileMad, '  in the reader\'s own clock');
ok(/Sep/.test(tileMad), '  CONTROL: still a real date, not a relative mush');
const chips = await T('[data-testid="tile-chips"]');
ok(/WA/.test(chips) && /MC/.test(chips) && /KS/.test(chips), `and every on channel has a chip: "${chips}"`);
ok(!/FB/.test(chips), '  CONTROL: an off one does not');

// ══ 8. THE FOOTER COUNTS WHAT IS ACTUALLY PLANNED ════════════════════════════
const sum = await T('[data-testid="sum"]');
ok(/3 channels/.test(sum), `three channels on: "${sum}"`);
ok(/3 pushes/.test(sum), '  three pushes across them');
ok(/1 with a code/.test(sum), '  and one code');

// ══ 9. SIZES ═════════════════════════════════════════════════════════════════
for (const w of [390, 1100]){
  await load(w);
  for (const s of ['chi','mad','venue']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('chi');
  const ih = await p.$$eval('[data-testid="at"], [data-testid="topic"], [data-testid="code"]',
    es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(ih>=32, `  every field is ${Math.round(ih)}px`);
  const rm = await p.$$eval('[data-testid="rm"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().width)));
  ok(rm>=32, `  and the remove control ${Math.round(rm)}px`);
  const over = await p.$$eval('[data-testid="push"]', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
  ok(over===0, '  no push row overflows its own box');
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
