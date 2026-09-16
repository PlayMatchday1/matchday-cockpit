import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1100,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1100,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/promo-picker-scope.html'); await p.waitForTimeout(170); };
const set = async (k,v) => { await p.click(`.sw button[data-${k}="${v}"]`); await p.waitForTimeout(150); };
const type = async t => { await p.fill('[data-testid="user-search"]', t); await p.waitForTimeout(170); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const has = async s => (await p.$(s)) !== null;
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };
const rows = () => p.$$eval('[data-testid="row"]', es=>es.map(e=>e.dataset.id));
const JUNIOR = 'juniormafunga16@gmail.com';
// A term that hits four of the five. TWO CHARACTERS MINIMUM — the real picker returns early below
// that, and a one-character term made six of these assertions measure an empty list.
const ALL = 'gmail.com';
// NON-VACUITY. Math.min over [] is Infinity and sails past every >= assertion. Nothing here
// measures a list without first proving the list is there.
const someRows = async (n=1) => { const r = await rows(); ok(r.length>=n, `  (${r.length} rows on screen to measure)`); };

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE SCREEN RYAN IS LOOKING AT ═════════════════════════════════════════
// "it works on my admin account but not when im on warsaw account"
await set('a','admin'); await type(JUNIOR);
ok((await rows()).includes('88519'), 'the admin account finds Junior Mafunga by email');
await set('a','waw');
ok((await rows()).length===0, 'CONTROL: the Warsaw account finds nobody, on the same term');
ok(await T('[data-testid="empty"]')==='No matching users.',
  'and the only thing on screen is "No matching users." — which is false, he exists');

// AND A REFUSAL READS IDENTICALLY, which is the second half of the same bug: the picker does
// `catch { /* ignore */ }` and never checks res.ok, so a 403 renders as an empty result.
await set('e','403');
ok(await T('[data-testid="empty"]')==='No matching users.',
  'CONTROL: a server REFUSAL renders the same sentence, character for character');
ok(!await has('[data-testid="error"]'), '  with no error state at all');

// ══ 2. AN ERROR STOPS BEING AN EMPTY RESULT ══════════════════════════════════
await set('s','after');
ok(await vis('[data-testid="error"]'), 'the refusal is now an error');
ok(/not in your city/.test(await T('[data-testid="error"]')), "  carrying the server's own message");
ok(!await has('[data-testid="empty"]'), '  CONTROL: and is not dressed as an empty result');
const bgErr = await p.$eval('[data-testid="error"]', e=>getComputedStyle(e).backgroundColor);
await set('e','ok'); await type('zzzzzz');
const bgEmpty = await p.$eval('[data-testid="empty"]', e=>getComputedStyle(e).backgroundColor);
ok(bgErr!==bgEmpty, `CONTROL: a genuine empty does not look like a refusal (${bgEmpty} vs ${bgErr})`);

// ══ 3. THE BOUNDARY IS ON SCREEN BEFORE ANYTHING IS TYPED ════════════════════
// A filter nobody can see is indistinguishable from a broken screen. That is how this arrived.
await load(); await set('s','after'); await set('a','waw');
ok(await vis('[data-testid="scopeline"]'), 'the confined account is told what it is searching');
ok(/Warsaw only/.test(await T('[data-testid="scope-pill"]')), '  named');
const sl = await T('[data-testid="scopeline"]');
ok(/account city is Warsaw/.test(sl) && /booked a Warsaw match/.test(sl),
  `  and the rule spelled out: "${sl}"`);
await set('a','admin');
ok(!await vis('[data-testid="scopeline"]'), 'CONTROL: an unconfined account is told nothing, because nothing applies');

// ══ 4. THE UNION — WHO JOAO CAN NOW SEE ══════════════════════════════════════
// Home city Warsaw is 14 people and 4,187 players have no home city at all. A stated preference
// alone was never the set a Warsaw operator works with.
await set('a','waw'); await type(JUNIOR);
ok((await rows()).includes('88519'), 'Junior Mafunga, home city AUSTIN, two Warsaw bookings: found');
ok(/Played Warsaw ×2/.test(await T('[data-testid="why"]')), '  and the row says why he is here');
await type(ALL);
const ids = await rows();
ok(ids.includes('91247'), 'Manu, home city Warsaw, never played: still found');
ok(ids.includes('90724'), 'jaxson jeter, NO home city, one Warsaw booking: found');
ok(!ids.includes('41220'), 'CONTROL: Diego Ramos, Austin, no Warsaw booking: NOT found');
// the two halves are labelled differently, so a union is legible rather than mysterious
const whys = await p.$$eval('[data-testid="why"]', es=>es.map(e=>e.textContent.trim()));
ok(whys.some(w=>/Warsaw account/.test(w)) && whys.some(w=>/Played Warsaw/.test(w)),
  `both halves of the union are labelled: ${JSON.stringify([...new Set(whys)])}`);
await set('a','admin');
ok((await rows()).includes('41220'), 'CONTROL: and the admin account still sees Diego');
ok(await p.$('[data-testid="why"]')===null, '  with no scope badge, because nothing scoped him');

// ══ 5. AN EMPTY SEARCH SAYS WHICH EMPTY IT IS ════════════════════════════════
await set('a','waw'); await type('dramos');
ok((await rows()).length===0, 'searching an Austin-only player from Warsaw finds nobody');
ok(/No Warsaw player matches/.test(await T('[data-testid="empty"]')),
  `  and says so in the city's name: "${await T('[data-testid="empty"]')}"`);
ok(/1 player matched outside Warsaw/.test(await T('[data-testid="elsewhere"]')),
  '  and that he exists somewhere else, so nobody files a bug about a working filter');
await type('zzzzzz');
ok(!await has('[data-testid="elsewhere"]'),
  'CONTROL: a term that matches nobody anywhere does not claim there is someone elsewhere');

// ══ 6. THE ROW CARRIES THE CITY IT WAS JUDGED ON ═════════════════════════════
await set('a','waw'); await type('jaxson');
ok(/No home city/.test(await T('[data-testid="sub"]')),
  'a player with no home city says so rather than showing a blank');
await set('a','admin'); await type('dramos');
ok(/Austin/.test(await T('[data-testid="sub"]')), 'CONTROL: and a player with one shows it');

// ══ 7. SIZES ═════════════════════════════════════════════════════════════════
for (const w of [390, 1100]){
  await load(w);
  for (const s of ['before','after']){
    await set('s',s); await set('a','waw'); await type(ALL);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await set('s','after'); await type(ALL);
  await someRows(3);
  const h = await p.$$eval('[data-testid="add"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(h>=32, `  the add control is ${Math.round(h)}px`);
  const ih = await p.$eval('[data-testid="user-search"]', e=>e.getBoundingClientRect().height);
  ok(ih>=32, `  the search field is ${Math.round(ih)}px`);
  const over = await p.$$eval('[data-testid="row"]', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
  ok(over===0, '  no row overflows its own box');
  // the name must survive the badge at 390 — a four-column row is how a title got one letter wide
  const nw = await p.$$eval('[data-testid="row"] .nm', es=>Math.min(...es.map(e=>e.getBoundingClientRect().width)));
  ok(nw>=140, `  and the name keeps ${Math.round(nw)}px beside the badge`);
  const tall = await p.$$eval('[data-testid="row"]', es=>Math.max(...es.map(e=>Math.round(e.getBoundingClientRect().height))));
  ok(tall<=96, `  no row is taller than ${tall}px`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
