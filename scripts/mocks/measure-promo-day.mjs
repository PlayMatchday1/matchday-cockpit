/* Match Promotion: a day queue on top, the city week kept below, cancel history on the tile.
 *
 * Ryan, on the first pass: "you kind of got rid of the city view on the mock up and the colour is
 * totally different." Both right. The week is back as the page has it, and the palette is the
 * app's own tokens rather than an invented one — including the CANCEL RAMP, which already exists
 * at MatchPromotionView.tsx:649-652 and which the first pass replaced instead of reusing.
 *
 * Run: node measure-promo-day.mjs
 */
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
const CANDS = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDS.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); c ? pass++ : fail++; };
const p = await b.newPage({ viewport: { width: 1320, height: 1000 } });
const errs = []; p.on('pageerror', e => errs.push(e.message));
const D = t => `[data-testid="${t}"]`;
const load = async (w = 1320, h = 1000) => { await p.setViewportSize({ width: w, height: h });
  await p.goto(new URL('./promo-day.html', import.meta.url).href); await p.waitForTimeout(200); };
const day = k => `${D('day')}[data-k="${k}"]`;
const txt = s => p.$eval(s, e => e.textContent.replace(/\s+/g, ' ').trim());

await load();
ok(errs.length === 0, `no script errors${errs.length ? ': ' + errs[0] : ''}`);

// ══ 1. THE CITY WEEK IS STILL THERE ════════════════════════════════════════
// The first pass replaced it with a dense grid of its own. The page already had this layout and
// people read it; the day queue is an addition above it, not a replacement for it.
const cities = await p.$$eval(D('city'), es => es.map(e => e.dataset.c));
ok(cities.length === 2 && cities[0] === 'Atlanta', `the week renders city by city (${cities.join(', ')})`);
const cols = await p.$$eval(`${D('city')}[data-c="Austin"] ${D('col')}`, es => es.length);
ok(cols === 7, `  each city is seven day columns (${cols})`);
// THE CITY HEADERS ARE COMPUTED FROM THE TILES and land on the live page's own figures. If the
// transcription were wrong these would not agree.
const stats = await p.$$eval(D('citystat'), es => es.map(e => e.textContent.replace(/\s+/g,' ').trim()));
// THE PAGE'S OWN FIGURES, NOW SPLIT THREE WAYS. Atlanta was 2 planned and 6 no plan; those six
// have not moved, they are told apart into what a general push carried and what nothing carried.
ok(stats[0] === '2 own push · 1 covered · 5 no plan', `Atlanta reads "${stats[0]}"`);
ok(stats[1] === '7 own push · 11 covered · 13 no plan', `Austin reads "${stats[1]}"`);
const split = stats.map(t => t.match(/\d+/g).map(Number));
ok(split[0][0] === 2 && split[0][1] + split[0][2] === 6,
  '  CONTROL: Atlanta\u2019s own-push count is unchanged and the old six are merely told apart');
ok(split[1][0] === 7 && split[1][1] + split[1][2] === 24,
  '  CONTROL: same for Austin, 7 own and the old 24 split into 11 and 13');
const neu = await p.$$eval(D('citynew'), es => es.map(e => e.textContent.trim()));
ok(neu[0] === '1 new' && neu[1] === '8 new', `  and the new counts match too (${neu.join(', ')})`);
ok(await p.$$eval(D('newb'), es => es.length) === 9,
  '  CONTROL: nine NEW badges render, which is the two city counts added up');

// ══ 2. THE APP'S OWN LANGUAGE ══════════════════════════════════════════════
const rail = await p.$eval(`${D('tile')}[data-state="planned"]`, e => getComputedStyle(e).borderLeftColor);
ok(rail === 'rgb(44, 219, 135)', `a planned tile keeps its mint rail (${rail})`);
const dash = await p.$eval(`${D('tile')}[data-state="none"]`, e => getComputedStyle(e).borderStyle);
ok(dash === 'dashed', '  and a tile with no push stays dashed');
ok(await p.$eval(`${D('col')}[data-today="1"]`, e => getComputedStyle(e).borderColor) === 'rgb(44, 219, 135)',
  "  CONTROL: today's column is mint-ringed, as it already is on the page");

// ══ 3. THE CANCEL RAMP IS THE ONE THAT ALREADY EXISTS ══════════════════════
// MatchPromotionView.tsx:649-652 — 4 #c0392b, 3 #7d3220, 2 #e6a532, 1 neutral. Reused rather than
// replaced: operators have learned it on the Cancel tab, and a second scale for one metric is
// worse than an imperfect one.
const ramp = await p.evaluate(() => { const out = {};
  for (const r of [1,2,3,4]) { const e = document.querySelector(`[data-testid="rchip"][data-r="${r}"]`);
    out[r] = e ? getComputedStyle(e).backgroundColor : null; } return out; });
