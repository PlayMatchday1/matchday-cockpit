import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:430,height:1000} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=430,h=1000) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/mobile-shell.html'); await p.waitForTimeout(200); };
const go = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(200); };
const T = s => p.$eval(s, e=>e.textContent.replace(/\s+/g,' ').trim());
const vis = async s => { const e = await p.$(s); return e ? await e.isVisible() : false; };
const box = s => p.$eval(s, e=>e.getBoundingClientRect().toJSON());
// distance from the top of the phone to the top of the app bar's title
const gap = () => p.evaluate(() => {
  const t = document.querySelector('[data-testid="appbar-title"]').getBoundingClientRect();
  const ph = document.getElementById('phone').getBoundingClientRect();
  return Math.round(t.top - ph.top);
});
const SAT = 59;

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE NOTCH IS PAID TWICE ═══════════════════════════════════════════════
// AuthGate's <main> pays max(env(safe-area-inset-top), 26px) at AuthGate.tsx:81,
// and MatchOpsMobileBar pays var(--sat) again at MatchOpsMobileBar.tsx:56. Each
// was written as though it were the top of the screen. Only one of them can be.
await go('before');
const before = await gap();
ok(before >= SAT*2 - 6, `today the title sits ${before}px down a ${SAT}px notch: the inset is charged twice`);
await go('after');
const after = await gap();
ok(after <= SAT + 8, `with one bar it sits ${after}px down, which is the notch and nothing else`);
ok(before - after >= SAT - 8, `${before - after}px of dead cream goes away`);

// CONTROL: exactly one element in the shell pays the inset, and it is the bar.
const payers = await p.evaluate(sat => {
  const els = [...document.querySelectorAll('#appbar, #main')];
  return els.filter(e => Math.round(parseFloat(getComputedStyle(e).paddingTop)) >= sat - 2)
            .map(e => e.id);
}, SAT);
ok(payers.length===1 && payers[0]==='appbar',
  `CONTROL: exactly one element pays it, and it is the bar (${JSON.stringify(payers)})`);
await go('before');
const payersBefore = await p.evaluate(sat => [...document.querySelectorAll('#appbar, #main')]
  .filter(e => Math.round(parseFloat(getComputedStyle(e).paddingTop)) >= sat - 2).map(e => e.id), SAT);
ok(payersBefore.length===2, `CONTROL: and today two do (${JSON.stringify(payersBefore)})`);

// the bar is the first thing under the status band, and content starts right below it
await go('after');
const bar = await box('#appbar'), main = await box('#main');
ok(Math.abs(main.y - (bar.y + bar.height)) <= 1, 'content starts where the bar ends, with nothing between');
ok(bar.height >= 44 + SAT - 2, `the bar's own band is still 44px under the notch (${Math.round(bar.height)})`);
const title = await box('[data-testid="appbar-title"]');
ok(title.height>=36, `and its tap target is ${Math.round(title.height)}px`);

// ══ 1b. AND THE TITLE IS PRINTED TWICE ═══════════════════════════════════════
// The bar says "Field Pipeline". The page's own H1 then says "Field Pipeline"
// again at 26px, directly under it. That band is a repetition, not a heading.
await go('before');
ok(await vis('[data-testid="page-h1"]'), 'today the page repeats the bar\'s title in a taller font');
const h1y = (await box('[data-testid="page-h1"]')).y;
const firstCard = (await box('.card')).y;
await go('after');
ok(!await vis('[data-testid="page-h1"]'), 'with one bar the duplicate heading goes');
ok(await vis('.sub'), '  CONTROL: the description stays, because it is not a duplicate of anything');
ok(await vis('.chip'), '  CONTROL: and so do the stat chips');
const firstCardAfter = (await box('.card')).y;
ok(firstCardAfter < firstCard, `the first card climbs ${Math.round(firstCard - firstCardAfter)}px in total`);
// CONTROL: a page whose H1 is NOT the bar's title keeps it
await p.evaluate(() => {
  document.querySelector('[data-testid="page-h1"]').textContent = 'Something else';
  document.querySelector('.sw button[data-s="after"]').click();
});
await p.waitForTimeout(200);
ok(await vis('[data-testid="page-h1"]'),
  'CONTROL: a heading that is NOT the bar\'s title is left alone, because it is not a repetition');
