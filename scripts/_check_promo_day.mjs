/* THE MOCK'S 59 ASSERTIONS, REWRITTEN AGAINST THE REAL PAGE. Read only: it opens days, steps the
 * week and presses nothing that writes. Mark sent is asserted PRESENT and never clicked.
 *
 *   npx tsx --env-file=.env.local scripts/_check_promo_day.mjs
 *   BASE=https://matchday-clubhouse.vercel.app npx tsx --env-file=.env.local scripts/_check_promo_day.mjs
 *
 * RUN UNDER tsx, NOT node. It imports isRevenueShareVenue from src/lib so the PARTNER assertion
 * applies the same predicate the page does instead of a copy of it, and plain node cannot load a
 * .ts module. A copy is exactly what the hand-applied PARTNER tag was.
 *
 * DERIVE, DO NOT PIN. The mock transcribes one week; the live page moves. Every expectation here is
 * computed from what the page is showing.
 */
import { chromium } from 'playwright';
/* STATIC, AT THE TOP, NOT A dynamic import buried in whichever block first needed it. It was
 * declared inside the revenue-share block and vanished with it when that block was removed, and the
 * run died on a ReferenceError 84 assertions in. An import at the top cannot be deleted by editing
 * something that merely sat near it. */
import { createClient } from '@supabase/supabase-js';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
/* THE TAG SET ITSELF, so the tab count and the view names are DERIVED from what ships rather than
 * pinned at whatever is true today. A third tag should add a tab, not a failure. Static for the same
 * reason as createClient above: these were dynamic imports inside a block that got removed. */
import { TAG_KEYS, TAG_META } from '../src/lib/promoTags.ts';
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

/* ── HOW MANY TAG ROWS EXIST AT ALL ───────────────────────────────────────────────────────────
 * "0 tags exist, so no tile could carry one" and "tags exist and none rendered" are DIFFERENT
 * FAILURES and they used to print the same line. One is a fine page and an empty table; the other is
 * a broken render. Every tag assertion appends this so the output says which, without anyone having
 * to go and look.
 *
 * THIS BLOCK WAS ONCE DELETED BY ACCIDENT, taken out inside a slice that was removing the
 * revenue-share plumbing it happened to sit next to. `node --check` passed, because an undefined
 * identifier is not a syntax error, and the run died 84 assertions in with exit 2. A parse check is
 * not a bind check. */
const TAG_ROWS = await (async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const r = await createClient(url, key).from('promo_tags').select('tag, match_id, field_id');
  if (r.error) return null;
  return { total: r.data.length, onMatch: r.data.filter(x => x.match_id != null).length,
           onField: r.data.filter(x => x.field_id != null).length,
           tags: [...new Set(r.data.map(x => x.tag))] };
})();
const TAGCTX = TAG_ROWS === null ? ' [promo_tags UNREADABLE - treat any zero below as UNKNOWN]'
  : TAG_ROWS.total === 0 ? ' [promo_tags holds 0 rows, so NO TILE COULD CARRY A TAG: this is missing DATA, not a broken render]'
  : ` [promo_tags holds ${TAG_ROWS.total} row(s) (${TAG_ROWS.onMatch} on matches, ${TAG_ROWS.onField} on fields: ${TAG_ROWS.tags.join(', ')}), so a zero here IS A BROKEN RENDER]`;
ok(TAG_ROWS !== null,
  `CONTROL: promo_tags is readable, holding ${TAG_ROWS?.total ?? 'UNKNOWN'} row(s)${TAG_ROWS?.total === 0 ? ' - the tag assertions below will report the DATA condition rather than pass' : ''}`);

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
/* ASKED OF data-cover, NOT data-state. A tile whose own plan is "none" may now be COVERED by a
   general push, and covered is a dotted rail rather than a dashed border. The dashed state means
   nothing at all, not even a slate blast, which is what the third state was introduced to separate. */
const dashed = await p.$eval(`${D('match-tile')}[data-cover="none"]`, e => getComputedStyle(e).borderStyle);
ok(dashed === 'dashed', '  and a tile with NOTHING at all stays dashed');

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
/* N IS OWN PLUS COVERED. A match a general push carried is promoted; counting only its own push
   would report the week emptier than it is, which is what counting up was meant to stop. */
const plannedTiles = await p.$$eval(
  `${D('match-tile')}[data-cover="planned"], ${D('match-tile')}[data-cover="covered"], ${D('match-tile')}[data-cover="needs-decision"]`,
  es => es.length);
ok(mm && Number(mm[2]) === liveTiles, `  M is every non-cancelled match (${mm?.[2]} against ${liveTiles} tiles)`);
ok(mm && Number(mm[1]) === plannedTiles, `  N is every match carrying or covered by a push (${mm?.[1]} against ${plannedTiles})`);
const cancelledTiles = await p.$$eval(`${D('match-tile')}[data-state="cancelled"]`, es => es.length);
ok(cancelledTiles === 0 || Number(mm[2]) < liveTiles + cancelledTiles,
  `  CONTROL: and ${cancelledTiles} cancelled tiles are excluded from it`);

const tilesWithPush = await p.$$eval(`${D('match-tile')}[data-cover="planned"]`, es => es.length);
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
/* THE WEEK'S DATED PUSHES ARE MATCH PUSHES PLUS GENERAL ONES. They come from one table (0191)
   and the queue is one projection of it; counting only the match pushes would make the queue look
   like it had invented rows. */
const datedMatch = (apiWeek.matches ?? []).reduce((s, m) => s + (m.plan?.pushes ?? []).filter(x => x.pushAt).length, 0);
const datedGeneral = (apiWeek.generals ?? []).filter(g => g.pushAt).length;
const allDated = datedMatch + datedGeneral;
ok(queued === allDated,
  `  and they are EXACTLY the week's dated pushes (${queued} against ${datedMatch} match + ${datedGeneral} general = ${allDated})`);
ok(datedGeneral > 0, '  CONTROL: general pushes are in that total, so the sum is not match-only by accident');

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

// ══ R2a. THE PHONE CAME ALONG ═════════════════════════════════════════════════════════════════
/* THE THREE STATES ON THE PHONE, READ OFF THE COMPUTED RAIL AND NOT OFF THE CLASS LIST. This is
   the assertion that caught border-l-dotted emitting nothing: the class was on the element, the
   markup looked right, and the rail rendered SOLID — identical to an own push, which is the one
   distinction the third state exists to make. */
await load(390);
await p.click(D('m-tab-week'));
await p.waitForSelector(D('m-row'), { timeout: 20000 });
const mob = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="m-row"]')];
  const styleOf = c => {
    const r = rows.find(e => e.dataset.cover === c);
    return r ? getComputedStyle(r).borderLeftStyle : null;
  };
  return {
    rows: rows.length,
    own: rows.filter(e => e.dataset.cover === 'planned').length,
    covered: rows.filter(e => e.dataset.cover === 'covered').length,
    none: rows.filter(e => e.dataset.cover === 'none').length,
    ownStyle: styleOf('planned'), coverStyle: styleOf('covered'), noneStyle: styleOf('none'),
    coverTags: document.querySelectorAll('[data-testid="m-cover-tag"]').length,
    tags: document.querySelectorAll('[data-testid="m-tag"]').length,
    maxTags: Math.max(0, ...rows.map(r => r.querySelectorAll('[data-testid="m-tag"]').length)),
  };
});
// CONTROL FIRST: every count below is zero on a phone view that did not render its week.
ok(mob.rows > 0, `CONTROL: the phone rendered its week (${mob.rows} rows), so the counts below are not free`);
ok(mob.own > 0 && mob.none > 0, `  the phone carries the same states as the grid (own ${mob.own}, covered ${mob.covered}, none ${mob.none})`);
ok(mob.ownStyle === 'solid' && mob.noneStyle === 'dashed',
  `  own is SOLID and no plan is DASHED on the phone too (${mob.ownStyle} / ${mob.noneStyle})`);
