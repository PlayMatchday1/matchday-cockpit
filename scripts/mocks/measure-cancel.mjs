import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:900,height:800} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=900,h=800) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/cancel-truth.html'); await p.waitForTimeout(170); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(150); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };
const R = id => `[data-testid="row"][data-id="${id}"]`;

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. ONE OF TWO FACTS IS THROWN AWAY ═══════════════════════════════════════
// Player 90289, Ann Richards, Sep 12. He cancelled. Then we cancelled the match.
// The row says only that WE did, which is the half that does not decide the money.
await go('before');
ok(await T(R(1)+' [data-testid="badge"]')==='WE CANCELLED',
  'today the row says only WE CANCELLED, on a booking the player had already pulled');
ok(!/cancelled/i.test((await T(R(1))).replace('WE CANCELLED','')), '  and his own cancellation appears nowhere on the row');
ok(await p.$eval(R(1), e=>e.dataset.state)==='club_cancelled', '  CONTROL: one state, one winner');

await go('after');
ok(await T(R(1)+' [data-testid="badge"]')==='BOTH CANCELLED',
  'both facts now survive on the badge');
// ══ 1b. THE TIME, BECAUSE THE TIME IS WHAT DECIDES THE CREDIT ════════════════
// "Sep 11" does not answer a billing question. How close to kickoff he pulled out
// does, and playerProfile.ts:116 already computes exactly this for strike logs.
const cx1 = await T(R(1)+' [data-testid="cx"]');
ok(/25\.8h before kickoff/.test(cx1), `the row leads with the hours to kickoff: "${cx1}"`);
ok(/Sep 11, 5:12 PM/.test(cx1), '  and the clock time at the pitch, not in UTC');
ok(cx1.indexOf('25.8h') < cx1.indexOf('Sep 11'), '  CONTROL: hours first, timestamp second');
ok(await p.$eval(R(1), e=>e.dataset.state)==='both_cancelled', '  the row carries both, not a winner');

// A CANCEL WITH NO TIMESTAMP SAYS SO RATHER THAN GUESSING ONE.
const cx5 = await T(R(5)+' [data-testid="cx"]');
ok(/Time not recorded/.test(cx5), `a cancel the mirror has no timestamp for says so: "${cx5}"`);
ok(!/0h|NaN|Invalid/.test(cx5), '  CONTROL: and never invents a zero or an NaN');

// ══ 2. THE THREE SINGLE CASES STAY DISTINGUISHABLE ═══════════════════════════
// A badge that says "both" is only useful if it cannot be confused with either.
ok(await T(R(2)+' [data-testid="badge"]')==='WE CANCELLED', 'CONTROL: a match we alone called off still says WE CANCELLED');
ok(await p.$(R(2)+' [data-testid="cx"]')===null, '  CONTROL: and carries no cancel line, because the player did not');
ok(await T(R(3)+' [data-testid="badge"]')==='THEY CANCELLED', 'CONTROL: a player who alone pulled out still says THEY CANCELLED');
const cx3 = await T(R(3)+' [data-testid="cx"]');
ok(/1\.5h before kickoff/.test(cx3), `CONTROL: a LATE cancel reads as ninety minutes, not "Aug 29": "${cx3}"`);
ok(/Aug 29, 5:30 PM/.test(cx3), '  CONTROL: in the pitch\'s clock');
ok(await T(R(4)+' [data-testid="badge"]')==='PLAYED', 'CONTROL: a played match is untouched');
const states = await p.$$eval('[data-testid="row"]', es=>es.map(e=>e.dataset.state));
ok(new Set(states).size===4, `the states in play: ${JSON.stringify(states)}`);
// colour is on top of the words, never instead of them
const cBoth = await p.$eval(R(1)+' [data-testid="badge"]', e=>getComputedStyle(e).backgroundColor);
const cClub = await p.$eval(R(2)+' [data-testid="badge"]', e=>getComputedStyle(e).backgroundColor);
ok(cBoth!==cClub, `  and BOTH does not wear WE CANCELLED's colour (${cBoth} vs ${cClub})`);

// ══ 3. $0.00 IS A CLAIM ABOUT MONEY ══════════════════════════════════════════
// mergeHistory:100 says "NOT ZERO. The mirror does not carry what this booking
// cost, and 0 is a claim about money" — and then sets price: 0. PlayerLookup
// prints money(price), so the row reads $0.00 while Stripe below shows $25.98.
await go('before');
ok(await T(R(1)+' [data-testid="amt"]')==='$0.00',
  'today a mirror-only row prints $0.00, which reads as "he was not charged"');
await go('after');
ok(await vis(R(1)+' [data-testid="amt-unknown"]'), 'unknown now prints as unknown');
ok(!/\$0\.00/.test(await T(R(1)+' [data-testid="amt"]')), '  CONTROL: and never as a number');
const tip = await p.$eval(R(1)+' [data-testid="amt-unknown"]', e=>e.getAttribute('title'));
ok(/does not carry/.test(tip) && /Stripe/.test(tip), `  with where the real number is: "${tip.slice(0,56)}…"`);
ok(await T(R(3)+' [data-testid="amt"]')==='$25.98',
  'CONTROL: a row whose price we DO have still prints it');
ok(await p.$(R(4)+' [data-testid="amt-unknown"]')===null, '  CONTROL: and so does a played one');

// ══ 4. THE FOOTNOTE SAYS WHAT WE DO NOT KNOW ═════════════════════════════════
const foot = await T('[data-testid="foot"]');
ok(/never says who went first/.test(foot), 'the footnote refuses to claim an order we cannot prove');
ok(/not that it was free/.test(foot), '  and that an unknown price is not a zero one');
ok(!/—/.test(foot), '  CONTROL: no em-dash');

// ══ 5. THE TWO CODE PATHS DISAGREE, WHICH IS THE DEEPER BUG ══════════════════
await go('paths');
const vm = await T('[data-testid="v-mirror"]'), vp = await T('[data-testid="v-profile"]');
ok(/WE CANCELLED/.test(vm), `mirrorHistory resolves both-true to: ${vm.slice(0,46)}…`);
ok(/THEY CANCELLED/.test(vp), `playerProfile resolves the SAME case to the opposite: ${vp.slice(0,48)}…`);
ok(vm!==vp, 'CONTROL: the two paths genuinely disagree, so the badge depends on which row won the merge');
ok(/no winner to pick/.test(await T('[data-testid="v-fix"]')),
  'and two booleans remove the question rather than answering it twice');

// ══ 6. SIZES ═════════════════════════════════════════════════════════════════
for (const w of [390, 900]){
  await load(w);
  for (const s of ['before','after','paths']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('after');
  const clip = await p.$$eval('[data-testid="badge"]', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
  ok(clip===0, `  no badge is clipped at ${w}, including BOTH CANCELLED`);
  /* THE ONE THAT CAUGHT MY OWN MOCK. Four fixed columns leave the title about
     60px at 390 and "Ann Richards" renders one letter per line. A height check
     catches that whatever causes it; a width check on the badge alone did not. */
  const tall = await p.$$eval('[data-testid="row"]',
    es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(Math.max(...tall)<=120, `  no row is taller than ${Math.max(...tall)}px, so nothing is set one letter per line`);
  const titleW = await p.$$eval('[data-testid="row"] .mtitle',
    es=>Math.min(...es.map(e=>Math.round(e.getBoundingClientRect().width))));
  ok(titleW>=150, `  and the match name gets ${titleW}px, not a sliver`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