await load();

// ══ 1c. A PAGE WITH NO SIBLINGS STILL GETS THE BAR ═══════════════════════════
// This is what makes it ONE fix instead of 51. If the bar renders everywhere,
// main's top padding is zero everywhere, and no route can re-make the bug by
// mounting the bar in a container of its own.
await go('solo');
ok(await vis('[data-testid="appbar-title"]'), 'a page with no sibling screens still carries the bar');
ok(await gap() <= SAT + 8, `  at the same ${await gap()}px as every other page`);
ok(!await vis('[data-testid="appbar-chev"]'), '  with no chevron, because there is nothing to open');
ok(await p.$eval('[data-testid="appbar-title"]', e=>e.disabled)===true,
  '  and the title is not a button that does nothing');
await go('after');
ok(await vis('[data-testid="appbar-chev"]'), 'CONTROL: a section with siblings keeps its chevron');
ok(await p.$eval('[data-testid="appbar-title"]', e=>e.disabled)===false, '  CONTROL: and its title opens the sheet');

// ══ 2. THE SHEET IS A SURFACE, NOT A TOOLTIP ═════════════════════════════════
// "the hamburger view ... it's kind of mini". Four screens made a sheet that
// hugged its own content and read as a popup.
await go('growth');
const ph = await box('#phone');
const sh = await box('[data-testid="sheet"]');
ok(sh.height >= ph.height*0.6, `a 4-screen section still opens a real surface (${Math.round(sh.height)} of ${Math.round(ph.height)})`);
await go('ops');
const sh2 = await box('[data-testid="sheet"]');
ok(Math.abs(sh2.height - sh.height) <= 2, `CONTROL: and an 11-screen one is the same height (${Math.round(sh2.height)}), so the surface does not flap about`);
ok(sh2.height <= ph.height*0.82, '  CONTROL: without swallowing the whole screen');

// ══ 3. THE GROUPS THE DATA ALREADY CARRIES ═══════════════════════════════════
// RailItem.group has existed since the rail was built. The sheet threw it away.
await go('growth');
const g1 = await p.$$eval('[data-testid="sheet-group"]', es=>es.map(e=>e.textContent.trim()));
ok(g1.join("|")==='Fields|Fundraising', `Growth's own two groups render: ${JSON.stringify(g1)}`);
await go('ops');
const g2 = await p.$$eval('[data-testid="sheet-group"]', es=>es.map(e=>e.textContent.trim()));
const OPS_N = (await p.$$('[data-testid="sheet-row"]')).length;
ok(g2.length===4, `and Match Ops' four: ${JSON.stringify(g2)}`);
ok(new Set(g2).size===g2.length, '  CONTROL: each heading appears once, not once per row');

// ══ 4. SEARCH, WHEN THERE IS ENOUGH TO SEARCH ════════════════════════════════
ok(await vis('[data-testid="sheet-search"]'), 'eleven screens get a search field');
await go('growth');
ok(!await vis('[data-testid="sheet-search"]'), 'CONTROL: four screens do not, because four is a list you read');
await go('search');
const rows = await p.$$eval('[data-testid="sheet-row"] .lb', es=>es.map(e=>e.textContent.trim()));
ok(rows.length===3 && rows.every(r=>/Chat/.test(r)), `typing narrows it: ${JSON.stringify(rows)}`);
ok(rows.length < OPS_N, `  CONTROL: from ${OPS_N} down to ${rows.length}`);
ok((await p.$$('[data-testid="sheet-group"]')).length < g2.length, '  and the headings narrow with it');
await go('none');
ok(await vis('[data-testid="sheet-empty"]'), 'CONTROL: a search matching nothing says so');
ok(/No screen in Match Ops matches/.test(await T('[data-testid="sheet-empty"]')), '  naming the section it looked in');
ok((await p.$$('[data-testid="sheet-row"]')).length===0, '  CONTROL: and lists nothing');