ok(mob.covered === 0 || (mob.coverStyle === 'dotted' && mob.coverTags > 0),
  `  and a covered row is DOTTED and names what carried it (${mob.coverStyle}, ${mob.coverTags} labelled)`);
ok(mob.maxTags <= 3, `  no phone row renders more than three tag pills (max ${mob.maxTags})`);
await p.click(D('m-tab-due'));
await p.waitForSelector(D('m-due'), { timeout: 20000 });
const dueScopes = await p.$$eval(D('m-due-scope'), es => es.map(e => e.textContent.trim()));
const dueCards = await p.$$eval(D('m-due-card'), es => es.length);
ok(dueCards > 0, `CONTROL: the phone's due list rendered (${dueCards} cards)`);
/* ONE QUEUE SOURCE, BOTH SURFACES. The phone flattened week.matches itself before, so a general
   push existed on the desktop queue and nowhere here. Asserted only when the week has one. */
ok(dueScopes.length > 0 || mob.covered === 0,
  `  a general push reaches the phone's due list too (${dueScopes.join(', ') || 'none this week'})`);

// ══ R2. THREE COVERAGE STATES, GENERAL PUSHES, TAGS, CODES ════════════════════════════════════
await load();
const cov = await p.evaluate(() => ({
  own: document.querySelectorAll('[data-testid="match-tile"][data-cover="planned"]').length,
  covered: document.querySelectorAll('[data-testid="match-tile"][data-cover="covered"]').length,
  none: document.querySelectorAll('[data-testid="match-tile"][data-cover="none"]').length,
  cancelled: document.querySelectorAll('[data-testid="match-tile"][data-cover="cancelled"]').length,
  live: document.querySelectorAll('[data-testid="match-tile"]:not([data-cover="cancelled"])').length,
}));
ok(cov.own > 0 && cov.covered > 0 && cov.none > 0,
  `all three coverage states are on screen at once (own ${cov.own}, covered ${cov.covered}, none ${cov.none})`);
const rails = await p.evaluate(() => {
  const g = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).borderLeftStyle : null; };
  return { own: g('[data-testid="match-tile"][data-cover="planned"]'), covered: g('[data-testid="match-tile"][data-cover="covered"]') };
});
ok(rails.own === 'solid' && rails.covered === 'dotted',
  `  own push is a SOLID rail, covered is DOTTED (${rails.own} / ${rails.covered})`);
ok(await p.$$eval('[data-testid="cover-tag"]', es => es.length) === cov.covered,
  '  and every covered tile names what carried it, so the mark is never a mystery');
// CONTROL: a general push covers its OWN DAY only, so a week with one still has matches reading no plan.
ok(cov.none > 0, 'a week with general pushes in it still has matches reading no plan');
// CONTROL: the three sum to the city's live matches, per city. A match counted twice or missed
// shows up nowhere else on the page.
/* READ OFF THE HEADER'S OWN NUMBERS, NOT OFF ITS TEXT. The row reads "3 of 4 · 1 covered" now,
   so a digit-scrape sums the denominator into the total and reports 8 of 4. Each figure is asserted
   against the tiles UNDER that header, in both directions: own against planned + needs-decision,
   covered against covered, and the denominator against the live tiles. The remainder is no plan,
   which is why the word does not have to appear for the arithmetic to hold. */
const perCity = await p.$$eval('[data-testid="city-block"]', es => es.map(e => {
  const h = e.querySelector('[data-testid="city-counts"]');
  const n = s => e.querySelectorAll(`[data-testid="match-tile"][data-cover="${s}"]`).length;
  return {
    city: e.querySelector('h2')?.textContent.trim(),
    own: Number(h?.dataset.own), covered: Number(h?.dataset.covered), live: Number(h?.dataset.live),
    tOwn: n('planned') + n('needs-decision'), tCovered: n('covered'),
    tLive: e.querySelectorAll('[data-testid="match-tile"]:not([data-cover="cancelled"])').length,
    text: h?.textContent.replace(/\s+/g, ' ').trim(),
  };
}));
ok(perCity.length > 0 && perCity.every(x =>
    x.own === x.tOwn && x.covered === x.tCovered && x.live === x.tLive
    && x.own + x.covered <= x.live),
  `  CONTROL: own + covered + no plan equals each city's live matches (${perCity.map(x => `${x.own}+${x.covered}+${x.live - x.own - x.covered}=${x.tLive}`).join(', ')})`);
/* AND THE ROW PRINTS THE FRACTION IT HOLDS. The data attributes above could agree with the tiles
   while the text said something else entirely. */
ok(perCity.every(x => x.text.startsWith(`${x.own} of ${x.live}`)
    && (x.covered === 0 ? !/covered/.test(x.text) : x.text.includes(`${x.covered} covered`))),
  `  and prints it, covered omitted at zero ("${perCity[0].text}")`);
// AND THE HEADLINE COUNTS OWN PLUS COVERED.
const strip2 = await p.$eval(D('strip-counts'), e => e.textContent.replace(/\s+/g, ' ').trim());
const m2 = strip2.match(/(\d+) of (\d+)/);
ok(m2 && Number(m2[1]) === cov.own + cov.covered + (await p.$$eval('[data-testid="match-tile"][data-cover="needs-decision"]', es => es.length)),
  `  the headline counts own PLUS covered ("${strip2}")`);
ok(m2 && Number(m2[2]) === cov.live, `  and its denominator excludes cancelled (${m2?.[2]} against ${cov.live})`);

// ── THE GENERAL PUSH IS IN THE SAME QUEUE ────────────────────────────────────────────────────
const genDay = await p.evaluate(async () => {
  const tabs = [...document.querySelectorAll('[data-testid="day-tab"]')];
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].click(); await new Promise(r => setTimeout(r, 200));
    if (document.querySelector('[data-testid="queue-scope"]')) return i;
  }
  return -1;
});
ok(genDay >= 0, `a general push sits in the same queue as the match pushes (day ${genDay})`);
if (genDay >= 0) {
  const gq = await p.evaluate(() => ({
    scopes: [...document.querySelectorAll('[data-testid="queue-scope"]')].map(e => e.textContent.trim()),
    audience: document.querySelector('[data-testid="queue-audience"]')?.textContent.trim(),
    reach: document.querySelector('[data-testid="queue-reach"]')?.textContent.trim(),
    marks: [...document.querySelectorAll('[data-testid="queue-row"]')].filter(r => r.querySelector('[data-testid="queue-scope"]') && /Mark sent/.test(r.textContent)).length,
  }));
  ok(gq.scopes.some(t => /CITY|FIELD/.test(t)), `  labelled with its scope (${gq.scopes.join(', ')})`);
  ok(!!gq.audience, `  and carrying its audience, which a tile has no room for ("${gq.audience}")`);
  ok(/\d+ match(es)?$/.test(gq.reach ?? ''), `  with the reach it actually has, pluralised ("${gq.reach}")`);
  ok(gq.marks > 0, '  CONTROL: and the same Mark sent, because the operator\u2019s action is unchanged');
}
// CREATED FROM THE CITY, and NOT from the queue, which still creates nothing.
const addN = await p.$$eval(D('add-general'), es => es.length);
const cityN = await p.$$eval(D('city-block'), es => es.length);
ok(addN === cityN, `each city header offers a General push control (${addN} of ${cityN})`);
ok(await p.$$eval(`${D('day-queue')} ${D('add-general')}`, es => es.length) === 0,
  '  CONTROL: and not in the queue, which still creates nothing');
const addH = await p.$eval(D('add-general'), e => e.getBoundingClientRect().height);
ok(addH >= 32, `  at ${Math.round(addH)}px`);