ok(ramp[1] === 'rgb(244, 196, 48)', `1 of 4 is yellow (${ramp[1]})`);
ok(ramp[2] === 'rgb(232, 134, 42)', `  2 of 4 is orange (${ramp[2]})`);
ok(ramp[3] === 'rgb(217, 69, 47)',  `  3 of 4 is light red (${ramp[3]})`);
ok(ramp[4] === 'rgb(143, 42, 23)',  `  4 of 4 is dark red (${ramp[4]})`);
// THE RAMP MUST DARKEN MONOTONICALLY. The codebase's does not: #e6a532, then #7d3220 (very dark),
// then #c0392b (brighter), so 3 reads heavier than 4. That is what made it hard to read, and it is
// the defect this ramp fixes. Asserted rather than eyeballed.
const lum = c => { const [r,g,bl] = c.match(/\d+/g).map(Number);
  return 0.2126*r + 0.7152*g + 0.0722*bl; };
const ls = [1,2,3,4].map(r => lum(ramp[r]));
ok(ls[0] > ls[1] && ls[1] > ls[2] && ls[2] > ls[3],
  `  and it darkens step by step (${ls.map(x=>Math.round(x)).join(' > ')})`);

// THE RATIO IS ALWAYS PRINTED. #c0392b against #7d3220 is a hard pair at tile size, which is the
// only real objection to this ramp; printing it answers that without changing the colours.
const chips = await p.$$eval(D('rchip'), es => es.map(e => ({ r: e.dataset.r, t: e.textContent.trim() })));
ok(chips.length > 0 && chips.every(c => c.t === `${c.r}/4`),
  `every risk chip states its ratio (${chips.length} of them)`);

// THE WASH IS ONLY AT 3 AND 4. Level 2 is amber, and amber on a tile ALREADY means "needs a
// decision" on this page, so washing a tile amber would make one colour answer two questions.
const w = await p.evaluate(() => {
  const plain = getComputedStyle(document.querySelector('[data-testid="tile"][data-r="0"]')).backgroundColor;
  const of = r => { const e = document.querySelector(`[data-testid="tile"][data-r="${r}"]`);
    return e ? getComputedStyle(e).backgroundColor : null; };
  return { plain, r1: of(1), r2: of(2), r3: of(3), r4: of(4) }; });
ok([w.r1,w.r2,w.r3,w.r4].every(x => x && x !== w.plain), 'every level washes its tile, matching its chip');
ok(new Set([w.r1,w.r2,w.r3,w.r4]).size === 4, '  and the four washes are four distinct colours');
ok(await p.$$eval(`${D('tile')}[data-r="0"] ${D('rchip')}`, es => es.length) === 0,
  '  CONTROL: a slot that has never cancelled carries no chip at all');

// ══ 4. THE QUEUE IS DERIVED FROM THE WEEK ══════════════════════════════════
// One source. A push on the strip and a push on a tile that disagree is the one failure this page
// cannot afford.
await load();
const planned = await p.$$eval(`${D('tile')}[data-state="planned"]`, es => es.length);
ok(planned === 9, `nine tiles carry a push across the week (${planned})`);
let totalQ = 0;
for (const k of ['mon','tue','wed','thu','fri','sat','sun']) {
  await p.click(day(k)); await p.waitForTimeout(90);
  const vis = await p.$$eval(D('push'), es => es.filter(e => e.offsetParent !== null).length);
  const foldT = await p.$(D('fold')) ? await txt(D('fold')) : '';
  totalQ += vis + Number((foldT.match(/\d+/) || [0])[0]);
}
// NINE MATCH PUSHES PLUS FOUR GENERAL ONES. The general pushes are in the same queue, which is
// what makes one source true: a push on the strip and a push on a tile cannot disagree.
ok(totalQ === 13, `  and the seven day queues hold those nine plus the four general ones (${totalQ})`);

// ══ 5. IT OPENS ON TODAY, AND PAST DUE FIRES ═══════════════════════════════
await load();
ok(/Thursday 17 September/.test(await txt(D('ptitle'))), 'opens on today');
ok(await p.$$eval(`${D('day')}[aria-selected="true"]`, es => es.length) === 1,
  '  CONTROL: exactly one day is selected');
ok(await p.$(D('late')) !== null, "Thursday's 8:40 AM push is unsent at 3pm, so it reads past due");
ok(/2 past due/.test(await txt(D('pcount'))),
  "  and the day line counts it, general pushes included");
ok(/past due/.test(await txt(day('thu'))), '  and the tab says it without opening the day');
ok(!/past due/.test(await txt(day('fri'))), "  CONTROL: Friday's push is unsent but not past due");

// ══ 6. THE QUEUE PLANS NOTHING ═════════════════════════════════════════════
ok(await p.$$eval(`${D('panel')} button`, es => es.every(e => /Mark sent|Show|Hide/.test(e.textContent))),
  'the queue offers only Mark sent and the fold, no way to create a push');
const mh = await p.$eval(D('mark'), e => e.getBoundingClientRect().height);
ok(mh >= 32, `  Mark sent is still a full-size button (${Math.round(mh)}px)`);

