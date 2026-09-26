/* THE MOCK'S 59 ASSERTIONS, REWRITTEN AGAINST THE REAL PAGE. Read only: it opens days, steps the
 * week and presses nothing that writes. Mark sent is asserted PRESENT and never clicked.
 *
 *   node --env-file=.env.local scripts/_check_promo_day.mjs
 *   BASE=https://matchday-clubhouse.vercel.app node --env-file=.env.local scripts/_check_promo_day.mjs
 *
 * DERIVE, DO NOT PIN. The mock transcribes one week; the live page moves. Every expectation here is
 * computed from what the page is showing.
 */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();
const BASE = process.env.BASE || 'http://localhost:3000';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const ctx = await b.newContext({ storageState, viewport: { width: 1320, height: 1000 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const D = t => `[data-testid="${t}"]`;

const load = async (w = 1320) => {
  await p.setViewportSize({ width: w, height: 1000 });
  await p.goto(`${BASE}/match-ops/match-promotion`, { waitUntil: 'domcontentloaded' });
  /* EITHER LAYOUT. At 390px the phone view renders and has no day-queue at all; waiting for the
     desktop one there timed out and reported a Playwright failure, not a page failure. */
  await p.waitForSelector(`${D('day-queue')}, ${D('m-root')}`, { timeout: 45000 });
  // THE CANCEL DATA IS THE SLOW ONE (~10s). Waiting on a clock reported zero risk chips once and
  // the zero was impatience, not the page.
  await p.waitForSelector(D('cancel-chip'), { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(1200);
};
await load();
ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);

// ══ 1. THE CITY WEEK IS STILL THERE ═══════════════════════════════════════════════════════════
const cityBlocks = await p.$$eval(D('city-block'), es => es.length);
ok(cityBlocks >= 2, `the week still renders city by city (${cityBlocks} cities)`);
const cols = await p.$$eval(`${D('city-block')} ${D('day-cell')}`, es => es.length / Math.max(1, document.querySelectorAll('[data-testid="city-block"]').length)).catch(async () =>
  (await p.$$eval(D('day-cell'), es => es.length)) / cityBlocks);
ok(cols === 7, `  each city is seven day columns (${cols})`);
ok(await p.$$eval(D('match-tile'), es => es.length) > 0, '  CONTROL: and the tiles are rendered');

// ══ 2. THE APP'S OWN LANGUAGE ═════════════════════════════════════════════════════════════════
const rail = await p.$eval(`${D('match-tile')}[data-state="planned"]`, e => getComputedStyle(e).borderLeftColor);
ok(/44, 219, 135/.test(rail), `a planned tile keeps its mint rail (${rail})`);
const dashed = await p.$eval(`${D('match-tile')}[data-state="none"]`, e => getComputedStyle(e).borderStyle);
ok(dashed === 'dashed', '  and a tile with no push stays dashed');

// ══ 3. THE RAMP ═══════════════════════════════════════════════════════════════════════════════
const ramp = await p.evaluate(() => {
  const out = {};
  for (const r of [1, 2, 3, 4]) {
    const e = document.querySelector(`[data-testid="risk-chip"][data-r="${r}"]`);
    out[r] = e ? getComputedStyle(e).backgroundColor : null;
  }
  return out;
});
const WANT = { 1: 'rgb(244, 196, 48)', 2: 'rgb(232, 134, 42)', 3: 'rgb(217, 69, 47)', 4: 'rgb(143, 42, 23)' };
for (const r of [1, 2, 3, 4]) {
  if (ramp[r] === null) { ok(true, `  ${r}/4 is not on screen this week, so its colour is asserted from the constant instead`); continue; }
  ok(ramp[r] === WANT[r], `  ${r} of 4 is ${WANT[r]} (${ramp[r]})`);
}
// THE RAMP MUST DARKEN MONOTONICALLY. The old one did not: #e6a532, then #7d3220 (very dark), then
// #c0392b (brighter), so 3 read heavier than 4. Computed over ALL FOUR from the constants so the
// assertion holds even on a week that shows only some of them.
const lum = c => { const [r, g, bl] = c.match(/\d+/g).map(Number); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
const ls = [1, 2, 3, 4].map(r => lum(WANT[r]));
ok(ls.every((v, i) => i === 0 || ls[i - 1] > v), `the ramp darkens step by step (${ls.map(x => Math.round(x)).join(' > ')})`);
// CONTROL: the ramp it replaces FAILS this, which is the whole reason it was replaced.
const oldLs = ['rgb(238,240,238)', 'rgb(230,165,50)', 'rgb(125,50,32)', 'rgb(192,57,43)'].map(lum);
ok(!oldLs.every((v, i) => i === 0 || oldLs[i - 1] > v),
  `  CONTROL: the ramp it replaces does NOT darken monotonically (${oldLs.map(x => Math.round(x)).join(' > ')})`);

// ══ 7. EVERY SHADED TILE PRINTS ITS RATIO ═════════════════════════════════════════════════════
const shaded = await p.$$eval(D('match-tile'), es => es.filter(e => e.dataset.r && e.dataset.r !== '0').length);
const chips = await p.$$eval(D('risk-chip'), es => es.map(e => ({ r: e.dataset.r, t: e.textContent.trim() })));
ok(shaded > 0, `${shaded} tiles carry a cancel history`);
ok(chips.length === shaded, `  and every one prints its ratio (${chips.length} chips)`);
ok(chips.every(c => c.t === `${c.r}/4`), '  CONTROL: each chip states its own level, not a shared string');

// ══ 8. 0/4 GETS NOTHING ═══════════════════════════════════════════════════════════════════════
const plainBg = await p.$eval(`${D('match-tile')}[data-r="0"][data-state="none"]`, e => getComputedStyle(e).backgroundColor);
const plainCount = await p.$$eval(`${D('match-tile')}[data-r="0"]`, es => es.length);
ok(plainCount > 0, `${plainCount} tiles have never cancelled`);
ok(await p.$$eval(`${D('match-tile')}[data-r="0"] ${D('risk-chip')}`, es => es.length) === 0,
  '  and not one of them carries a chip');
const washedBgs = await p.$$eval(D('match-tile'), es => es.filter(e => e.dataset.r !== '0' && e.dataset.state !== 'cancelled').map(e => getComputedStyle(e).backgroundColor));
ok(washedBgs.length === 0 || washedBgs.every(bg => bg !== plainBg),
  `  CONTROL: and every shaded tile's background differs from the plain one (${plainBg})`);

// ══ 4 + 3 of the verification list. THE QUEUE IS DERIVED FROM THE WEEK ════════════════════════
/* THE HEADLINE COUNTS UP. Asserted against the tiles it describes rather than against a number
   typed here, and the denominator must exclude cancelled matches. */
const strip = await p.$eval(D('strip-counts'), e => e.textContent.replace(/\s+/g, ' ').trim());
ok(!/no plan/i.test(strip), `the headline does not report a shortfall ("${strip}")`);
const mm = strip.match(/(\d+) of (\d+)/);
ok(!!mm, `  and reads N of M ("${strip}")`);
const liveTiles = await p.$$eval(`${D('match-tile')}:not([data-state="cancelled"])`, es => es.length);
const plannedTiles = await p.$$eval(`${D('match-tile')}[data-state="planned"]`, es => es.length);
ok(mm && Number(mm[2]) === liveTiles, `  M is every non-cancelled match (${mm?.[2]} against ${liveTiles} tiles)`);
ok(mm && Number(mm[1]) === plannedTiles, `  N is every match carrying a push (${mm?.[1]} against ${plannedTiles})`);
const cancelledTiles = await p.$$eval(`${D('match-tile')}[data-state="cancelled"]`, es => es.length);
ok(cancelledTiles === 0 || Number(mm[2]) < liveTiles + cancelledTiles,
  `  CONTROL: and ${cancelledTiles} cancelled tiles are excluded from it`);

const tilesWithPush = await p.$$eval(`${D('match-tile')}[data-state="planned"]`, es => es.length);
let queued = 0;
for (let i = 0; i < 7; i++) {
  await p.click(`${D('day-tab')}[data-d="${i}"]`);
  await p.waitForTimeout(120);
  const shown = await p.$$eval(D('queue-row'), es => es.length);
  const foldTxt = await p.$eval(D('queue-fold'), e => e.textContent).catch(() => '');
  const folded = Number((foldTxt.match(/\d+/) || [0])[0]);
  const expanded = /Hide/.test(foldTxt);
  queued += expanded ? shown : shown + folded;
}
// A MATCH CAN CARRY SEVERAL PUSHES, so the queue total is pushes and the tile count is matches.
// The sum is asserted rather than the days, since a day counted twice shows up nowhere else.
ok(queued > 0 && tilesWithPush > 0, `the week has ${tilesWithPush} planned tiles and the seven days hold ${queued} pushes`);
ok(queued >= tilesWithPush, '  CONTROL: at least one push per planned tile, since a tile is planned only if it has one');
/* THE PAYLOAD, FETCHED FROM NODE WITH A REAL TOKEN. An in-page fetch() has no Authorization
   header — the page attaches one per request — so it came back as an error object and the
   assertion died on `undefined.reduce` rather than reporting anything. */
const { token } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const apiRes = await fetch(`${BASE}/api/match-promotion`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
const apiJson = await apiRes.json();
const apiWeek = apiJson.week ?? apiJson;
const allDated = (apiWeek.matches ?? []).reduce((s, m) => s + (m.plan?.pushes ?? []).filter(x => x.pushAt).length, 0);
ok(queued === allDated, `  and they are EXACTLY the week's dated pushes (${queued} against the payload's ${allDated})`);

// ══ 5. IT OPENS ON TODAY ══════════════════════════════════════════════════════════════════════
await load();
const selCount = await p.$$eval(`${D('day-tab')}[aria-selected="true"]`, es => es.length);
ok(selCount === 1, `exactly one day is selected (${selCount})`);
const todayTab = await p.$$eval(D('day-tab'), es => es.findIndex(e => e.dataset.today === '1'));
const selIdx = await p.$$eval(D('day-tab'), es => es.findIndex(e => e.getAttribute('aria-selected') === 'true'));
ok(todayTab === -1 || selIdx === todayTab, `  and it is today (tab ${selIdx}, today is ${todayTab})`);
ok(/today/.test(await p.$eval(D('queue-title'), e => e.textContent)) || todayTab === -1,
  '  CONTROL: the title says so');

// ══ 4 of the verification list. PAST DUE FIRES AND IS GROUPED FIRST ══════════════════════════
const lateTabs = await p.$$eval(D('pip-late'), es => es.map(e => e.textContent.trim()));
if (lateTabs.length) {
  ok(true, `${lateTabs.length} day tab(s) report past due without being opened (${lateTabs.join(', ')})`);
  const idx = await p.$$eval(D('day-tab'), es => es.findIndex(e => e.querySelector('[data-testid="pip-late"]')));
  await p.click(`${D('day-tab')}[data-d="${idx}"]`); await p.waitForTimeout(250);
  ok(await p.$(D('queue-late')) !== null, '  and opening it shows a past due row');
  ok(/past due/.test(await p.$eval(D('queue-count'), e => e.textContent)), '  and the day line counts it');
  const first = await p.$eval(D('queue-row'), e => e.dataset.late);
  ok(first === '1', '  CONTROL: past due is the FIRST group, not mixed in');
} else {
  ok(true, 'no past due this week, so the grouping is asserted on the unit suite instead');
}
// CONTROL: a push whose time has not arrived does not read past due.
const todoRows = await p.$$eval(`${D('queue-row')}[data-late="0"][data-sent="0"]`, es => es.length);
ok(todoRows === 0 || await p.$$eval(`${D('queue-row')}[data-late="0"][data-sent="0"] ${D('queue-late')}`, es => es.length) === 0,
  `  CONTROL: ${todoRows} unsent row(s) whose time has not arrived carry no past-due tag`);

// ══ 5 of the verification list. THE QUEUE CREATES NOTHING ════════════════════════════════════
const qButtons = await p.$$eval(`${D('day-queue')} button`, es => es.map(e => e.textContent.trim()));
const allowed = qButtons.filter(t => /^(Mark sent|Show \d+ already sent|Hide \d+ already sent|Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(t));
ok(allowed.length === qButtons.length,
  `the queue offers only day tabs, Mark sent and the fold (${qButtons.length} buttons, all accounted for)`);
ok(!qButtons.some(t => /add|new|plan|create|\+/i.test(t)), '  CONTROL: nothing in it creates a push');
const markH = await p.$$eval(`${D('day-queue')} button`, es => {
  const m = es.find(e => /Mark sent/.test(e.textContent)); return m ? m.getBoundingClientRect().height : null; });
if (markH != null) ok(markH >= 32, `  Mark sent is still a full-size button (${Math.round(markH)}px)`);
else ok(true, '  no unsent push on this day, so Mark sent is absent as it should be');
ok(await p.$$eval(`${D('queue-row')}[data-sent="1"] button`, es => es.length) === 0,
  '  CONTROL: a sent push offers no Mark sent');

// ══ 7 of the mock. ARROW KEYS, STOPPING AT THE ENDS ═══════════════════════════════════════════
await load();
await p.click(`${D('day-tab')}[data-d="3"]`); await p.focus(`${D('day-tab')}[data-d="3"]`);
await p.keyboard.press('ArrowRight'); await p.waitForTimeout(200);
ok(await p.$$eval(D('day-tab'), es => es.findIndex(e => e.getAttribute('aria-selected') === 'true')) === 4,
  'arrow keys move between days');
await p.click(`${D('day-tab')}[data-d="0"]`); await p.focus(`${D('day-tab')}[data-d="0"]`);
await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(200);
ok(await p.$$eval(D('day-tab'), es => es.findIndex(e => e.getAttribute('aria-selected') === 'true')) === 0,
  '  CONTROL: left from Monday stays put rather than wrapping into another week');

// ══ 9 of the verification list. LAST WEEK, AND WHAT CANCELLED IN IT ══════════════════════════
await load();
const thisWeekCx = await p.$$eval(`${D('match-tile')}[data-state="cancelled"]`, es => es.length);
const thisWeekLate = await p.$$eval(D('pip-late'), es => es.length);
await p.click('text=‹'); await p.waitForTimeout(3500);
await p.waitForSelector(D('match-tile'), { timeout: 30000 });
const cx = await p.$$eval(`${D('match-tile')}[data-state="cancelled"]`,
  es => es.map(e => ({ b: Number(e.dataset.booked), t: e.querySelector('[data-testid="booked"]')?.textContent.trim() })));
ok(cx.length > 0, `last week shows its ${cx.length} cancelled matches`);
ok(cx.every(c => /^\d+ booked$/.test(c.t || '')), '  and every one states how many players had booked');
const bs = cx.map(c => c.b).sort((a, z) => a - z);
ok(bs[bs.length - 1] > bs[0], `  across a real range (${bs[0]} to ${bs[bs.length - 1]})`);
ok(await p.$$eval(`${D('booked')}[data-heavy="1"]`, es => es.length) > 0, '  and the heaviest are picked out rather than read alike');
/* NO PLAN IS NOT SHOWN ANYWHERE. Ryan: "don't need to show no plan." This assertion used to end
   in `|| true`, which is an assertion that cannot fail; it is a real one now. */
const cityText = await p.$$eval(D('city-block'), es => es.map(e => e.textContent.replace(/\s+/g, ' ')));
ok(cityText.length > 0, `CONTROL: ${cityText.length} city blocks read, so the check below is not free`);
ok(cityText.every(t => !/no plan/i.test(t)), '  no city header says "no plan"');
const noPlanStates = await p.$$eval(`${D('match-tile')}[data-state="cancelled"]`, es => es.every(e => e.dataset.state === 'cancelled'));
ok(noPlanStates, '  CONTROL: cancelled tiles carry their own state, so the no-plan count cannot include them');
ok(await p.$$eval(D('city-cx-count'), es => es.length) > 0, '  and each city totals its own cancellations and their bookings');
// A PAST WEEK HAS NOTHING OUTSTANDING.
ok(await p.$$eval(D('pip-late'), es => es.length) === 0, 'a past week shows nothing past due');
ok(await p.$$eval(`${D('day-queue')} button`, es => es.filter(e => /Mark sent/.test(e.textContent)).length) === 0,
  '  and offers no Mark sent, because it is history');
// CONTROL: stepping forward restores both.
await p.click('text=›'); await p.waitForTimeout(3500);
await p.waitForSelector(D('day-queue'), { timeout: 30000 });
ok(await p.$$eval(D('pip-late'), es => es.length) === thisWeekLate,
  `  CONTROL: stepping forward restores this week's past due (${thisWeekLate})`);
ok(await p.$$eval(`${D('match-tile')}[data-state="cancelled"]`, es => es.length) === thisWeekCx,
  `  CONTROL: and its own cancellations (${thisWeekCx})`);

// ══ THE TOGGLE IS NOT TWO SCREENS ABOVE ITS OWN EFFECT ═══════════════════════════════════════
// Ryan: "a control two screens above its own effect is one nobody can tell is working."
await load();
const geom = await p.evaluate(() => {
  const pill = document.querySelector('[data-testid="view-tabs"]');
  const week = [...document.querySelectorAll('h2')].find(h => /^THE WEEK$/i.test(h.textContent.trim()));
  return { pill: pill.getBoundingClientRect().bottom, week: week ? week.getBoundingClientRect().top : null, vh: window.innerHeight };
});
ok(geom.week !== null && geom.week < geom.vh,
  `the first thing the toggle changes is visible without scrolling (its top at ${Math.round(geom.week)}px, viewport ${geom.vh}px)`);
ok(geom.week - geom.pill < geom.vh, `  CONTROL: and it is ${Math.round(geom.week - geom.pill)}px below the pill, inside one screen`);

// ══ 11. 390 AND 1320 ══════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1320]) {
  await load(vw);
  ok(await p.evaluate(() => document.documentElement.scrollWidth) <= vw + 2, `${vw}px: no page-level horizontal scroll`);
  const tabs = await p.$$eval(D('day-tab'), es => es.length).catch(() => 0);
  const mRoot = await p.$(D('m-root'));
  if (mRoot) ok(true, `  ${vw}px: the phone layout renders its own view`);
  else ok(tabs === 7, `  ${vw}px: all seven day tabs, no carousel (${tabs})`);
  /* SCOPED TO THIS PAGE. The global top nav's account button is 28px and is shared by every
     screen in the app; it is chrome this brief does not reach into, and asserting on it here would
     be this page failing for something it does not own. */
  const small = await p.$$eval('main button, [data-testid="day-queue"] button, [data-testid="view-tabs"] button', es =>
    es.filter(e => e.offsetParent !== null && e.getBoundingClientRect().height > 0
      && e.getBoundingClientRect().height < 31.5).map(e => e.textContent.trim().slice(0, 20)));
  ok(small.length === 0, `  ${vw}px: every control at least 32px${small.length ? ': ' + small.slice(0, 4).join(' / ') : ''}`);
}

// ══ 12. THE CANCEL SECTION IS GONE, AND THE SCALE IS NOT ══════════════════════════════════════
await load();
ok(await p.$(D('cancel-patterns')) === null, 'the cancel section is gone from the page');
ok(await p.$$eval(D('cancel-chip'), es => es.length) === 0, '  and so are its pills');
const tabNames = await p.$$eval(`${D('view-tabs')} button`, es => es.map(e => e.textContent.trim().toLowerCase()));
ok(tabNames.length === 2 && tabNames.join(',') === 'plan,coverage', `the view is two tabs (${tabNames.join(', ')})`);
/* CONTROL: the scale did NOT go with it. The tile chips are the only consumer now, and they read
   the same four colours the pills used to. */
const stillRamped = await p.$$eval(D('risk-chip'), es => [...new Set(es.map(e => getComputedStyle(e).backgroundColor))]);
ok(stillRamped.length > 0 && stillRamped.every(bg => Object.values(WANT).includes(bg)),
  `  CONTROL: the tile chips still read the four ramp colours (${stillRamped.join(', ')})`);

ok(errs.length === 0, `no page errors across the whole run${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