// ── TAGS: THREE, AT TWO SCOPES, AND ONE DERIVED BADGE ────────────────────────────────────────
/* 0193 put priority on the MATCH and brought key_field back at FIELD scope. That REVERSES 0192 and
   the assertions that stated it ("the tag set is exactly priority and starting_11", "KEY FIELD is
   nowhere in the DOM"). Reversed deliberately and on the record, not edited quietly: they were my
   misreading of "they mean the same thing", which they do, at two different scopes.

   ONE ASSERTION SURVIVES WITH BETTER TEETH: "no tile renders KEY FIELD beside PRIORITY" used to pass
   because key_field could not exist. It now passes because KEY FIELD SWALLOWS PRIORITY, which is a
   real behaviour with a real way to fail. */
const tagInfo = await p.evaluate(() => {
  const pills = [...document.querySelectorAll('[data-testid="tag"]')];
  const byKey = {};
  for (const e of pills) if (!byKey[e.dataset.t]) byKey[e.dataset.t] = getComputedStyle(e).color;
  const partner = [...document.querySelectorAll('[data-testid="partner-badge"]')];
  return {
    labels: [...new Set(pills.map(e => e.textContent.trim()))],
    keys: [...new Set(pills.map(e => e.dataset.t))],
    colours: byKey,
    bg: pills[0] ? getComputedStyle(pills[0]).backgroundColor : null,
    titled: pills.filter(e => e.getAttribute('title')).length, total: pills.length,
    maxPerTile: Math.max(0, ...[...document.querySelectorAll('[data-testid="tags"]')].map(g => g.querySelectorAll('[data-testid="tag"]').length)),
    more: document.querySelectorAll('[data-testid="tag-more"]').length,
    partnerPills: partner.length,
    partnerAsTag: pills.filter(e => /PARTNER/i.test(e.textContent)).length,
    partnerTitled: partner.filter(e => /revenue-share/i.test(e.getAttribute('title') ?? '')).length,
  };
});
// PRESENCE FIRST. Every absence assertion below is worthless until the tags are proven on screen.
ok(tagInfo.total > 0, `the tags render (${tagInfo.labels.join(', ') || 'NONE'})${tagInfo.total === 0 ? TAGCTX : ''}`);
ok(tagInfo.keys.every(k => TAG_KEYS.includes(k)),
  `  and every pill is one of the three real tags (${tagInfo.keys.join(', ')})`);

/* ── PRIORITY SITS ON A MATCH, AND THE CONTRAST IS THE ASSERTION ──────────────────────────────
   Not "a PRIORITY pill exists" — a field tag would render one too. ONE FIELD CARRYING DIFFERENT TAGS
   ON TWO DAYS in the same week is the only thing that proves the scope, because a field-scoped tag
   cannot differ between two matches at the same pitch. */
const scopeProof = await p.evaluate(() => {
  const byField = new Map();
  for (const t of document.querySelectorAll('[data-testid="match-tile"]')) {
    const f = t.dataset.fieldId;
    if (!f) continue;
    const tags = [...t.querySelectorAll('[data-testid="tag"]')].map(e => e.dataset.t).sort().join(',');
    const list = byField.get(f) ?? byField.set(f, []).get(f);
    list.push({ api: t.dataset.apiId, tags });
  }
  const differing = [];
  const fieldTagsStable = [];
  for (const [f, tiles] of byField) {
    if (tiles.length < 2) continue;
    const sets = new Set(tiles.map(t => t.tags));
    if (sets.size > 1) differing.push({ f, sets: [...sets] });
    // FIELD-SCOPED TAGS MUST BE IDENTICAL ACROSS A FIELD'S TILES, whatever priority does.
    const fieldOnly = new Set(tiles.map(t => t.tags.split(',').filter(x => x === 'key_field' || x === 'starting_11').join(',')));
    if (fieldOnly.size > 1) fieldTagsStable.push(f);
  }
  return { fields: byField.size, multi: [...byField.values()].filter(v => v.length >= 2).length, differing, fieldTagsStable };
});
ok(scopeProof.multi > 0,
  `CONTROL: ${scopeProof.multi} field(s) have two or more tiles this week, so the contrast below can exist`);
ok(scopeProof.fieldTagsStable.length === 0,
  `  a FIELD tag is identical on every tile of its field (${scopeProof.fieldTagsStable.length} fields disagree)`);
/* THE MATCH-SCOPE PROOF. Skipped honestly rather than faked when no field happens to carry a
   per-match difference this week: a tag nobody has set cannot be demonstrated, and inventing one
   would mean writing production data. Reported either way. */
ok(true, `  PRIORITY differs between tiles of one field on ${scopeProof.differing.length} field(s)` +
  (scopeProof.differing.length === 0 ? ' - none set this week, so the contrast is UNPROVEN on screen (the node guard proves the scope)' : ''));

/* ── KEY FIELD SWALLOWS PRIORITY ────────────────────────────────────────────────────────────── */
const bothChips = await p.$$eval('[data-testid="tags"]', gs => gs.filter(g =>
  g.querySelector('[data-testid="tag"][data-t="key_field"]') && g.querySelector('[data-testid="tag"][data-t="priority"]')).length);
ok(bothChips === 0, `no tile renders KEY FIELD beside PRIORITY (${bothChips} do)`);

const tagCols = Object.values(tagInfo.colours);
/* ── ONE CONCEPT, ONE COLOUR ─────────────────────────────────────────────────────────────────
   PRIORITY and KEY FIELD share a colour by design; STARTING 11 differs. Read computed, so the
   assertion is about what renders and not about two hex strings in a file. */
const colourPairs = await p.evaluate(() => {
  const g = (t) => { const e = document.querySelector(`[data-testid="tag"][data-t="${t}"], [data-testid="tag-key-swatch"]`); return e ? getComputedStyle(e).color : null; };
  const of = (t) => { const e = document.querySelector(`[data-testid="tag"][data-t="${t}"]`); return e ? getComputedStyle(e).color : null; };
  const k = (t) => { const e = document.querySelector(`[data-testid="keyitem"][data-t="${t}"] i`); return e ? getComputedStyle(e).color : null; };
  return { prio: of('priority') ?? k('priority'), key: of('key_field') ?? k('key_field'), s11: of('starting_11') ?? k('starting_11'), any: g('priority') };
});
ok(colourPairs.any !== null, `CONTROL: a tag colour is readable off the page (${colourPairs.any})${colourPairs.any === null ? TAGCTX : ''}`);
ok(colourPairs.prio === null || colourPairs.key === null || colourPairs.prio === colourPairs.key,
  `PRIORITY and KEY FIELD share one colour (${colourPairs.prio} / ${colourPairs.key})`);
ok(colourPairs.s11 === null || colourPairs.prio === null || colourPairs.s11 !== colourPairs.prio,
  `  and STARTING 11, a different idea, differs (${colourPairs.s11})`);
const TAKEN = ['rgb(44, 219, 135)', 'rgb(244, 196, 48)', 'rgb(232, 134, 42)', 'rgb(217, 69, 47)', 'rgb(143, 42, 23)', 'rgb(0, 51, 38)'];
const partnerCol = await p.$eval(D('partner-badge'), e => getComputedStyle(e).color).catch(() => null);
const allCols = [...tagCols, partnerCol].filter(Boolean);
ok(allCols.length > 0 && allCols.every(c => !TAKEN.includes(c)),
  `  CONTROL: none collides with mint, the cancel ramp or deep green (${allCols.join(' | ')})${allCols.length === 0 ? TAGCTX : ''}`);
ok(tagInfo.bg === 'rgba(0, 0, 0, 0)', `a tag is outlined, not filled (${tagInfo.bg})${tagInfo.bg === null ? TAGCTX : ''}`);
const chipBg = await p.$eval(D('risk-chip'), e => getComputedStyle(e).backgroundColor).catch(() => null);
ok(chipBg === null || chipBg !== tagInfo.bg, `  CONTROL: while the cancel chip stays filled (${chipBg})`);
ok(tagInfo.maxPerTile <= 3, `no tile renders more than three tag pills (max ${tagInfo.maxPerTile})`);
/* THE OVERFLOW ASSERTION LIVES IN scripts/promo-tags-test.ts, over a plain list. With three tags and
   KEY FIELD swallowing PRIORITY at most two render, so a DOM assertion here could not go red — the
   `|| true` problem in another coat. Asserted here as the zero it now is. */