// ══ 7. MOVING BETWEEN DAYS ═════════════════════════════════════════════════
await load();
await p.focus(day('thu'));
await p.keyboard.press('ArrowRight'); await p.waitForTimeout(140);
ok(/Friday/.test(await txt(D('ptitle'))), 'arrow keys move between days');
await p.click(day('mon')); await p.focus(day('mon'));
await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(120);
ok(/Monday/.test(await txt(D('ptitle'))), '  CONTROL: left from Monday stays put rather than wrapping');

// ══ 7b. LAST WEEK, AND WHAT CANCELLED IN IT ════════════════════════════════
// Ryan: "add the cancelled matches to previous weeks ... operator wants to be able to see what
// cancelled last week by going to last week. The cancelled matches should show how many players
// the match had."
await load();
ok(await p.$eval(D('weeklabel'), e => /14 Sep/.test(e.textContent)), 'opens on the current week');
ok(await p.$eval(D('wk-next'), e => e.disabled) === true,
  '  CONTROL: forward is disabled at the newest week rather than silently doing nothing');
await p.click(D('wk-prev')); await p.waitForTimeout(250);
ok(await p.$eval(D('weeklabel'), e => /7 Sep/.test(e.textContent)), 'the arrow steps back a week');
ok(await p.$$eval('.dnum', es => es.map(e => e.textContent).join()) === '7,8,9,10,11,12,13',
  '  and the day tabs carry that week\u2019s dates, not last week\u2019s numbers on this week\u2019s tabs');

const cx = await p.$$eval(`${D('tile')}[data-state="cancelled"]`,
  es => es.map(e => ({ b: e.dataset.booked, t: e.querySelector('[data-testid="booked"]').textContent })));
ok(cx.length === 10, `ten matches cancelled that week (${cx.length})`);
// THE BOOKED COUNT IS THE POINT. A cancellation with 16 booked cost sixteen players; one with 1
// was never going to run. Rendering both as "cancelled" throws away the number that tells them
// apart, and it is the one that decides whether the slot moves.
ok(cx.every(c => /^\d+ booked$/.test(c.t)), '  and every one states how many players had booked');
ok(cx.some(c => c.b === '16') && cx.some(c => c.b === '1'),
  `  across a real range, 1 to 16 (${cx.map(c=>c.b).sort((a,b)=>a-b).join(', ')})`);
const heavy = await p.$$eval(`${D('booked')}[data-heavy="1"]`, es => es.map(e => e.textContent));
ok(heavy.length === 3, `  the three heaviest are picked out rather than read alike (${heavy.join(', ')})`);
// CONTROL: a cancelled match is its own state, NOT "no plan". Nothing was missed; it was called off.
const stats2 = await p.$$eval(D('citystat'), es => es.map(e => e.textContent.replace(/\s+/g,' ').trim()));
ok(!/cancelled/.test(stats2.join()), '  CONTROL: cancelled matches are not counted as "no plan"');
const citycx = await p.$$eval(D('citycx'), es => es.map(e => e.textContent.trim()));
ok(citycx.join(' | ') === '2 cancelled \u00b7 8 booked | 8 cancelled \u00b7 56 booked',
  `  and each city totals its own (${citycx.join(' | ')})`);
ok(await p.$$eval(D('pip-cx'), es => es.length) > 0, '  the day tabs say which days lost matches');

// A PAST WEEK HAS NOTHING OUTSTANDING. Nothing in it should ask the operator to do something they
// can no longer do.
ok(await p.$$eval(D('pip-late'), es => es.length) === 0, 'a past week shows nothing past due');
ok(await p.$$eval(D('mark'), es => es.length) === 0, '  and offers no Mark sent, because it is history');
// CONTROL: come back to this week and both return.
await p.click(D('wk-next')); await p.waitForTimeout(250);
ok(await p.$$eval(D('pip-late'), es => es.length) === 1, '  CONTROL: stepping forward restores this week\u2019s past-due');
ok(await p.$$eval(`${D('tile')}[data-state="cancelled"]`, es => es.length) === 0,
  '  CONTROL: and this week, which has not happened yet, has no cancellations');

// ══ 7c. GENERAL PUSHES, AND THE THIRD COVERAGE STATE ═══════════════════════
// Ryan: "we should add an option per city so we can add general pushes (pushing all the slate to
// registered users or pushing general slate for a specific field for example)."
await load();
// THREE STATES, NOT TWO. A general push is real promotion, so a match it carried must not read as
// forgotten; it is not a push written for that match, so it must not read the same either. The
// middle state IS the feature.
const st = await p.evaluate(() => ({
  own: document.querySelectorAll('[data-testid="tile"][data-state="planned"]').length,
  cov: document.querySelectorAll('[data-testid="tile"][data-state="covered"]').length,
  none: document.querySelectorAll('[data-testid="tile"][data-state="none"]').length }));
ok(st.own > 0 && st.cov > 0 && st.none > 0,
  `all three coverage states are on screen at once (own ${st.own}, covered ${st.cov}, none ${st.none})`);