// ══ 5. THE CURRENT SCREEN, IN THREE SIGNALS ══════════════════════════════════
await go('ops');
const cur = '[data-testid="sheet-row"][data-key="gameday"]';
const other = '[data-testid="sheet-row"][data-key="veo"]';
ok(await p.$eval(cur, e=>e.getAttribute('aria-current'))==='page', 'the current screen is marked for a screen reader');
ok(await p.$(cur+' [data-testid="row-tick"]')!==null, '  and carries a tick');
const bgC = await p.$eval(cur, e=>getComputedStyle(e).backgroundColor);
const bgO = await p.$eval(other, e=>getComputedStyle(e).backgroundColor);
ok(bgC!==bgO, `  and a tinted row (${bgC} vs ${bgO}) — three signals, never colour alone`);
ok(await p.$eval(other, e=>e.getAttribute('aria-current'))===null, 'CONTROL: another row has none of the three');
ok(await p.$(other+' [data-testid="row-tick"]')===null, '  CONTROL: no tick');

// ══ 6. THE LAST ROW CLEARS THE BOTTOM NAV ════════════════════════════════════
// The bug the existing sheet's own comment describes: the panel ran to the
// viewport floor and Player Chats rendered behind the nav, unscrollable.
await go('ops');
await p.evaluate(() => { const l = document.getElementById('list'); l.scrollTop = l.scrollHeight; });
await p.waitForTimeout(160);
const lastRow = await p.$$eval('[data-testid="sheet-row"]', es=>es[es.length-1].getBoundingClientRect().bottom);
const nav = await box('[data-testid="btmnav"]');
ok(lastRow <= nav.y + 1, `scrolled to the end, the last row sits clear of the bottom nav (${Math.round(lastRow)} vs ${Math.round(nav.y)})`);
const scrollable = await p.$eval('#list', e=>e.scrollHeight > e.clientHeight + 1);
ok(scrollable, '  CONTROL: and the list genuinely scrolls rather than being occluded');
await go('growth');
ok(!await p.$eval('#list', e=>e.scrollHeight > e.clientHeight + 1),
  'CONTROL: a short list does not invent a scrollbar');

// ══ 7. THE SCRIM STOPS AT THE STATUS BAND ════════════════════════════════════
await go('ops');
const scrim = await box('[data-testid="sheet-scrim"]');
const phone = await box('#phone');
ok(Math.round(scrim.y - phone.y) >= SAT - 2, `the scrim starts below the status band (${Math.round(scrim.y - phone.y)}px), so the clock stays readable`);

// ══ 8. THE SHEET SAYS WHAT IT IS FOR ═════════════════════════════════════════
ok(/11 screens/.test(await T('[data-testid="sheet-sub"]')), 'the sheet says how many screens are in here');
ok(/you are on Gameday Ops/.test(await T('[data-testid="sheet-sub"]')), '  and which one you are on');
const foot = await T('[data-testid="sheet-foot"]');
ok(/Sections live in the bar at the bottom/.test(foot),
  `and draws the line between the two navs: "${foot.slice(0,52)}…"`);
ok(!/—/.test(foot) && !/—/.test(await T('[data-testid="sheet-sub"]')), '  CONTROL: no em-dash in either');

// ══ 9. SIZES ═════════════════════════════════════════════════════════════════
for (const w of [390, 430]){
  await load(w);
  for (const s of ['before','after','solo','growth','ops','search']){
    await go(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await go('ops');
  const rh = await p.$$eval('[data-testid="sheet-row"]', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(rh>=56, `  rows are ${Math.round(rh)}px`);
  const si = await box('[data-testid="sheet-search-input"]');
  ok(si.height>=44, `  the search field is ${Math.round(si.height)}px`);
  const cl = await p.$$eval('[data-testid="sheet-row"] .lb', es=>es.filter(e=>e.scrollWidth>e.clientWidth+1).length);
  ok(cl===0, '  and no screen name is clipped');
  const cb = await box('[data-testid="sheet-close"]');
  ok(cb.height>=38 && cb.width>=38, `  the close button is ${Math.round(cb.width)}x${Math.round(cb.height)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