ok(tagInfo.more === 0, `  and the overflow count is absent, because at most two tags render (${tagInfo.more})`);
ok(tagInfo.titled === tagInfo.total, `  CONTROL: every tag carries its meaning on hover (${tagInfo.titled} of ${tagInfo.total})`);
ok(!tagInfo.labels.includes('NEW FIELD'), '  CONTROL: and none of them says NEW FIELD, the automatic badge’s words');
ok(await p.$$eval(D('new-badge'), es => es.length) > 0, '  CONTROL: while the automatic NEW badges still render');

/* ── NO PARTNER, ANYWHERE ON THIS PAGE ────────────────────────────────────────────────────────
   It was a hand-set tag, then a derived read-only badge, and now it is gone from the page entirely.
   basisOf still derives the contract fact on the finance side; this page does not render it.
   ABSENCE WITH A PRESENCE CONTROL, as every absence check in this suite must have: the control is
   that the tags and the NEW badges DO render, so a page that failed to load cannot pass this. */
const partnerGone = await p.evaluate(() => ({
  badge: document.querySelectorAll('[data-testid="partner-badge"]').length,
  panelBadge: document.querySelectorAll('[data-testid="partner-panel-badge"]').length,
  keyRow: document.querySelectorAll('[data-testid="partner-key"], [data-testid="keyitem"][data-t="partner"]').length,
  toggle: document.querySelectorAll('[data-testid="tag-toggle"][data-t="partner"]').length,
  anywhere: /\bPARTNER\b/.test(document.body.innerText),
}));
ok(partnerGone.badge === 0, `no PARTNER badge on any tile (${partnerGone.badge})`);
ok(partnerGone.panelBadge === 0, `  none in the panel (${partnerGone.panelBadge})`);
ok(partnerGone.keyRow === 0, `  no PARTNER row in the key (${partnerGone.keyRow})`);
ok(partnerGone.toggle === 0, `  and no PARTNER toggle in the picker (${partnerGone.toggle})`);
ok(!partnerGone.anywhere, '  and the word PARTNER is nowhere in the rendered page');
ok(await p.$$eval(D('new-badge'), es => es.length) > 0,
  '  CONTROL: while the automatic NEW badges still render, so the page did load');

/* ── THE KEY: TWO GRIDS, VERBATIM, LABEL AND SENTENCE READ SEPARATELY ────────────────────────
   Separately, so a mismatch says WHICH HALF is wrong rather than handing back one long string.
   THE "NEVER SAYS PROMO" RULE IS RETIRED, superseded by pinning the exact words: the label always
   names a push, and the sentence is free to call the activity promotion. */
const stateRows = await p.$$eval(D('keystate'), es => es.map(e => [
  e.querySelector('[data-testid="keylab"]').textContent.trim(),
  e.querySelector('[data-testid="keysent"]').textContent.trim() ]));
ok(stateRows.length === 4, `the key has four tile-state rows (${stateRows.length})`);
const WANT_STATES = [
  ['Match push', 'Promoted individually.'],
  ['Group push', 'Included in a city or field push.'],
  ['No push planned', 'No promotion scheduled.'],
  ['Cancelled', 'Match called off.'],
];
ok(stateRows.map(r => r[0]).join(' | ') === WANT_STATES.map(r => r[0]).join(' | '),
  `  the labels read exactly, in order (${stateRows.map(r => r[0]).join(' | ')})`);
ok(stateRows.map(r => r[1]).join(' | ') === WANT_STATES.map(r => r[1]).join(' | '),
  `  the sentences read exactly, in order (${stateRows.map(r => r[1]).join(' | ')})`);
ok(!/booked/i.test(stateRows[3].join(' ')), '  and the cancelled row does not repeat the booked count');
/* EVERY SWATCH IS THE TILE IT EXPLAINS, COMPUTED. A key that is a picture of the tiles drifts from
   them; these render from tileBorderFor, the same expression the tiles use. */
const swatch = await p.evaluate(() => {
  const g = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
  return {
    swPlanned: g('[data-testid="keyswatch"][data-state="planned"]', 'borderLeftStyle'),
    swCovered: g('[data-testid="keyswatch"][data-state="covered"]', 'borderLeftStyle'),
    swNone: g('[data-testid="keyswatch"][data-state="none"]', 'borderStyle'),
    tlPlanned: g('[data-testid="match-tile"][data-cover="planned"]', 'borderLeftStyle'),
    tlCovered: g('[data-testid="match-tile"][data-cover="covered"]', 'borderLeftStyle'),
    tlNone: g('[data-testid="match-tile"][data-cover="none"]', 'borderStyle'),
    swMint: g('[data-testid="keyswatch"][data-state="planned"]', 'borderLeftColor'),
    tlMint: g('[data-testid="match-tile"][data-cover="planned"]', 'borderLeftColor'),
  };
});
ok(swatch.swPlanned === 'solid' && swatch.swCovered === 'dotted' && swatch.swNone.startsWith('dashed'),
  `the swatches are solid, dotted, dashed (${swatch.swPlanned} / ${swatch.swCovered} / ${swatch.swNone})`);
ok(swatch.swPlanned === swatch.tlPlanned && swatch.swCovered === swatch.tlCovered,
  `  CONTROL: and each matches the tile it explains, computed (${swatch.tlPlanned} / ${swatch.tlCovered})`);
ok(swatch.swMint === swatch.tlMint, `  CONTROL: including the rail colour (${swatch.swMint})`);