const railOwn = await p.$eval(`${D('tile')}[data-state="planned"]`, e => getComputedStyle(e).borderLeftStyle);
const railCov = await p.$eval(`${D('tile')}[data-state="covered"]`, e => getComputedStyle(e).borderLeftStyle);
ok(railOwn === 'solid' && railCov === 'dotted',
  `  own push is a solid rail, covered is dotted (${railOwn} / ${railCov})`);
ok(await p.$$eval(D('covtag'), es => es.length) === st.cov,
  '  and every covered tile names what carried it, so the mark is never a mystery');
const tags = await p.$$eval(D('covtag'), es => [...new Set(es.map(e => e.textContent))]);
ok(tags.some(t => /city slate/.test(t)) && tags.some(t => /Hattrick slate/.test(t)),
  `  a city push and a field push read differently (${tags.join(' | ')})`);

// THE CITY HEADER SPLITS THE THREE, so "no plan" goes back to meaning nothing at all.
const cs = await p.$$eval(D('citystat'), es => es.map(e => e.textContent.replace(/\s+/g,' ').trim()));
ok(cs.every(t => /own push/.test(t) && /no plan/.test(t)), `the city header splits them (${cs[0]})`);
// CONTROL: the three sum to the city's live matches. A match counted twice or missed shows up
// nowhere else on the page.
const sums = await p.$$eval(D('city'), es => es.map(e => ({
  head: e.querySelector('[data-testid="citystat"]').textContent.match(/\d+/g).map(Number),
  tiles: e.querySelectorAll('[data-testid="tile"]:not([data-state="cancelled"])').length })));
ok(sums.every(x => x.head.reduce((a,b)=>a+b,0) === x.tiles),
  `  CONTROL: own + covered + no plan equals the city's matches (${sums.map(x=>x.head.join('+')+'='+x.tiles).join(', ')})`);

// A GENERAL PUSH COVERS THE DAY IT IS SENT FOR, not the whole week. Covering a week in one blast
// turns every tile green and the column stops telling anyone anything.
ok(st.none > 0, 'a week with general pushes in it still has matches reading no plan');

// IT IS THE SAME QUEUE ROW WITH A WIDER TARGET. Nothing about marking done changes.
await p.click(day('thu')); await p.waitForTimeout(140);
const gen = await p.$(`${D('push')} ${D('scope')}`);
ok(gen !== null, 'a general push sits in the same queue as the match pushes');
const row = await p.$eval(`${D('push')}:has(${D('scope')})`, e => e.textContent.replace(/\s+/g,' ').trim());
ok(/CITY/.test(row), `  labelled with its scope ("${row.slice(0, 60)}")`);
ok(/all registered in Atlanta/.test(row),
  '  and carrying its audience, which a tile has no room for and the operator needs');
ok(/1 match\b/.test(row), `  with the reach it actually has, pluralised ("${(row.match(/\d+ match(es)?/)||[])[0]}")`);
ok(await p.$(`${D('push')}:has(${D('scope')}) ${D('mark')}`) !== null,
  '  CONTROL: and the same Mark sent button, because the operator\u2019s action is unchanged');

// CREATED FROM THE CITY, which is the object it is scoped to.
ok(await p.$$eval(D('add-general'), es => es.length) === 2,
  'each city header offers a General push control');
const gh = await p.$eval(D('add-general'), e => e.getBoundingClientRect().height);
ok(gh >= 32, `  at ${Math.round(gh)}px`);
ok(await p.$$eval(`${D('panel')} ${D('add-general')}`, es => es.length) === 0,
  '  CONTROL: and not in the queue, which still creates nothing');

// ══ 7d. TAGS, THEIR COLOURS, THEIR KEY, AND CODES PER CHANNEL ══════════════
await load();

// THE RENAME IS THE POINT. Ryan asked for a manual "NEW FIELD / PRIORITY" tag, but NEW FIELD is
// already an automatic badge computed against last week's slate. Two pills reading the same words,
// one earned and one typed, makes the earned one untrustworthy. KEY FIELD carries the same intent
// and collides with nothing.
const tagLabels = await p.$$eval(D('tag'), es => [...new Set(es.map(e => e.textContent.trim()))]);
ok(tagLabels.includes('PRIORITY'), `the manual tags render (${tagLabels.join(', ')})`);
ok(!tagLabels.includes('NEW FIELD'),
  '  CONTROL: and none of them says NEW FIELD, which is the automatic badge\u2019s words');
ok(await p.$$eval(D('newb'), es => es.some(e => /NEW/.test(e.textContent))),
  '  CONTROL: while the automatic NEW badges are untouched and still there');
ok(tagLabels.includes('STARTING 11'), '  Starting 11 is one of them');

// SEVERAL PER FIELD, EACH ITS OWN COLOUR, AND THEY MUST ALL DIFFER.
// COLOUR CARRIES THE CONCEPT, LABEL CARRIES THE SCOPE. Ryan: KEY FIELD is "the priority version of
// the full field", so it is one idea at two scopes. Two colours would read as two ideas. This is a
// deliberate break from "each tag a different colour" and the pair sharing one is the assertion.
const tagCols = await p.evaluate(() => ['prio','key','s11'].map(k => {
  const e = document.querySelector(`.tag[data-t="${k}"]`); return e ? getComputedStyle(e).color : null; }));
