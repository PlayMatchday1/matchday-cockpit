import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/push-done.html'); await p.waitForTimeout(170); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(160); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };
const J = id => `[data-testid="job"][data-id="${id}"]`;

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. TODAY THERE IS NO WAY TO SAY IT WENT OUT ══════════════════════════════
await go('before');
ok(await p.$('[data-testid="mark"]')===null, 'today a push cannot be marked at all');
ok(/6 overdue/.test(await T('[data-testid="counts"]')),
  `so the six stay overdue forever: "${await T('[data-testid="counts"]')}"`);

// ══ 2. ONE TAP, AND IT STAYS ON THE STRIP ════════════════════════════════════
// Ryan: "really simple so you can show them done and not overdue but they still
// show so everyone has visibility."
await go('after');
const marks = await p.$$('[data-testid="mark"]');
ok(marks.length===9, `every push gets a control (${marks.length})`);
ok(await T(J(1)+' [data-testid="mark"]')==='Mark sent', 'it says what it does');
const before = await T('[data-testid="counts"]');
await p.click(J(1)+' [data-testid="mark"]'); await p.waitForTimeout(160);
ok(await p.$eval(J(1), e=>e.dataset.sent)==='1', 'one tap marks it sent');
ok(await p.$(J(1))!==null, '  and the row is STILL THERE, which is the whole point');
ok(await vis(J(1)), '  CONTROL: visibly, not just in the DOM');
ok(/5 overdue/.test(await T('[data-testid="counts"]')),
  `the overdue count drops by one: "${before}" to "${await T('[data-testid="counts"]')}"`);
ok(/1 sent/.test(await T('[data-testid="counts"]')), '  and a sent count appears beside it');
ok(!/Overdue/.test(await T(J(1)+' [data-testid="when"]')), 'the row stops calling itself overdue');
ok(await T(J(1)+' [data-testid="mark"]')==='Sent', '  and the control flips to Sent');

// WHO AND WHEN, because "everyone has visibility" means everyone can see who did it.
const by = await T(J(1)+' [data-testid="sentby"]');
ok(/Sent /.test(by) && /by Ryan/.test(by), `the row records who sent it and when: "${by}"`);

// IT IS A TOGGLE, SO A MIS-TAP COSTS ONE TAP.
await p.click(J(1)+' [data-testid="mark"]'); await p.waitForTimeout(160);
ok(await p.$eval(J(1), e=>e.dataset.sent)==='0', 'tapping again undoes it');
ok(/6 overdue/.test(await T('[data-testid="counts"]')), '  and the count comes back');
ok(await p.$(J(1)+' [data-testid="sentby"]')===null, '  CONTROL: with the stamp cleared');

// ══ 3. SENT LOOKS DIFFERENT FROM OVERDUE AND FROM UPCOMING ═══════════════════
await go('done');
ok(/4 sent/.test(await T('[data-testid="counts"]')), 'four marked');
ok(/2 overdue/.test(await T('[data-testid="counts"]')), '  and two of the six are still overdue');
const bgSent = await p.$eval(J(1), e=>getComputedStyle(e).backgroundColor);
const bgLate = await p.$eval(J(4), e=>getComputedStyle(e).backgroundColor);
const bgSoon = await p.$eval(J(7), e=>getComputedStyle(e).backgroundColor);
ok(bgSent!==bgLate, `sent does not look overdue (${bgSent} vs ${bgLate})`);
ok(bgLate!==bgSoon, `  CONTROL: and overdue still does not look upcoming (${bgLate} vs ${bgSoon})`);
ok(await p.$eval(J(4), e=>e.dataset.sent)==='0', 'CONTROL: an unmarked overdue row is untouched');
ok(/Overdue/.test(await T(J(4)+' [data-testid="when"]')), '  and still says so');
// every one of the nine is still on screen
const shown = await p.$$eval('[data-testid="job"]', es=>es.length);
ok(shown===9, `all ${shown} pushes are still listed, sent ones included`);

// ══ 4. THE TWO PARAGRAPHS OF RULES GO ════════════════════════════════════════
// "also remove all this its jus tnoise"
await go('before');
ok(await vis('[data-testid="explain-1"]'), 'today the week carries two paragraphs of rules');
ok(await vis('[data-testid="explain-2"]'), '  including the whole NEW definition');
await go('after');
ok(!await vis('[data-testid="explain-1"]'), 'both go');
ok(!await vis('[data-testid="explain-2"]'), '  and so does the NEW one');

// BUT THE MEANING SURVIVES, because the badge already carried it.
ok(await vis('[data-testid="new-badge"]'), 'CONTROL: the NEW badge itself stays');
const tip = await p.$eval('[data-testid="new-badge"]', e=>e.getAttribute('title'));
ok(/was not on last week's slate/.test(tip), `and still explains itself: "${tip.slice(0,52)}…"`);
ok(/Atlanta/.test(tip), '  naming the city it compared');
ok(/Mon 7 Sep/.test(tip), '  and the week, so a wrong window is still visible rather than silent');

// ══ 5. SIZES ═════════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['before','after','done']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('done');
  const h = await p.$$eval('[data-testid="mark"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(h>=32, `  the control is ${Math.round(h)}px`);
  const tall = await p.$$eval('[data-testid="job"]', es=>Math.max(...es.map(e=>Math.round(e.getBoundingClientRect().height))));
  ok(tall<=140, `  no row is taller than ${tall}px, so nothing stacks into a paragraph`);
  const over = await p.evaluate(() => [...document.querySelectorAll('[data-testid="job"]')]
    .some(e => e.scrollWidth > e.clientWidth + 1));
  ok(!over, '  and no row overflows its own box');
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