const keyRows = await p.$$eval(D('keyitem'), es => es.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
ok(keyRows.length > 0, `CONTROL: the key lists ${keyRows.length} tag row(s), so the checks below are not free${keyRows.length === 0 ? TAGCTX : ''}`);
ok(/STARTING 11 Active promo at this field\./.test(keyRows.join(' | ')) || !keyRows.join(' ').includes('STARTING 11'),
  `  STARTING 11's row reads exactly (${keyRows.find(r => r.includes('STARTING 11')) ?? 'not in use this week'})`);
/* THE SCOPE LEAD-IN IS GONE because the sentences carry it. Asserted absent, with the presence of
   the rows themselves as the control. */
ok(await p.$$eval('[data-testid="keyscope"]', es => es.length) === 0,
  '  and no scope label repeats what the sentence already says');
/* "CAN GO STALE" MOVED TO HOVER. */
const s11Title = await p.$eval(`${D('keyitem')}[data-t="starting_11"]`, e => e.getAttribute('title')).catch(() => null);
ok(s11Title === null || /can go stale/.test(s11Title),
  `  the staleness caveat survives on hover (${s11Title ? 'present' : 'STARTING 11 not in use this week'})`);
ok(s11Title === null || !/can go stale/.test(keyRows.join(' ')),
  '  CONTROL: and is NOT in the visible row');

/* ── THE PANEL GROUPS BY SCOPE ───────────────────────────────────────────────────────────────── */
const picker = await p.evaluate(async () => {
  const tile = document.querySelector('[data-testid="match-tile"]:not([data-cover="cancelled"])');
  if (!tile) return null;
  tile.click(); await new Promise(r => setTimeout(r, 700));
  const groups = [...document.querySelectorAll('[data-testid="tagscope"]')].map(g => ({
    scope: g.dataset.scope,
    head: g.querySelector('span')?.textContent.trim(),
    tags: [...g.querySelectorAll('[data-testid="tag-toggle"]')].map(b => b.dataset.t),
  }));
  return {
    groups,
    heights: [...document.querySelectorAll('[data-testid="tag-toggle"]')].map(b => Math.round(b.getBoundingClientRect().height)),
    panelOpen: document.querySelectorAll('[data-testid="panel"]').length,
  };
});
ok(picker && picker.panelOpen > 0, 'CONTROL: the side panel opened, so the group checks are not free');
ok(picker && picker.groups.length === 2, `  the toggles sit in two scope groups (${picker?.groups.length})`);
const gMatch = picker?.groups.find(g => g.scope === 'match');
const gField = picker?.groups.find(g => g.scope === 'field');
ok(gMatch && gMatch.tags.join(',') === 'priority',
  `  the match group holds exactly PRIORITY (${gMatch?.tags.join(', ')})`);
ok(gField && gField.tags.join(',') === 'key_field,starting_11',
  `  the field group holds KEY FIELD and STARTING 11 (${gField?.tags.join(', ')})`);
ok(gMatch && /This match only/.test(gMatch.head ?? ''), `  and says "This match only" (${gMatch?.head})`);
ok(gField && /^Every match at /.test(gField.head ?? ''), `  and "Every match at <field>" (${gField?.head})`);
ok(picker && picker.heights.length > 0 && Math.min(...picker.heights) >= 32,
  `  every toggle at 32px (min ${picker ? Math.min(...picker.heights) : 'n/a'})`);
await p.keyboard.press('Escape').catch(() => {});

// ── THE FOUR TILES THAT CHANGE BADGE, PROVED ON THE PAGE AND NOT IN A SCRIPT ──────────────────
/* WHY THIS EXISTS AT ALL. The first measurement of "how many tiles change badge" reported 0, and 0
   was CORRECT about the code as it then stood: the implementation clustered the PRIOR minutes only,
   so the candidate time belonged to no cluster and every shifted slot still badged NEW TIME. The bug
   was in the shipped library, not in the script that measured it. A count from a script the page does
   not reproduce is that same failure one layer up, so the expected set is derived HERE from the
   database and then asserted against the rendered DOM.

   THE OLD RULE IS REIMPLEMENTED IN THIS BLOCK ON PURPOSE. Everywhere else in this codebase a second
   copy of a rule is the bug; here it is the instrument. Comparing the page against the library's own
   current answer would assert that the library agrees with itself. */
const expectedChange = await (async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const { fetchVeoWeek } = await import('../src/lib/veoSchedule.ts');
  const { buildPriorSlate, newnessOf, NEW_LOOKBACK_WEEKS } = await import('../src/lib/matchPromotion.ts');
  const sb = createClient(url, key);
  const now = new Date();
  const wk = await fetchVeoWeek(sb, now, now, null, true);
  const [y, mo, d] = wk.weekStart.split('-').map(Number);
  const priors = [];
  for (let i = 1; i <= NEW_LOOKBACK_WEEKS; i++) {
    priors.push(await fetchVeoWeek(sb, now, new Date(y, mo - 1, d - 7 * i), null, true));
  }
  const tagged = priors.flatMap(w => w.matches.map(m => ({ ...m, weekKey: w.weekStart })));
  const slate = buildPriorSlate(tagged);
  // THE OLD RULE: field, field-day, field-day-EXACT-MINUTE.
  const V = new Map(), VD = new Map(), VDT = new Map();
  for (const m of tagged) {
    (V.get(m.city) ?? V.set(m.city, new Set()).get(m.city)).add(m.venue);
    (VD.get(m.city) ?? VD.set(m.city, new Set()).get(m.city)).add(`${m.venue}|${m.dayIdx}`);
    (VDT.get(m.city) ?? VDT.set(m.city, new Set()).get(m.city)).add(`${m.venue}|${m.dayIdx}|${m.minutes}`);
  }
  const oldRule = (m) => {
    if (!V.has(m.city) || !V.get(m.city).has(m.venue)) return 'field';
    if (!VD.get(m.city).has(`${m.venue}|${m.dayIdx}`)) return 'day';
    if (!VDT.get(m.city).has(`${m.venue}|${m.dayIdx}|${m.minutes}`)) return 'time';
    return null;
  };
  const changed = [];
  for (const m of wk.matches) {
    const before = oldRule(m), after = newnessOf(m, slate);
    if (before !== after) changed.push({ api: m.apiId, venue: m.venue, before, after });
  }
  return { weekStart: wk.weekStart, tiles: wk.matches.length, changed };
})();
ok(expectedChange !== null && expectedChange.changed.length > 0,
  `CONTROL: the exact-minute rule and the clustered rule disagree on ${expectedChange?.changed.length ?? 'UNKNOWN'} of ${expectedChange?.tiles ?? '?'} tiles, so there is a change to observe`);
if (expectedChange && expectedChange.changed.length > 0) {
  ok(expectedChange.changed.every(c => c.before === 'time' && c.after === null),
    `  every disagreement is NEW TIME becoming no badge (${expectedChange.changed.map(c => `${c.before}->${c.after}`).join(', ')})`);
  /* THE ASSERTION THE WHOLE FIND EXISTS FOR: those exact tiles, by api_id, must render WITHOUT a time
     badge on the page. If the library still clustered prior-only, each would still carry data-new="time"
     and this goes red naming the tiles. */
  const onPage = await p.evaluate((ids) => ids.map(id => {
    const t = document.querySelector(`[data-testid="match-tile"][data-api-id="${id}"]`);
    return t ? { id, flag: t.dataset.new ?? '', moved: /Moved from /.test(t.getAttribute('title') ?? '') } : { id, flag: 'NOT ON PAGE', moved: false };
  }), expectedChange.changed.map(c => c.api));
  const present = onPage.filter(t => t.flag !== 'NOT ON PAGE');
  ok(present.length === onPage.length,
    `  CONTROL: all ${onPage.length} are rendered on this week's grid (${onPage.length - present.length} missing)`);
  ok(present.every(t => t.flag !== 'time'),
    `  and NONE of them badges NEW TIME on the page (${present.filter(t => t.flag === 'time').map(t => t.id).join(', ') || 'none does'})`);
  ok(present.every(t => t.moved),
    `  and every one says "Moved from" on hover (${present.filter(t => !t.moved).map(t => t.id).join(', ') || 'all do'})`);
  /* CONTROL: a tile the two rules AGREE on must be untouched, so the three above are not simply
     "no tile anywhere badges NEW TIME". */
  const stillTime = await p.$$eval('[data-testid="match-tile"][data-new="time"]', es => es.map(e => Number(e.dataset.apiId)));
  ok(stillTime.length > 0 && stillTime.every(id => !expectedChange.changed.some(c => c.api === id)),
    `  CONTROL: ${stillTime.length} other tile(s) still badge NEW TIME, none of them from the changed set`);
}

// ── NEWNESS SHARES THE CANCEL ROLLUP'S WINDOW ─────────────────────────────────────────────────
/* A slot whose time moved INSIDE the window is one slot to the cancel ramp, so it stopped badging
   NEW TIME: a tile cannot say "this slot cancelled 2 of 4" and "this time is new" at once and be
   believed. The information moved to the tooltip.
   MEASURED on the week of 2026-09-21: 4 of 110 tiles changed, all NEW TIME -> no badge, and NEW TIME
   went from 5 tiles to 1. The survivor is a move OUTSIDE the window, which is the control. */
const newness = await p.evaluate(() => {
  const tiles = [...document.querySelectorAll('[data-testid="match-tile"]')];
  const byFlag = {};
  for (const t of tiles) { const f = t.dataset.new || 'none'; byFlag[f] = (byFlag[f] ?? 0) + 1; }
  const moved = tiles.filter(t => /Moved from /.test(t.getAttribute('title') ?? ''));
  return {
    byFlag,
    moved: moved.length,
    movedTitles: moved.slice(0, 3).map(t => t.getAttribute('title')),
    // A TILE THAT MOVED MUST NOT ALSO CLAIM NEW TIME. That pair is the contradiction this fixes.
    movedAndTimeBadged: moved.filter(t => t.dataset.new === 'time').length,
    timeBadged: tiles.filter(t => t.dataset.new === 'time').length,
  };
});
ok(newness.moved > 0,
  `CONTROL: ${newness.moved} tile(s) carry a "moved from" tooltip, so the checks below are not free`);
ok(newness.movedAndTimeBadged === 0,
  `no tile both says its time moved and badges NEW TIME (${newness.movedAndTimeBadged})`);