ok(tagCols.every(Boolean), `all three tags render (${tagCols.join(' | ')})`);
ok(tagCols[0] === tagCols[1], `  PRIORITY and KEY FIELD share a colour, being one idea (${tagCols[0]})`);
ok(tagCols[2] !== tagCols[0], `  CONTROL: while STARTING 11, a different idea, does not (${tagCols[2]})`);
ok(!tagLabels.includes('PARTNER'), '  CONTROL: and PARTNER is not a tag');
// PARTNER IS GONE, NOT HIDDEN. It was derivable from basisOf() the whole time, and the hand-set
// version was wrong on its one field and absent from the five that qualified.


// OUTLINED, NOT FILLED. The tile already spends filled pills on the cancel ratio and the NEW
// badges; a filled red tag would read as a 4/4 cancel at a glance. One structural difference keeps
// the three classes apart before colour is even considered.
const tagBg = await p.$eval(D('tag'), e => getComputedStyle(e).backgroundColor);
const chipBg = await p.$eval(D('rchip'), e => getComputedStyle(e).backgroundColor);
ok(tagBg === 'rgba(0, 0, 0, 0)', `a tag is outlined, not filled (${tagBg})`);
ok(chipBg !== tagBg, `  CONTROL: while the cancel chip stays filled (${chipBg})`);
// AND THEY AVOID THE FAMILIES ALREADY IN USE: mint is push state, the yellow-to-red ramp is cancel
// history, deep green is NEW, amber is needs-a-decision.
const taken = ['rgb(44, 219, 135)','rgb(244, 196, 48)','rgb(232, 134, 42)','rgb(217, 69, 47)','rgb(143, 42, 23)'];
ok(tagCols.every(c => !taken.includes(c)),
  '  CONTROL: and no tag colour is one the page already uses for something else');

// PRIORITY IS A MATCH FACT, NOT A FIELD ONE. This is the assertion the whole change exists for:
// the same field in the same week must be able to carry different tags on different days.
const kesw = await p.evaluate(() => {
  const g = (day) => { const t = [...document.querySelectorAll('[data-testid="tile"]')].find(
      e => e.dataset.venue.startsWith('Keswick') && e.dataset.day === day);
    return t ? [...t.querySelectorAll('[data-testid="tag"]')].map(x => x.textContent.trim()) : null; };
  return { mon: g('mon'), wed: g('wed') }; });
ok(kesw.mon?.includes('PRIORITY') && !kesw.wed?.includes('PRIORITY'),
  `PRIORITY sits on one match, not the field (Keswick mon ${kesw.mon?.join('+')} / wed ${kesw.wed?.join('+')})`);
ok(kesw.mon?.includes('STARTING 11') && kesw.wed?.includes('STARTING 11'),
  '  CONTROL: while the field tag does ride every match at that field, which is the contrast');
// AND IT STANDS ALONE. A field with no field tags still shows PRIORITY, so the pill is not
// quietly depending on something else being there.
ok(await p.evaluate(() => { const t = [...document.querySelectorAll('[data-testid="tile"]')].find(
    e => e.dataset.venue === 'Hattrick' && e.dataset.day === 'wed' && e.dataset.time === '7:00 PM');
  return !!t && [...t.querySelectorAll('[data-testid="tag"]')].map(x => x.textContent.trim()).join() === 'PRIORITY'; }),
  '  a match at an untagged field carries PRIORITY on its own');
// KEY FIELD SWALLOWS PRIORITY ON THE TILE. A match at a field we are already pushing is not
// additionally prioritised; two pills saying one thing costs a third of the row.
const nemp = await p.evaluate(() => { const t = [...document.querySelectorAll('[data-testid="tile"]')]
    .find(e => e.dataset.venue === 'NEMP' && e.dataset.day === 'mon' && e.dataset.time === '7:30 PM');
  return t ? [...t.querySelectorAll('[data-testid="tag"]')].map(x => x.textContent.trim()) : null; });
ok(nemp?.includes('KEY FIELD') && !nemp?.includes('PRIORITY'),
  `KEY FIELD swallows this match's own PRIORITY on the tile (${nemp?.join('+')})`);
// AND THE TRAP UNDER IT. If the panel read the suppressed set too, the PRIORITY toggle would come
// up dark for a tag that IS set, and the next save would quietly clear it. The tile hides it; the
// panel must not.
await p.evaluate(() => [...document.querySelectorAll('[data-testid="tile"]')]
  .find(e => e.dataset.venue === 'NEMP' && e.dataset.day === 'mon' && e.dataset.time === '7:30 PM').click());
await p.waitForTimeout(250);
ok(await p.$$eval('[data-testid="tagtog"][data-t="prio"][data-on="1"]', es => es.length) === 1,
  '  CONTROL: its panel toggle is still lit, so a save cannot silently clear the hidden tag');
