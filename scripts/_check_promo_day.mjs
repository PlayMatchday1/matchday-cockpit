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

/* ── THE REVENUE-SHARE FIELDS, QUERIED FROM THE CONTRACT AND NOT PINNED HERE ──────────────────
 * The PARTNER badge is derived, so the assertion has to come from the same place the derivation
 * does or it is just the page agreeing with itself. This runs the join independently — field ->
 * fin_venue_fields -> fin_venues -> partner_dashboards — and applies the SAME predicate, imported
 * rather than restated. A hardcoded list of five ids would go stale the first time a venue signs.
 *
 * IF THE QUERY FAILS the list is null and the partner assertions say so and fail, rather than
 * silently becoming "no field is a partner", which every badge would then violate or satisfy by
 * accident depending on which way the check is written. */
const { createClient } = await import('@supabase/supabase-js');
const { isRevenueShareVenue } = await import('../src/lib/revenueShare.ts');
/* THE TAG SET ITSELF, so the tab count and the view names are DERIVED from what ships rather than
   pinned at whatever is true today. A third tag should add a tab, not a failure. */
const { TAG_KEYS, TAG_META } = await import('../src/lib/promoTags.ts');
const SHARE_FIELDS = await (async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const sb = createClient(url, key);
  const [links, venues, dashes] = await Promise.all([
    sb.from('fin_venue_fields').select('fin_venue_id, mdapi_field_id'),
    sb.from('fin_venues').select('id, billing_type'),
    sb.from('partner_dashboards').select('venue_id, revenue_model').eq('enabled', true),
  ]);
  if (links.error || venues.error) return null;
  const billing = new Map((venues.data ?? []).map(v => [Number(v.id), v.billing_type ?? null]));
  const model = new Map((dashes.data ?? []).map(d => [Number(d.venue_id), d.revenue_model ?? null]));
  return (links.data ?? [])
    .filter(l => isRevenueShareVenue(billing.get(Number(l.fin_venue_id)), model.get(Number(l.fin_venue_id))))
    .map(l => Number(l.mdapi_field_id)).sort((a, b) => a - b);
})();
ok(SHARE_FIELDS !== null && SHARE_FIELDS.length > 0,
  `CONTROL: the contract names ${SHARE_FIELDS?.length ?? 'UNKNOWN'} revenue-share field(s) (${SHARE_FIELDS?.join(', ') ?? 'query failed'})`);

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

// ── TAGS: TWO OF THEM, AND ONE DERIVED BADGE ─────────────────────────────────────────────────
/* 0192 cut the set from four to two. key_field merged into priority (they meant the same thing) and
   partner stopped being a tag at all: it is derived from the venue's revenue model through the same
   predicate basisOf uses, and rendered read-only. Both departures are asserted as ABSENCES with
   presence controls beside them, because an absence check passes on a page that never loaded. */
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
    keyItems: document.querySelectorAll('[data-testid="tag-key-item"]').length,
    keyText: document.querySelector('[data-testid="tag-key"]')?.textContent.replace(/\s+/g, ' ') ?? '',
    // THE WHOLE DOCUMENT, not the tag pills — a KEY FIELD left in the legend, a picker button or a
    // heading would pass a check that only looked at pills.
    keyFieldAnywhere: /KEY\s*FIELD/i.test(document.body.innerText),
    partnerPills: partner.length,
    // A PARTNER PILL WITH A data-t IS A TAG, which is the thing that was removed. The derived badge
    // carries none, so this separates "rendered" from "rendered as a tag".
    partnerAsTag: pills.filter(e => /PARTNER/i.test(e.textContent)).length,
    partnerFields: [...new Set(partner.map(e => e.closest('[data-testid="match-tile"]')?.dataset.apiId))].length,
    partnerTitled: partner.filter(e => /revenue-share/i.test(e.getAttribute('title') ?? '')).length,
  };
});
// PRESENCE FIRST. Every absence assertion below is worthless until the tags are proven on screen.
ok(tagInfo.total > 0, `the manual tags render (${tagInfo.labels.join(', ') || 'NONE'})`);
ok(tagInfo.keys.length > 0 && tagInfo.keys.every(k => k === 'priority' || k === 'starting_11'),
  `  and the set is exactly priority / starting_11 (${tagInfo.keys.join(', ')})`);