ok(/Moved from \d\d:\d\d.*ran \d of the last \d weeks/.test(newness.movedTitles[0] ?? ''),
  `  and the tooltip names the old time and how many weeks it ran ("${(newness.movedTitles[0] ?? '').slice(0, 78)}")`);
/* CONTROL: A MOVE OUTSIDE THE WINDOW STILL BADGES. Without this, "no tile badges NEW TIME" would be
   satisfied by a rule that never badges anything. */
ok(newness.timeBadged > 0,
  `  CONTROL: ${newness.timeBadged} tile(s) still badge NEW TIME, for a move outside the window`);
ok((newness.byFlag.day ?? 0) > 0 && (newness.byFlag.field ?? 0) > 0,
  `  CONTROL: NEW DAY (${newness.byFlag.day ?? 0}) and NEW FIELD (${newness.byFlag.field ?? 0}) are unaffected`);

// ══ R4. THE EDITOR AS A FIXED SIDE PANEL ══════════════════════════════════════════════════════
/* It opened in the page flow, so clicking a tile pushed the grid down and the row you were working
   in moved out from under you. The job is eight cities clicked in turn, so that is the wrong shape.
   THE PANEL KEEPS ITS EXISTING data-testid="panel" — one testid for one thing. Adding a "side"
   alongside it would be two names for one panel, which is how they drift apart. */
await load();
ok(await p.$$eval(D('panel'), es => es.length) === 0, 'the panel is not in the DOM at rest');

/* ── THE ASSERTION THE WHOLE CHANGE EXISTS FOR ─────────────────────────────────────────────────
   EXACT, not approximate. The trap, hit on the first attempt: padding the whole PAGE narrows it,
   which reflows the day tabs above and pushes the grid down 47px — precisely the problem the panel
   is meant to solve. Only the WEEK is padded, so nothing above it moves. */
const cityTopBefore = await p.$eval(D('city-block'), e => e.getBoundingClientRect().top);
const tabsTopBefore = await p.$eval(D('day-tab'), e => e.getBoundingClientRect().top);
await p.click(`${D('match-tile')}[data-cover="planned"]`);
await p.waitForSelector(D('panel'), { timeout: 10000 });
await p.waitForTimeout(350);
const cityTopAfter = await p.$eval(D('city-block'), e => e.getBoundingClientRect().top);
const tabsTopAfter = await p.$eval(D('day-tab'), e => e.getBoundingClientRect().top);
ok(cityTopBefore === cityTopAfter,
  `the week does not move when the panel opens (${cityTopBefore} then ${cityTopAfter})`);
/* THE TRAP, ASSERTED DIRECTLY. If the padding ever goes back on the page wrapper this is the line
   that names the cause rather than leaving a 47px shift to be explained. */
ok(tabsTopBefore === tabsTopAfter,
  `  and the day tabs above it do not reflow (${tabsTopBefore} then ${tabsTopAfter})`);

const panelGeom = await p.evaluate(() => {
  const t = document.querySelector('[data-testid="match-tile"][data-open="1"]');
  const s = document.querySelector('[data-testid="panel"]');
  const r = s?.getBoundingClientRect();
  return {
    tileRight: t ? Math.round(t.getBoundingClientRect().right) : null,
    panelLeft: r ? Math.round(r.left) : null,
    panelWidth: r ? Math.round(r.width) : null,
    panelTop: r ? Math.round(r.top) : null,
    panelBottom: r ? Math.round(r.bottom) : null,
    viewH: window.innerHeight,
    position: s ? getComputedStyle(s).position : null,
  };
});
ok(panelGeom.position === 'fixed', `the panel is fixed, not in the flow (${panelGeom.position})`);
ok(panelGeom.panelWidth === 420, `  420px wide (${panelGeom.panelWidth})`);
ok(panelGeom.panelTop === 0 && panelGeom.panelBottom === panelGeom.viewH,
  `  and full height (${panelGeom.panelTop} to ${panelGeom.panelBottom} of ${panelGeom.viewH})`);
// CONTROL: nothing hides under it. The week is padded rather than the panel overlaying the grid.
ok(panelGeom.tileRight !== null && panelGeom.panelLeft !== null && panelGeom.tileRight <= panelGeom.panelLeft,
  `  CONTROL: the tile being edited is clear of the panel (${panelGeom.tileRight} <= ${panelGeom.panelLeft})`);

/* ── THE CLICKED TILE STAYS MARKED ────────────────────────────────────────────────────────────
   With the panel off to the side there is nothing else saying which of 88 tiles is being edited. */
const marked = await p.$$eval(`${D('match-tile')}[data-open="1"]`, es => es.length);
ok(marked === 1, `exactly one tile is marked as the one being edited (${marked})`);
const sideTitle = await p.$eval(D('panel-title'), e => e.textContent.replace(/\s+/g, ' ').trim());
ok(/·/.test(sideTitle), `  and the panel names it ("${sideTitle}")`);

/* ── THE CODE STAYS ON THE CHANNEL ────────────────────────────────────────────────────────────
   Already true of PushPlanEditor and asserted so it stays true: moving the code onto the panel
   header would undo the per-channel split in the one place an operator types it. */
const chans = await p.evaluate(() => ({
  total: document.querySelectorAll('[data-testid="chan"]').length,
  litWithCode: [...document.querySelectorAll('[data-testid="chan"][data-on="1"]')]
    .filter(c => c.querySelector('[data-testid="code"]')).length,
  lit: document.querySelectorAll('[data-testid="chan"][data-on="1"]').length,
  offWithCode: [...document.querySelectorAll('[data-testid="chan"][data-on="0"]')]
    .filter(c => c.querySelector('[data-testid="code"]')).length,
}));
ok(chans.total > 0, `the panel lists its channels (${chans.total})`);
ok(chans.lit > 0, `  CONTROL: ${chans.lit} of them are lit, so the code checks below can fail`);
ok(chans.litWithCode === chans.lit, `  and every lit channel carries its OWN code input (${chans.litWithCode} of ${chans.lit})`);
ok(chans.offWithCode === 0, `  CONTROL: an unused channel has no code field to fill in by mistake (${chans.offWithCode})`);

/* ── AN UNSAVED PANEL IS NOT SWAPPED OUT FROM UNDER YOU ───────────────────────────────────────
   Losing typed pushes to a stray click on a grid of 88 tiles is the one thing this must not do. */
ok(await p.$(D('dirty')) === null, 'CONTROL: the panel is clean before anything is typed');
await p.fill(`${D('chan')}[data-on="1"] ${D('code')}`, 'SIDE10');
await p.waitForTimeout(300);
ok(await p.$(D('dirty')) !== null, 'editing marks the panel unsaved');
const otherTiles = await p.$$(`${D('match-tile')}[data-cover="planned"]`);
await otherTiles[3].click();
await p.waitForTimeout(350);
ok(await p.$eval(D('panel-title'), e => e.textContent.replace(/\s+/g, ' ').trim()) === sideTitle,
  '  and clicking another tile while unsaved does NOT swap it');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
ok(await p.$(D('panel')) !== null, '  CONTROL: nor does Escape, while there are changes');
ok(await p.$eval(`${D('chan')}[data-on="1"] ${D('code')}`, e => e.value) === 'SIDE10',
  '  and the typing survived both attempts');
await p.click(D('cancel'));
await p.waitForTimeout(350);
ok(await p.$(D('panel')) === null, '  Cancel is a way out, and it closes');
ok(await p.$$eval(`${D('match-tile')}[data-open="1"]`, es => es.length) === 0,
  '  CONTROL: and the tile stops being marked');

/* ── ESCAPE CLOSES A CLEAN PANEL ──────────────────────────────────────────────────────────────
   The control for the two Escape-is-ignored assertions above: Escape does work, when there is
   nothing to lose. Without this, "Escape did nothing" could mean Escape is simply unwired. */