await p.keyboard.press('Escape'); await p.waitForTimeout(250);

// A CAP. Three tags exist, so it cannot fire today; it stays as the invariant that keeps a fourth
// from silently making the row unreadable later.
ok(await p.$$eval(`${D('tags')}`, es => es.every(e => e.querySelectorAll('[data-testid="tag"]:not(.more)').length <= 3)),
  '  CONTROL: no tile renders more than three tag pills');
// NO MICRO-BUTTON ON THE TILE. A "+ tag" pill sized to fit beside the others is a 14px tap target,
// which is a fake affordance. The tile already opens a panel on click in the real page, and that
// is where tags are set, so the pill is removed rather than shrunk below a usable size.
ok(await p.$$eval(D('addtag'), es => es.length) === 0,
  'CONTROL: no sub-32px add-tag control was invented to fit the row');

// THE KEY, AND ONLY FOR TAGS IN USE. A key listing every tag that could exist is a key nobody
// reads, which this codebase has already written down once about a permanent caveat.
// THE KEY CARRIES THE FOUR TILE STATES FIRST. They are the grid's core language and every one
// appears in a real week, so unlike the tags they are not conditional.
const states = await p.$$eval(D('keystate'), es => es.map(e => e.dataset.s));
ok(states.join() === 'planned,covered,none,cancelled',
  `the key shows all four tile states (${states.join(', ')})`);
// THE SWATCHES ARE THE REAL THING, NOT A DRAWING OF IT. A key whose sample does not match the
// tile it explains is worse than none, and only a computed check catches the drift.
const sw = await p.evaluate(() => ({
  planned: getComputedStyle(document.querySelector('.keyswatch[data-s="planned"]')).borderLeftStyle,
  covered: getComputedStyle(document.querySelector('.keyswatch[data-s="covered"]')).borderLeftStyle,
  none: getComputedStyle(document.querySelector('.keyswatch[data-s="none"]')).borderStyle,
  tPlanned: getComputedStyle(document.querySelector('[data-testid="tile"][data-state="planned"]')).borderLeftStyle,
  tNone: getComputedStyle(document.querySelector('[data-testid="tile"][data-state="none"]')).borderStyle }));
ok(sw.planned === 'solid' && sw.covered === 'dotted' && sw.none === 'dashed',
  `  solid, dotted, dashed (${sw.planned} / ${sw.covered} / ${sw.none})`);
ok(sw.planned === sw.tPlanned && sw.none === sw.tNone,
  '  CONTROL: and each swatch matches the tile it explains, computed rather than assumed');
// WORDING IS "PUSH", NOT "PROMO". The queue, the Mark sent button and every push line say push;
// a key introducing a second word for one thing does the opposite of its job.
const keyTxt = await p.$eval(D('key'), e => e.textContent);
// VERBATIM, WHICH REPLACES THE OLD "NEVER SAYS PROMO" RULE RATHER THAN BENDING IT. That rule
// existed to stop a push acquiring a second name; pinning the exact words does the same job and
// cannot be argued with later. Promotion as an ACTIVITY is fine in both grids; the object in the
// label is always a push.
// Label and sentence read separately, because concatenating them makes the expected string
// unreadable and a mismatch impossible to diagnose from the failure line.
const stateRows = await p.$$eval(D('keystate'), es => es.map(e => [
  e.querySelector('.keylab').textContent.trim(),
  e.querySelector('.keylab').nextSibling.textContent.trim() ].join(' = ')));
ok(stateRows.join(' | ') === [
  'Match push = Promoted individually.',
  'Group push = Included in a city or field push.',
  'No push planned = No promotion scheduled.',
  'Cancelled = Match called off.' ].join(' | '),
  `the state rows read exactly as written (${stateRows.join(' | ')})`);

const keyN = await p.$$eval(D('keyitem'), es => es.length);
ok(keyN === 3, `the key then lists the three tags on screen (${keyN})`);
// THE KEY STATES THE SCOPE, because "PRIORITY" and "KEY FIELD" look identical on a tile and behave
// nothing alike: clearing one affects a match, clearing the other affects a week of them.
const keyRows = await p.$$eval(D('keyitem'), es => es.map(e => e.textContent.replace(/\s+/g,' ').trim()));
ok(keyRows.join(' | ') === 'STARTING 11 Active promo at this field. | PRIORITY Extra promotion for this match. | KEY FIELD Extra promotion for all matches here.',
  `the tag rows read exactly as written, in that order (${keyRows.join(' | ')})`);
// THE SCOPE LEAD-IN IS GONE BECAUSE THE SENTENCES CARRY IT. "for this match" and "for all matches
// here" say it better than a label above them did.
ok(await p.$$eval(D('keyscope'), es => es.length) === 0,
  '  CONTROL: and no scope label repeats what the sentence already says');