ok(!tagInfo.labels.includes('KEY FIELD'), '  no tag says KEY FIELD, which merged into PRIORITY');
ok(!tagInfo.keyFieldAnywhere, '  and KEY FIELD is nowhere in the DOM at all, not just off the pills');
/* NO TILE CARRIES BOTH. Field 1717 carried key_field AND priority before 0192, so this is the exact
   row the merge had to collapse rather than duplicate. Asserted per tile, not page-wide. */
const bothChips = await p.$$eval('[data-testid="tags"]', gs => gs.filter(g =>
  g.querySelector('[data-testid="tag"][data-t="key_field"]') && g.querySelector('[data-testid="tag"][data-t="priority"]')).length);
ok(bothChips === 0, `  and no tile renders KEY FIELD beside PRIORITY (${bothChips} tiles do)`);
const priorityChips = await p.$$eval('[data-testid="tag"][data-t="priority"]', es => es.length);
ok(priorityChips > 0, `  CONTROL: while PRIORITY itself is on ${priorityChips} tile(s), so the check above is not free`);
ok(!tagInfo.labels.includes('NEW FIELD'), '  CONTROL: and none of them says NEW FIELD, the automatic badge’s words');
const newBadges = await p.$$eval(D('new-badge'), es => es.map(e => ({ flag: e.dataset.flag, title: e.getAttribute('title') ?? '' })));
ok(newBadges.length > 0, `  CONTROL: while the automatic NEW badges are untouched and still there (${newBadges.length})`);
/* THE WINDOW IS IN THE TOOLTIP, AND IT IS FOUR WEEKS. It said "last week's slate", which was the
   bug itself: a slot that ran three weeks, skipped one and came back read NEW DAY because the one
   week it was compared against was the one it missed. Asserted on the rendered title so the copy
   and the constant cannot drift apart silently. */