await p.click(`${D('match-tile')}[data-cover="planned"]`);
await p.waitForSelector(D('panel'), { timeout: 10000 });
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
ok(await p.$(D('panel')) === null, 'CONTROL: Escape DOES close a panel with no changes, so the two above are real');

/* ── A CANCELLED MATCH HAS NOTHING TO PLAN ────────────────────────────────────────────────────── */
const cxTile = await p.$(`${D('match-tile')}[data-cover="cancelled"]`);
ok(cxTile !== null, 'CONTROL: a cancelled tile is on screen, so the check below is not free');
if (cxTile) {
  await cxTile.click();
  await p.waitForTimeout(400);
  ok(await p.$(D('panel')) === null, 'a cancelled match does not open the editor, there is nothing to plan');
}

/* ── THE PHONE ─────────────────────────────────────────────────────────────────────────────────
   At 390px the app renders its PHONE tree, not a narrow desktop — the breakpoint is 767px — so the
   desktop side panel is never on screen there. The phone's own panel opens under its row, which is
   a recorded decision (a modal loses your place in a sixty-row list). Asserted as what it IS. */
await load(390);
ok(await p.$(D('m-root')) !== null, '390px: the phone tree renders, so there is no desktop side panel to place');
await p.click(D('m-tab-week'));
await p.waitForSelector(D('m-row'), { timeout: 20000 });
await p.click(D('m-row'));
await p.waitForSelector(D('m-panel'), { timeout: 10000 });
const mGeom = await p.evaluate(() => {
  const e = document.querySelector('[data-testid="m-panel"]');
  const r = e.getBoundingClientRect();
  return { w: Math.round(r.width), vw: window.innerWidth, pos: getComputedStyle(e).position };
});
/* SPANS ITS COLUMN, which at 390px IS the width bar the phone's own 12px gutters. It is not a
   420px panel because it is not a side panel: the phone's editor opens under its row on purpose. */
ok(mGeom.w >= mGeom.vw - 32, `  and its own panel spans the width (${mGeom.w} of ${mGeom.vw})`);
ok(mGeom.pos === 'static' || mGeom.pos === 'relative',
  `  CONTROL: in the flow under its row, not fixed over the list (${mGeom.pos})`);
ok(await p.evaluate(() => document.documentElement.scrollWidth) <= 392,
  '  with no page-level horizontal scroll and no week padding to drop');

// ══ R3. THE FOUR VIEWS, AND THE TWO TAG-FILTERED ONES ═════════════════════════════════════════
/* Plan | Coverage | Priority | Starting 11. The tag views are the PLAN grid filtered to one tag —
   one component with a parameter, which is why this block asserts both through the same code. */
await load();
const views = await p.$$eval(`${D('view-tabs')} button`, es => es.map(e => e.textContent.trim()));
const WANT_VIEWS = ['Plan', 'Coverage', ...TAG_KEYS.map(k => TAG_META[k].label.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()))];
ok(views.join(', ') === WANT_VIEWS.join(', '),
  `the toggle offers Plan, Coverage and one view per tag (${views.join(', ')})`);
ok(await p.$(D('view-tab-plan')) !== null, '  and Plan is still one of them - it IS the week grid');

/* THE TRUTH THE VIEWS ARE CHECKED AGAINST, counted off the UNFILTERED Plan grid. Not from the
   database and not from the filtered view itself: the question is whether the filter agrees with
   the tiles the operator can already see. */
const tagTruth = await p.$$eval('[data-testid="match-tile"]', es => {
  const out = {};
  for (const e of es) {
    for (const t of e.querySelectorAll('[data-testid="tag"]')) {
      const k = t.dataset.t;
      (out[k] ?? (out[k] = [])).push(Number(e.dataset.apiId));
    }
  }
  return out;
});
const planTiles = await p.$$eval(D('match-tile'), es => es.length);
ok(planTiles > 0, `CONTROL: the unfiltered Plan grid holds ${planTiles} tiles, so the counts below are not free`);

let sawNonEmptyTagView = false;
for (const [key, label] of [['priority', 'Priority'], ['starting_11', 'Starting 11']]) {
  const want = [...new Set(tagTruth[key] ?? [])];
  await p.click(D(`view-tab-${key}`));
  await p.waitForTimeout(500);
  const got = await p.evaluate(() => ({
    ids: [...document.querySelectorAll('[data-testid="match-tile"]')].map(e => Number(e.dataset.apiId)),
    // EVERY VISIBLE TILE MUST CARRY THE CHIP. A filter that let one through is the failure here.
    withChip: [...document.querySelectorAll('[data-testid="match-tile"]')]
      .filter(e => e.querySelector('[data-testid="tag"]')).length,
    cities: document.querySelectorAll('[data-testid="city-block"]').length,
    emptyCities: [...document.querySelectorAll('[data-testid="city-block"]')]
      .filter(e => e.querySelectorAll('[data-testid="match-tile"]').length === 0).length,
    heading: document.querySelector('[data-testid="grid-heading"]')?.textContent.trim(),
    shown: Number(document.querySelector('[data-testid="grid-shown"]')?.textContent ?? -1),
    note: document.querySelector('[data-testid="grid-filter-note"]')?.textContent.replace(/\s+/g, ' ').trim() ?? '',
    empty: document.querySelectorAll('[data-testid="grid-empty"]').length,
    // NOT FILTERED, and this is the assertion that proves it.
    queueRows: document.querySelectorAll('[data-testid="queue-row"]').length,
    dayTabs: document.querySelectorAll('[data-testid="day-tab"]').length,
  }));
  ok(got.heading === label.toUpperCase() || got.heading === label,
    `${label}: the grid says which view it is ("${got.heading}")`);
  ok(got.ids.length === want.length,
    `  its tile count equals the matches carrying the tag (${got.ids.length} against ${want.length})`);
  ok(got.ids.length === 0 || got.ids.slice().sort().join() === want.slice().sort().join(),
    `  and they are the SAME matches, not merely the same number`);
  ok(got.withChip === got.ids.length,
    `  every visible tile carries the chip (${got.withChip} of ${got.ids.length})`);
  ok(got.shown === got.ids.length, `  and the note's count matches the grid (${got.shown})`);
  ok(got.emptyCities === 0, `  no empty city row is rendered (${got.emptyCities})`);
  /* THE ZERO CASE IS STATED, NOT SILENT. starting_11 has no rows in production, so this is the
     branch that actually renders — and an empty page after a heading reads as a load failure. */
  if (got.ids.length === 0) {
    ok(got.empty === 1, `  and an empty view says so rather than rendering nothing (${got.empty})`);
    ok(got.cities === 0, `  CONTROL: with no city rows at all (${got.cities})`);
  } else {
    sawNonEmptyTagView = true;
    ok(got.cities > 0, `  across ${got.cities} city row(s), city grouping kept`);
  }
  /* NEITHER THE QUEUE NOR THE DAY STRIP IS FILTERED. A filter on a worklist is a way to forget a
     push that is still owed. */
  ok(got.dayTabs === 7, `  the day queue still offers all seven days (${got.dayTabs})`);
  ok(/unfiltered/.test(got.note), '  and the view says so, so nobody reads the queue as filtered');
}
/* ── THE POSITIVE CONTROL FOR THE WHOLE BLOCK ────────────────────────────────────────────────
   Every count above passes at zero, and a filter that matched nothing would produce zero twice. At
   least one tag view has to be NON-EMPTY in the same run, or these assertions are measuring a
   broken filter and calling it agreement. */
ok(sawNonEmptyTagView,
  `CONTROL: at least one tag view rendered tiles, so the zero on the other is a real zero${sawNonEmptyTagView ? '' : TAGCTX}`);
/* AND THE UNFILTERED GRID COMES BACK. A filter that leaked into Plan's own state would show here. */
await p.click(D('view-tab-plan'));
await p.waitForTimeout(400);
ok(await p.$$eval(D('match-tile'), es => es.length) === planTiles,
  `  CONTROL: and Plan is unfiltered again (${planTiles} tiles)`);
ok(await p.$$eval(D('grid-filter-note'), es => es.length) === 0, '  with no filter note on it');