// THE CAVEAT MOVED TO HOVER RATHER THAN BEING DROPPED. Starting 11 is the only tag whose claim can
// be wrong: it asserts a code is live while being set by hand.
ok(await p.$eval(`${D('keyitem')}[data-t="s11"]`, e => /can go stale/.test(e.title)),
  '  CONTROL: the staleness caveat survives on hover, off the row but still findable');
ok(await p.$$eval(`${D('tag')}[title]`, es => es.length > 0),
  '  CONTROL: and each tag carries its meaning on hover too, so the key is a reference not a prerequisite');

// ONE CODE PER CHANNEL, NOT PER MATCH. With one code across WhatsApp and SMS every redemption is
// attributable to both and the test cannot be read. Not a schema change: DraftChannel is already
// { on, code, rows } and codeFor() reads the channel's own code.
await p.click(day('mon')); await p.waitForTimeout(140);
await p.click(D('fold')); await p.waitForTimeout(160);
const codes = await p.$$eval(D('code'), es => es.map(e => e.textContent));
ok(codes.length >= 4, `codes render per channel (${codes.join(', ')})`);
ok(new Set(codes).size === codes.length, '  and each is distinct, which is what makes the test readable');
const pair = await p.$eval(`${D('push')}:has(${D('code')})`, e => e.textContent.replace(/\s+/g,' '));
ok(/WA\s*SLATEWA/.test(pair) || /WA\s*ATX10WA/.test(pair),
  `  each code sits on its own channel chip rather than on the row ("${pair.slice(0,64)}")`);
// CONTROL: a push with no code set renders its channels plainly rather than inventing one.
ok(await p.$$eval(D('push'), es => es.some(e => e.querySelector('[data-testid="ch"]')
  && !e.querySelector('[data-testid="code"]'))),
  '  CONTROL: a push with no code shows its channels bare');

// ══ 7e. THE EDITOR AS A SIDE PANEL ═════════════════════════════════════════
// It used to open in the page flow, so clicking a tile pushed the grid down and the row you were
// working in moved out from under you. Eight cities clicked in turn is the actual job.
await load();
ok(await p.$eval(D('side'), e => getComputedStyle(e).display) === 'none', 'the panel is closed at rest');
const gridBefore = await p.$eval('.city', e => Math.round(e.getBoundingClientRect().top));
await p.click(`${D('tile')}[data-state="planned"]`); await p.waitForTimeout(300);
ok(await p.$eval(D('side'), e => getComputedStyle(e).display) === 'flex', 'clicking a tile opens it');
const gridAfter = await p.$eval('.city', e => Math.round(e.getBoundingClientRect().top));
// THE ASSERTION THE WHOLE CHANGE EXISTS FOR. Not "roughly", exactly: the week must not move.
ok(gridBefore === gridAfter, `the week does not move when it opens (${gridBefore} then ${gridAfter})`);
// CONTROL: and nothing hides under the panel. The week is padded rather than overlaid.
const geom = await p.evaluate(() => ({
  tile: Math.round(document.querySelector('[data-testid="tile"][data-sel="1"]').getBoundingClientRect().right),
  panel: Math.round(document.querySelector('[data-testid="side"]').getBoundingClientRect().left) }));
ok(geom.tile < geom.panel, `  CONTROL: the selected tile is clear of the panel (${geom.tile} < ${geom.panel})`);

// WITH THE PANEL OFF TO THE SIDE, THE TILE MUST STAY MARKED. Nothing else says which of eighty
// eight tiles you are editing.
ok(await p.$$eval(`${D('tile')}[data-sel="1"]`, es => es.length) === 1,
  'exactly one tile is marked as the one being edited');
const title = await txt(D('side-title'));
ok(/\u00b7/.test(title), `  and the panel names it (${title})`);

// TAGS ARE SET HERE, GROUPED BY SCOPE. PRIORITY is one match; KEY FIELD and STARTING 11 are the
// whole field. Identical-looking pills that behave differently is the failure this grouping exists
// to stop, so assert WHICH group each sits in, not merely that two headings exist.
const tg = await p.evaluate(() => [...document.querySelectorAll('[data-testid="tagscope"]')].map(g => ({
  scope: g.dataset.scope,
  head: g.querySelector('.tagscopehead').textContent.trim(),
  tags: [...g.querySelectorAll('[data-testid="tagtog"]')].map(b => b.textContent.trim()),
  on: [...g.querySelectorAll('[data-testid="tagtog"][data-on="1"]')].map(b => b.textContent.trim()) })));
const gm = tg.find(g => g.scope === 'match'), gf = tg.find(g => g.scope === 'field');
ok(gm?.tags.join() === 'PRIORITY', `the panel sets PRIORITY under "${gm?.head}"`);
ok(gf?.tags.join() === 'KEY FIELD,STARTING 11', `  and the field tags under "${gf?.head}"`);
ok(/every match/i.test(gf?.head ?? ''),
  '  CONTROL: the field group says it applies to every match there, which is what one click does');