ok(newBadges.every(b => /last 4 weeks' slates/.test(b.title)),
  `  and every badge names the FOUR-week window it compared against ("${(newBadges[0]?.title ?? '').slice(0, 64)}…")`);
ok(newBadges.every(b => !/last week's slate/.test(b.title)),
  '  and none of them still says "last week\'s slate"');
/* AND THE RANGE IT PRINTS SPANS FOUR WEEKS, not one. Derived from the two dates in the title rather
   than pinned, so it follows whatever week is on screen. */
const span = (newBadges[0]?.title ?? '').match(/\((Mon \d+ \w+) – (Sun \d+ \w+)\)/);
ok(span !== null, `  and prints the window as a dated range (${span ? span[0] : 'NO RANGE IN TITLE'})`);
const tagCols = Object.values(tagInfo.colours);
ok(tagCols.length >= 1 && new Set(tagCols).size === tagCols.length, `${tagCols.length} tag colour(s) on screen, all distinct`);
/* CONTROL: the collision check, not merely a count. Distinct colours that include mint would pass a
   count and fail a reader. PARTNER's own colour is in the same check — it is rendered beside the
   tags and has to be told apart from them too. */
const TAKEN = ['rgb(44, 219, 135)', 'rgb(244, 196, 48)', 'rgb(232, 134, 42)', 'rgb(217, 69, 47)', 'rgb(143, 42, 23)', 'rgb(0, 51, 38)'];
const partnerCol = await p.$eval(D('partner-badge'), e => getComputedStyle(e).color).catch(() => null);
const allCols = partnerCol ? [...tagCols, partnerCol] : tagCols;
ok(allCols.every(c => !TAKEN.includes(c)), `  CONTROL: and none is a colour the page already uses (${allCols.join(' | ')})`);
ok(new Set(allCols).size === allCols.length, `  and the derived badge does not reuse a tag's colour (${allCols.length} distinct)`);
ok(tagInfo.bg === 'rgba(0, 0, 0, 0)', `a tag is outlined, not filled (${tagInfo.bg})`);
const chipBg = await p.$eval(D('risk-chip'), e => getComputedStyle(e).backgroundColor).catch(() => null);
ok(chipBg === null || chipBg !== tagInfo.bg, `  CONTROL: while the cancel chip stays filled (${chipBg})`);
ok(tagInfo.maxPerTile <= 3, `no tile renders more than three tag pills (max ${tagInfo.maxPerTile})`);
/* THE "+1" OVERFLOW ASSERTION IS GONE FROM HERE, DELIBERATELY. It used to read field 1717's four
   live tags. With two tag keys and a cap of three, `more` cannot be non-zero in any DOM this page
   can render and the CHECK constraint forbids seeding a fourth tag — so the assertion could not go
   red, which is the `|| true` problem in another coat. It moved to scripts/promo-tags-test.ts, which
   hands splitAtCap four items and watches the split happen. Asserted here as the zero it now is. */
ok(tagInfo.more === 0, `  and the overflow count is absent because two tags cannot exceed three (${tagInfo.more})`);
ok(tagInfo.titled === tagInfo.total, `  CONTROL: every tag carries its meaning on hover (${tagInfo.titled} of ${tagInfo.total})`);

/* ── THE DERIVED PARTNER BADGE ───────────────────────────────────────────────────────────────
   Asserted against the CONTRACT, queried independently of the page. The hand-applied tag was wrong
   on the one field it was set on, so "a badge renders somewhere" is not the assertion — "it renders
   on exactly the revenue-share fields" is. */
const partnerOnFields = await p.$$eval('[data-testid="match-tile"]', es => {
  const on = new Set(), off = new Set();
  for (const e of es) {
    const f = e.dataset.fieldId;
    if (f == null || f === '') continue;
    (e.querySelector('[data-testid="partner-badge"]') ? on : off).add(Number(f));
  }
  return { on: [...on].sort((a, b) => a - b), off: [...off].sort((a, b) => a - b) };
});
/* BOTH DIRECTIONS AND A PRESENCE CONTROL. "every badge is on a share field" passes when there are
   no badges, and "no share field is missing it" passes when there are no share fields on screen —
   the two vacuous cases are the same zero. So the expected set is computed as the INTERSECTION of
   the contract with what is actually on screen, and asserted non-empty first. */
const onScreen = [...partnerOnFields.on, ...partnerOnFields.off];
const expectPartner = [...new Set(onScreen.filter(f => SHARE_FIELDS.includes(f)))].sort((a, b) => a - b);
ok(onScreen.length > 0, `CONTROL: ${onScreen.length} field(s) on screen`);
ok(expectPartner.length > 0,
  `  CONTROL: and ${expectPartner.length} of them are revenue-share (${expectPartner.join(', ')}), so the badge check can fail`);
ok(partnerOnFields.on.slice().sort((a, b) => a - b).join() === expectPartner.join(),
  `the PARTNER badge is on EXACTLY the revenue-share fields on screen (${partnerOnFields.on.join(', ') || 'none'})`);
ok(partnerOnFields.on.every(f => SHARE_FIELDS.includes(f)),
  `  none of them is a field the contract does not name (${partnerOnFields.on.join(', ') || 'none'})`);
const missing = partnerOnFields.off.filter(f => SHARE_FIELDS.includes(f));
ok(missing.length === 0, `  and no revenue-share field on screen is missing it (${missing.join(', ') || 'none missing'})`);
/* THE FIELD THE OLD TAG WAS WRONG ABOUT. 1717 Keswick Park is billed per_match; if it is on screen
   it must NOT carry the badge, whatever the deleted tag used to say. */
ok(!partnerOnFields.on.includes(1717),
  `  and 1717 Keswick Park, a per_match rental, carries no badge${partnerOnFields.off.includes(1717) ? ' (it is on screen)' : ' (not on screen this week)'}`);
ok(tagInfo.partnerAsTag === 0, `  CONTROL: and PARTNER is never rendered as a tag pill (${tagInfo.partnerAsTag})`);
ok(tagInfo.partnerPills === 0 || tagInfo.partnerTitled === tagInfo.partnerPills,
  `  and each badge says it is a revenue-share venue on hover (${tagInfo.partnerTitled} of ${tagInfo.partnerPills})`);

/* THE KEY LISTS ONLY WHAT IS IN USE, plus the derived badge when one is on screen. Asserted against
   what actually rendered rather than against a constant, so a key listing a tag nobody carries
   would fail. */
const rendered = new Set(Object.keys(tagInfo.colours));
ok(tagInfo.keyItems >= rendered.size && tagInfo.keyItems <= rendered.size + 1,
  `the key lists the tags in use (${tagInfo.keyItems} items, ${rendered.size} distinct tags rendered on tiles)`);
ok(/Set by hand and it stays until someone clears it/.test(tagInfo.keyText),
  '  and PRIORITY says it is hand-set and persists, not that it is about "this week"');
ok(!/this week/i.test(tagInfo.keyText.replace(/quiet week/gi, '')),
  '  CONTROL: and nothing in the key claims a week the row cannot store');
ok(tagInfo.partnerPills === 0 || /A revenue-share venue/.test(tagInfo.keyText),
  '  and the derived PARTNER badge is explained in the same key');
ok(await p.$$eval('[data-testid="add-tag"]', es => es.length) === 0,
  'CONTROL: no sub-32px add-tag control was invented to fit the tile row');

/* ── THE PICKER OFFERS TWO TAGS AND CANNOT OFFER PARTNER ─────────────────────────────────────── */
const picker = await p.evaluate(async () => {
  const tile = document.querySelector('[data-testid="match-tile"]');
  if (!tile) return null;
  tile.click(); await new Promise(r => setTimeout(r, 600));
  const btns = [...document.querySelectorAll('[data-testid="tag-toggle"]')];
  return {
    keys: btns.map(b => b.dataset.t),
    labels: btns.map(b => b.textContent.trim()),
    heights: btns.map(b => Math.round(b.getBoundingClientRect().height)),
    // The read-only statement, which is a span and not a button.
    readOnly: document.querySelectorAll('[data-testid="partner-panel-badge"]').length,
    panelOpen: document.querySelectorAll('[data-testid="panel"]').length,
  };
});
ok(picker && picker.panelOpen > 0, `CONTROL: the tile panel opened, so the picker checks below are not free`);
ok(picker && picker.keys.length === 2 && picker.keys.join(',') === 'priority,starting_11',
  `  the picker offers exactly two tags (${picker?.keys.join(', ')})`);
ok(picker && !picker.labels.some(l => /PARTNER/i.test(l)),
  '  and PARTNER is not one of them - it cannot be applied by hand');
ok(picker && !picker.labels.some(l => /KEY\s*FIELD/i.test(l)), '  nor KEY FIELD');
ok(picker && (picker.heights.length === 0 || Math.min(...picker.heights) >= 32),
  `  tags are set from the panel, at ${picker?.heights[0] ?? 'n/a'}px`);
/* IF THIS FIELD IS A PARTNER, the panel states it without offering a control. A disabled button
   would read as "you may not"; this reads as "this is". */
ok(picker && (picker.readOnly === 0 || picker.readOnly === 1),
  `  and a partner field states it read-only rather than as a toggle (${picker?.readOnly})`);
await p.keyboard.press('Escape').catch(() => {});

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
ok(views.length === 4 && views.join(', ') === 'Plan, Coverage, Priority, Starting 11',
  `the toggle offers four views (${views.join(', ')})`);
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
  'CONTROL: at least one tag view rendered tiles, so the zero on the other is a real zero');
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
ok(mViews.join(', ') === 'Due, Week, Coverage, Priority, Starting 11',
  `the phone offers the same views plus its own two (${mViews.join(', ')})`);
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
ok(mTag.rows.length > 0, `CONTROL: the phone's Priority view rendered ${mTag.rows.length} row(s)`);
ok(mTag.rows.slice().sort().join() === wantPriority.join(),
  `  and they are the same matches the desktop shows (${mTag.rows.length} against ${wantPriority.length})`);
ok(mTag.withChip === mTag.rows.length, `  every row carries the chip (${mTag.withChip} of ${mTag.rows.length})`);
ok(mTag.shown === mTag.rows.length, `  and its count matches its rows (${mTag.shown})`);
const mPartner = await p.$$eval('[data-testid="m-row"]', es => {
  const on = [], off = [];
  for (const e of es) {
    const f = Number(e.dataset.fieldId);
    if (!f) continue;
    (e.querySelector('[data-testid="m-partner-badge"]') ? on : off).push(f);
  }
  return { on: [...new Set(on)], off: [...new Set(off)] };
});
ok(mPartner.on.every(f => SHARE_FIELDS.includes(f)),
  `  and the phone's PARTNER badge is on revenue-share fields only (${mPartner.on.join(', ') || 'none on screen'})`);

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