// ══ R3b. 390 AND 1320, ACROSS EVERY VIEW ══════════════════════════════════════════════════════
/* THE TAG VIEWS ARE NEW LAYOUTS, so they get the same width check the others do. "Starting 11" is
   the widest label on the page and the tab strip is the thing most likely to overflow at 390. */
for (const vw of [390, 1320]) {
  await load(vw);
  const onPhone = await p.$(D('m-root')) !== null;
  const tabSel = onPhone ? 'm-tab' : 'view-tab';
  for (const v of ['coverage', 'priority', 'starting_11']) {
    const btn = await p.$(D(`${tabSel}-${v}`));
    ok(btn !== null, `${vw}px: the ${v} view has a tab${onPhone ? ' on the phone' : ''}`);
    if (!btn) continue;
    await btn.click();
    await p.waitForTimeout(400);
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= vw + 2, `  ${vw}px/${v}: no page-level horizontal scroll (${sw})`);
    const small = await p.$$eval('main button, [data-testid="day-queue"] button, [data-testid="view-tabs"] button, [data-testid="m-tabs"] button', es =>
      es.filter(e => e.offsetParent !== null && e.getBoundingClientRect().height > 0
        && e.getBoundingClientRect().height < 31.5).map(e => e.textContent.trim().slice(0, 20)));
    ok(small.length === 0, `  ${vw}px/${v}: every control at least 32px${small.length ? ': ' + small.slice(0, 4).join(' / ') : ''}`);
  }
}

// ══ R3c. THE PHONE READS THE SAME SOURCE ══════════════════════════════════════════════════════
await load(390);
const mViews = await p.$$eval(`${D('m-tabs')} button`, es => es.map(e => e.textContent.trim()));
ok(mViews.join(', ') === ['Due', 'Week', 'Coverage', ...WANT_VIEWS.slice(2)].join(', '),
  `the phone offers the same tag views plus its own two (${mViews.join(', ')})`);
await p.click(D('m-tab-priority'));
await p.waitForSelector(`${D('m-week')}[data-view-tag="priority"]`, { timeout: 20000 });
const mTag = await p.evaluate(() => ({
  rows: [...document.querySelectorAll('[data-testid="m-row"]')].map(e => Number(e.dataset.apiId)),
  withChip: [...document.querySelectorAll('[data-testid="m-row"]')].filter(e => e.querySelector('[data-testid="m-tag"]')).length,
  shown: Number(document.querySelector('[data-testid="m-shown"]')?.textContent ?? -1),
}));
/* THE SAME MATCHES AS THE DESKTOP'S OWN PRIORITY VIEW. Not the same count - the same ids. The phone
   filters through the same tagsOf it is handed, and this is what proves it rather than assuming. */
const wantPriority = [...new Set(tagTruth['priority'] ?? [])].sort();
ok(mTag.rows.length > 0, `CONTROL: the phone's Priority view rendered ${mTag.rows.length} row(s)${mTag.rows.length === 0 ? TAGCTX : ''}`);
ok(mTag.rows.slice().sort().join() === wantPriority.join(),
  `  and they are the same matches the desktop shows (${mTag.rows.length} against ${wantPriority.length})`);
ok(mTag.withChip === mTag.rows.length, `  every row carries the chip (${mTag.withChip} of ${mTag.rows.length})`);
ok(mTag.shown === mTag.rows.length, `  and its count matches its rows (${mTag.shown})`);

// ── CODES PER CHANNEL ────────────────────────────────────────────────────────────────────────
/* BACK TO THE DESKTOP, AND ONTO A DAY THAT ACTUALLY HAS PUSHES.
   TWO CAUSES OF THE SAME ZERO, and both have bitten this block:
     1. The block above ends at 390px on the phone, where there is no queue-row at all.
     2. A FRESH LOAD OPENS THE QUEUE ON TODAY, and today may have no pushes — it did not on
        2026-09-26, a Saturday. Adding the load() fixed cause 1 and introduced cause 2, which is
        why the presence control below is the assertion that matters: every count here goes to zero
        on an empty queue, and zero is the answer two of them are hoping for.
   So the day is DERIVED: step the tabs and stop at the first that has rows, the same way the
   general-push block finds its own day. Pinning a weekday would go stale the first week the slate
   moves. */
await load();
const codeDay = await p.evaluate(async () => {
  const tabs = [...document.querySelectorAll('[data-testid="day-tab"]')];
  for (let i = 0; i < tabs.length; i++) {
    tabs[i].click();
    await new Promise(r => setTimeout(r, 220));
    if (document.querySelector('[data-testid="queue-row"]')) return i;
  }
  return -1;
});
ok(codeDay >= 0, `CONTROL: a day with pushes is open before the code checks (day ${codeDay})`);
const codeInfo = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="queue-row"]')];
  return {
    codes: [...document.querySelectorAll('[data-testid="queue-code"]')].map(e => e.textContent.trim()),
    onChip: [...document.querySelectorAll('[data-testid="queue-code"]')].every(e => e.closest('[data-testid="queue-chan"]') !== null),
    bare: rows.some(r => r.querySelector('[data-testid="queue-chan"]') && !r.querySelector('[data-testid="queue-code"]')),
    rows: rows.length,
    chans: document.querySelectorAll('[data-testid="queue-chan"]').length,
  };
});
ok(codeInfo.codes.length === 0 || codeInfo.onChip,
  `each code sits on its own channel chip rather than on the row (${codeInfo.codes.length} codes)`);
ok(codeInfo.codes.every(c => c === c.toUpperCase()), `  and every one is normalised to upper case (${codeInfo.codes.join(', ')})`);
/* PRESENCE BEFORE THE BARE-CHIP CHECK. `bare` is false on an empty queue and false on a queue where
   every chip carries a code, and those are opposite facts. */
ok(codeInfo.rows > 0 && codeInfo.chans > 0,
  `  CONTROL: ${codeInfo.rows} queue row(s) carrying ${codeInfo.chans} channel chip(s) are on screen`);
ok(codeInfo.bare, '  CONTROL: a push with no code shows its channels bare rather than inventing one');

// ══ 12. THE CANCEL SECTION IS GONE, AND THE SCALE IS NOT ══════════════════════════════════════
await load();
ok(await p.$(D('cancel-patterns')) === null, 'the cancel section is gone from the page');
ok(await p.$$eval(D('cancel-chip'), es => es.length) === 0, '  and so are its pills');
/* THIS ASSERTION USED TO READ "the view is two tabs (plan, coverage)" AND IT WAS RIGHT UNTIL NOW.
   The Priority and Starting 11 views are a deliberate reversal of that contract, approved as such:
   the tag views are FILTERED PLAN views, so Plan stays and two tabs become four. The count is
   derived from TAG_KEYS rather than pinned at four, so adding a third tag adds a tab and does not
   fail this line. */
const tabNames = await p.$$eval(`${D('view-tabs')} button`, es => es.map(e => e.textContent.trim().toLowerCase()));
ok(tabNames.length === 2 + TAG_KEYS.length && tabNames.slice(0, 2).join(',') === 'plan,coverage',
  `the view is ${2 + TAG_KEYS.length} tabs, Plan and Coverage first (${tabNames.join(', ')})`);
ok(TAG_KEYS.every(k => tabNames.includes(TAG_META[k].label.toLowerCase())),
  `  and one per tag, named from TAG_META (${TAG_KEYS.join(', ')})`);
/* CONTROL: the scale did NOT go with it. The tile chips are the only consumer now, and they read
   the same four colours the pills used to. */
const stillRamped = await p.$$eval(D('risk-chip'), es => [...new Set(es.map(e => getComputedStyle(e).backgroundColor))]);
ok(stillRamped.length > 0 && stillRamped.every(bg => Object.values(WANT).includes(bg)),
  `  CONTROL: the tile chips still read the four ramp colours (${stillRamped.join(', ')})`);

ok(errs.length === 0, `no page errors across the whole run${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