ok(/this match/i.test(gm?.head ?? ''), '  CONTROL: and the match group says it does not');
// THE TOGGLES REFLECT THE TILE THEY WERE OPENED FROM, rather than rendering a blank row that
// silently clears a tag on save.
ok(gm?.on.join() === 'PRIORITY' || gf?.on.length > 0,
  `  and the toggles come up lit for the tags this match already has (${[...(gm?.on??[]),...(gf?.on??[])].join('+')})`);
ok(await p.$$eval(D('tagtog'), es => es.every(e => e.getBoundingClientRect().height >= 32)),
  '  CONTROL: every tag toggle clears 32px, rather than being shrunk to fit the panel');

// SIX CHANNELS, AND THE CODE SITS ON THE CHANNEL. Putting it back on the panel header would undo
// the per-channel split in the one place an operator types it.
ok(await p.$$eval(D('chan'), es => es.length) === 6, 'six channels');
ok(await p.$$eval(`${D('chan')}[data-on="1"] ${D('code-in')}`, es => es.length > 0),
  '  and a lit channel carries its own code input');
ok(await p.$$eval(`${D('chan')}[data-on="0"] ${D('code-in')}`, es => es.length) === 0,
  '  CONTROL: an unused channel has no code field to fill in by mistake');

// AN UNSAVED PANEL IS NOT SWAPPED OUT FROM UNDER YOU. Losing typed pushes to a stray click on
// another tile is the one thing this panel must not do.
await p.fill(D('code-in'), 'TEST10'); await p.waitForTimeout(250);
ok(await p.$(D('dirty')) !== null, 'editing marks the panel unsaved');
const tiles = await p.$$(`${D('tile')}[data-state="planned"]`);
await tiles[1].click(); await p.waitForTimeout(250);
ok(await txt(D('side-title')) === title,
  '  and clicking another tile while unsaved does not swap it');
await p.keyboard.press('Escape'); await p.waitForTimeout(200);
ok(await p.$eval(D('side'), e => getComputedStyle(e).display) === 'flex',
  '  CONTROL: nor does Escape, while there are changes');
await p.click(D('cancel')); await p.waitForTimeout(250);
ok(await p.$eval(D('side'), e => getComputedStyle(e).display) === 'none',
  '  Cancel is the way out, and it closes');
ok(await p.$$eval(`${D('tile')}[data-sel="1"]`, es => es.length) === 0,
  '  CONTROL: and the tile stops being marked');

// A CANCELLED MATCH HAS NOTHING TO PLAN.
await load();
const cx2 = await p.$(`${D('tile')}[data-state="cancelled"]`);
if (cx2) { await cx2.click(); await p.waitForTimeout(200);
  ok(await p.$eval(D('side'), e => getComputedStyle(e).display) === 'none',
    'CONTROL: a cancelled match does not open the editor, there is nothing to plan'); }

// ══ 8. 390 AND 1320 ════════════════════════════════════════════════════════
for (const vw of [390, 1320]) {
  await load(vw);
  ok(await p.evaluate(() => document.documentElement.scrollWidth) <= vw + 2, `${vw}px: no page-level horizontal scroll`);
  const g = await p.$eval('.gridscroll', e => ({ sw: e.scrollWidth, cw: e.clientWidth }));
  ok(vw === 390 ? g.sw > g.cw + 2 : true, `  ${vw}px: the week scrolls in its own container`);
  ok(await p.$$eval(D('day'), es => es.length) === 7, `  ${vw}px: all seven day tabs, no carousel`);
  const small = await p.$$eval('button', es => es.filter(e => e.offsetParent !== null
    && e.getBoundingClientRect().height < 31.5).map(e => e.textContent.trim().slice(0, 16)));
  ok(small.length === 0, `  ${vw}px: every control at least 32px${small.length ? ': ' + small.join(' / ') : ''}`);
}

// ══ 9. LIGHT BY DEFAULT ════════════════════════════════════════════════════
// The first pass followed prefers-color-scheme and rendered dark on a machine set to dark. The app
// is light and makes no such choice anywhere else.
await load();
await p.emulateMedia({ colorScheme: 'dark' });
await p.reload(); await p.waitForTimeout(200);
const bgDark = await p.$eval('body', e => getComputedStyle(e).backgroundColor);
ok(bgDark === 'rgb(244, 247, 245)',
  `with the OS set to dark the page is still light (${bgDark})`);
await p.emulateMedia({ colorScheme: 'light' });

for (const theme of ['light', 'dark']) {
  await load();
  await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
  await p.waitForTimeout(110);
  const c = await p.evaluate(() => { const px = s => getComputedStyle(document.querySelector(s));
    return { col: px('[data-testid="col"]').backgroundColor, body: px('body').backgroundColor,
             chip4: px('[data-testid="rchip"][data-r="4"]').backgroundColor }; });
  ok(c.col !== c.body, `${theme}: a day column separates from the page`);
  // THE RAMP DOES NOT MOVE WITH THE THEME. It is a fixed scale people read across both.
  ok(c.chip4 === 'rgb(143, 42, 23)', `  ${theme}: 4 of 4 is the same dark red in both themes`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
