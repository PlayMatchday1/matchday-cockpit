/* THE MOCK'S ASSERTIONS (scripts/mocks/measure-funnel-cities.mjs), REWRITTEN AGAINST THE REAL PAGE.
 *
 *   npx tsx --env-file=.env.local scripts/_check_funnel_cities.mjs
 *   BASE=https://matchday-clubhouse.vercel.app npx tsx --env-file=.env.local scripts/_check_funnel_cities.mjs
 *
 * GATED BEFORE IT RUNS: node --check parses it, scripts/_bindcheck.mjs binds it. A parse check is not
 * a bind check; removing a block from a sibling script once took seven bindings with it and the run
 * died on a ReferenceError at assertion 84.
 *
 * EVERY ABSENCE CHECK CARRIES A PRESENCE CONTROL IN THE SAME RUN, and every zero read from a selector
 * this file wrote asserts its own container first: a selector that matches nothing and a component
 * that renders nothing both return 0. `cards: 0` on this page was a testid I invented for a component
 * that has none, while the cards had been rendering the whole time.
 *
 * DERIVE, DO NOT PIN. The live page moves: registrations grow, the current month rolls over. Every
 * expectation is computed from what the page is showing or from the same libraries it uses.
 */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
import { clampMonthsToNow, businessMonthKey } from '../src/lib/funnelMonth.ts';
installHarnessGuard();

const BASE = process.env.BASE || 'http://localhost:3000';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const ctx = await b.newContext({ storageState, viewport: { width: 1320, height: 1000 } });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
/* NODE SIDE ONLY. D() builds a selector STRING for Playwright; it does not exist inside a
 * page.evaluate callback, which runs in the browser. Two callbacks referenced it and died on
 * "D is not defined" - and the bind check passed, because D IS bound, just not on the side that
 * evaluates. Inside a callback, write the attribute selector out. */
const D = t => `[data-testid="${t}"]`;

const load = async (w = 1320) => {
  await p.setViewportSize({ width: w, height: 1000 });
  await p.goto(`${BASE}/lifecycle/funnel`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector(D('funnel-row'), { timeout: 60000 });
  await p.waitForTimeout(1200);
};
await load();
ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);

// ══ 1. ONE RANGE, NO BUBBLES, AND THE CARDS STILL HAVE ONE ════════════════════════════════════
/* Removing PeriodBar alone would have orphaned KpiRow, which filters everything on period.start /
   period.end - with no selector it freezes on whatever default the provider hands it. So the range
   moved UP and drives both panels. */
const controls = await p.evaluate(() => ({
  bubbles: document.querySelectorAll('[data-testid="growth-period"]').length,
  ranges: document.querySelectorAll('[data-testid="funnel-range"]').length,
  monthInputs: document.querySelectorAll('input[type="month"]').length,
  /* KpiRow HAS NO TESTIDS, so the cards are found by their own class. Counted, not assumed: a zero
     here would otherwise be indistinguishable from a selector I made up. */
  cardLabels: [...document.querySelectorAll('[class*="kpiLabel"]')].map(e => e.textContent.trim()),
}));
ok(controls.cardLabels.length === 4, `CONTROL: the four KPI cards are on the page (${controls.cardLabels.length})`);
ok(controls.bubbles === 0, `no period bubbles on this page (${controls.bubbles})`);
ok(controls.ranges === 1, `  and exactly one range control (${controls.ranges})`);
ok(controls.monthInputs === 2, `  which is two month inputs and no more (${controls.monthInputs})`);

/* ── THE DEFAULT IS SIX MONTHS ENDING IN THE CURRENT MONTH ─────────────────────────────────────
   Which is what the removed bubble did, so the page says the same thing on load as it did before.
   DERIVED FROM THE BUSINESS CLOCK, not pinned: this assertion must still pass in October. */
const rangeState = await p.evaluate(() => {
  const s = document.querySelector('[data-testid="funnel-range-start"]');
  const e = document.querySelector('[data-testid="funnel-range-end"]');
  return { start: s.value, end: e.value, min: s.min, max: s.max, endMax: e.max };
});
const spanOf = (a, z) => {
  const [ay, am] = a.split('-').map(Number); const [zy, zm] = z.split('-').map(Number);
  return (zy - ay) * 12 + (zm - am) + 1;
};
ok(spanOf(rangeState.start, rangeState.end) === 6,
  `the default range is a six-month span (${rangeState.start} to ${rangeState.end})`);
ok(rangeState.end === businessMonthKey(), `  ending in the current business month (${rangeState.end})`);
ok(rangeState.min === '2023-03', `  and the earliest selectable month is Mar 2023 (${rangeState.min})`);
ok(rangeState.max === businessMonthKey() && rangeState.endMax === businessMonthKey(),
  `  CONTROL: with both pickers capped at the current month (${rangeState.max} / ${rangeState.endMax})`);
ok(spanOf(rangeState.min, rangeState.max) > 6,
  `  CONTROL: so the whole axis is reachable and the default is a choice, not a limit (${spanOf(rangeState.min, rangeState.max)} months offered)`);

/* ── THE CARDS RE-READ THE RANGE ───────────────────────────────────────────────────────────────
   The assertion this item turns on. The card NAMES its window, so a card that stopped following
   would keep the old month in its own label. */
const labelsBefore = controls.cardLabels.join(' | ');
ok(labelsBefore.includes(rangeState.end.split('-')[0]),
  `  the cards name the range on themselves ("${controls.cardLabels[1]}")`);
await p.fill(D('funnel-range-start'), '2026-08');
await p.waitForTimeout(800);
const after = await p.evaluate(() => ({
  labels: [...document.querySelectorAll('[class*="kpiLabel"]')].map(e => e.textContent.trim()),
  echo: document.querySelector('[data-testid="funnel-range-echo"]').textContent.trim(),
}));
ok(after.labels.length === 4, `CONTROL: still four cards after the range changed (${after.labels.length})`);
ok(after.labels.join(' | ') !== labelsBefore,
  `  and they re-read it rather than freezing ("${after.labels[1]}")`);
ok(/Aug 2026/.test(after.labels[1]), `  naming the new start month (${after.labels[1]})`);
ok(/Aug 2026/.test(after.echo), `  CONTROL: and the control agrees with them (${after.echo})`);

// ══ 2. THE CURRENT MONTH IS THE CURRENT MONTH ═════════════════════════════════════════════════
/* The axis ends at max(nowMonth, last booked match month) and growth_play_dims carries BOOKED
   matches, so it ran into the future and this page called its last entry current. */
await load();
const rowNames = await p.$$eval(D('funnel-row'), es => es.map(e => ({
  name: e.querySelector('[class*="funnelPeriodName"]')?.textContent.trim(),
  meta: e.querySelector('[class*="funnelPeriodMeta"]')?.textContent.trim(),
})));
ok(rowNames.length >= 4, `CONTROL: the table rendered ${rowNames.length} rows, so the checks below are not free`);
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const labelFor = k => `${MONTHS[Number(k.split('-')[1]) - 1]} ${k.split('-')[0]}`;
const nowKey = businessMonthKey();
const prevKey = (() => { const [y, m] = nowKey.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; })();
const cur = rowNames.find(r => r.meta === 'current month');
const prv = rowNames.find(r => r.meta === 'previous month');
ok(cur?.name === labelFor(nowKey), `the current-month row reads ${labelFor(nowKey)} (${cur?.name})`);
/* CONTROL: AND THE PREVIOUS ROW MOVED WITH IT. A relabel would leave that row on the old month,
   which is the only thing separating a fix from a cosmetic patch. */
ok(prv?.name === labelFor(prevKey), `  CONTROL: and the previous-month row moved to ${labelFor(prevKey)} (${prv?.name})`);
/* CONTROL: the future month appears nowhere. Asserted against the page text, not just these rows. */
const nextKey = (() => { const [y, m] = nowKey.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; })();
const bodyText = await p.evaluate(() => document.body.innerText);
ok(!bodyText.includes(labelFor(nextKey)), `  CONTROL: ${labelFor(nextKey)} appears nowhere on the page`);
ok(bodyText.includes(labelFor(nowKey)), `  CONTROL: while ${labelFor(nowKey)} does, so the check above is not free`);
/* AND THE CLAMP IS THE LIBRARY'S, not a second implementation on the page. */
const axisEnd = await p.evaluate(() => document.querySelector('[data-testid="funnel-range-end"]').max);
ok(clampMonthsToNow([axisEnd, nextKey]).join() === axisEnd,
  `  CONTROL: clampMonthsToNow drops ${nextKey} and keeps ${axisEnd}, so the page and the library agree`);
/* THE CURRENT MONTH IS STILL MARKED PART-ELAPSED. Clamping it is not the same as pretending it closed. */
ok(await p.$$eval(D('funnel-conv-partial'), es => es.length) > 0,
  '  and the current month is still marked part-elapsed');

// ══ 3. THE CITY PICKER, AND WHAT IS NOT A FLEET CITY ══════════════════════════════════════════
const chips = await p.$$eval(D('funnel-city-chip'), es => es.map(e => ({
  city: e.dataset.city, other: e.dataset.other === '1', licensee: e.dataset.licensee === '1',
  count: e.querySelector('[data-testid="funnel-city-count"]')?.textContent.trim() ?? null,
  h: Math.round(e.getBoundingClientRect().height),
  w: Math.round(e.getBoundingClientRect().width),
})));
ok(chips.length > 2, `CONTROL: the picker rendered ${chips.length} chips`);
ok(chips.every(c => c.h >= 32), `every chip is at least 32px (min ${Math.min(...chips.map(c => c.h))})`);
ok(await p.$$eval('select[multiple]', es => es.length) === 0,
  '  CONTROL: and there is no native multiple-select, which needs a modifier key a phone lacks');
const others = chips.filter(c => c.other);
ok(others.length > 0, `CONTROL: ${others.length} chip(s) sit below the separator`);
ok(others.every(c => c.count && /\d/.test(c.count)),
  `  and each carries its registration count (${others.map(c => `${c.city} ${c.count}`).join(', ')})`);
ok(chips.filter(c => !c.other && c.city !== 'All cities').every(c => c.count === null),
  '  CONTROL: while fleet chips carry no count, so the count marks them out rather than decorating');
ok(await p.$(D('funnel-city-sep')) !== null, '  and a separator divides the two groups');
const licensees = others.filter(c => c.licensee);
ok(licensees.length > 0, `a licensee is labelled as one (${licensees.map(c => c.city).join(', ')})`);
ok(await p.$$eval(`${D('funnel-city-chip')}[data-licensee="1"] ${D('funnel-city-licensee')}`, es => es.length) === licensees.length,
  '  with the word visible on the chip, not only in a title');
const licTitle = await p.$eval(`${D('funnel-city-chip')}[data-licensee="1"]`, e => e.getAttribute('title') ?? '');
ok(/brand licence/.test(licTitle) && /not a MatchDay market/.test(licTitle),
  '  and its own title says it is a separate operator, not a spelling variant');
/* NOT FILTERED OUT. The picker IS the filter, so a licensee is present and deselectable rather than
   hidden - and the totals therefore reconcile on the full set. */
ok(licensees.every(c => c.count && Number(c.count.replace(/,/g, '')) > 0),
  `  CONTROL: it is counted, not hidden (${licensees.map(c => c.count).join(', ')})`);

// ══ 4. TWO OR MORE CITIES BECOME CITY ROWS, AND THE TOTAL IS THE CONTROL ══════════════════════
const pickable = chips.filter(c => c.city !== 'All cities').slice(0, 2).map(c => c.city);
await p.click(`${D('funnel-city-chip')}[data-city="${pickable[0]}"]`);
await p.waitForTimeout(500);
const oneCity = await p.$$eval(D('funnel-row'), es => es.map(e => e.querySelector('[class*="funnelPeriodMeta"]')?.textContent.trim()));
ok(oneCity.includes('current month'), `one city keeps the month rows (${oneCity.join(', ')})`);
const note1 = await p.$eval(D('funnel-pick-note'), e => e.textContent.trim());
ok(note1.includes(pickable[0]), `  and the note names the city ("${note1}")`);
await p.click(`${D('funnel-city-chip')}[data-city="${pickable[1]}"]`);
await p.waitForTimeout(600);
const cityRows = await p.$$eval(D('funnel-row'), es => es.map(e => ({
  isCity: e.dataset.cityRow === '1', isTotal: e.dataset.totalRow === '1',
  name: e.querySelector('[class*="funnelPeriodName"]')?.textContent.trim(),
  nums: [...e.querySelectorAll('[data-testid="funnel-cell"]')].map(c => {
    const t = c.querySelector('[class*="funnelSnum"]')?.textContent.trim() ?? '';
    return t === '—' ? null : Number(t.replace(/,/g, ''));
  }),
  stages: [...e.querySelectorAll('[data-testid="funnel-cell"]')].map(c => c.dataset.stage),
})));
ok(cityRows.length === 3, `two cities give one row each plus a total (${cityRows.length} rows)`);
ok(cityRows.every(r => r.isCity), '  and the month rows gave way rather than doubling up');
const metas = await p.$$eval(D('funnel-row'), es => es.map(e => e.querySelector('[class*="funnelPeriodMeta"]')?.textContent.trim()));
ok(!metas.includes('current month'), '  CONTROL: no month row survives alongside them');
const totals = cityRows.filter(r => r.isTotal);
ok(totals.length === 1, `  with exactly one total row (${totals.length})`);
/* THE ARITHMETIC CONTROL. City rows that do not sum to their own total is the failure this table
   would otherwise hide, because every row looks plausible alone. Asserted per stage. */
const per = cityRows.filter(r => !r.isTotal);
const tot = totals[0];
const stageCount = tot.nums.length;
let sumsOk = true, detail = [];
for (let i = 0; i < stageCount; i++) {
  if (tot.nums[i] == null) continue;
  const s = per.reduce((a, r) => a + (r.nums[i] ?? 0), 0);
  detail.push(`${tot.stages[i]} ${s}=${tot.nums[i]}`);
  if (s !== tot.nums[i]) sumsOk = false;
}
ok(detail.length >= 4, `CONTROL: ${detail.length} numeric stages to reconcile, so the sum check is not free`);
ok(sumsOk, `  the city rows sum to their total on every stage (${detail.join(', ')})`);

// ══ 5. NO PER-CITY DOWNLOAD FIGURE, AND THE DASH SAYS WHY ═════════════════════════════════════
/* funnelByMonthCity carries registrations and played1/3/5/10 only. Store installs arrive with NO city
   dimension, so a number here would be invented. */
const dl = await p.evaluate(() => ({
  cells: [...document.querySelectorAll('[data-testid="funnel-cell"][data-stage="downloads"]')].map(e =>
    (e.querySelector('[class*="funnelSnum"]')?.textContent.trim() ?? '')),
  why: document.querySelectorAll('[data-testid="funnel-why-dash"]').length,
  whyText: [...new Set([...document.querySelectorAll('[data-testid="funnel-why-dash"]')].map(e => e.textContent.trim()))],
}));
ok(dl.cells.length > 0, `CONTROL: ${dl.cells.length} download cells are on screen`);
ok(dl.cells.every(t => t === '—'), `no per-city download figure anywhere in the column (${dl.cells.join(' ')})`);
ok(dl.why === dl.cells.length, `  and every one says why (${dl.why} of ${dl.cells.length}: ${dl.whyText.join(' / ')})`);
/* CONTROL: EVERY CITY CARRIES A REGISTRATIONS FIGURE, so the dash reads as specific to downloads
   rather than as missing data. */
const regsPresent = cityRows.every(r => {
  const i = r.stages.indexOf('registrations');
  return i >= 0 && typeof r.nums[i] === 'number' && r.nums[i] > 0;
});
ok(regsPresent, '  CONTROL: while every city row carries a registrations figure');
/* AND THE FIRST CONVERSION IS A DASH TOO, since its numerator is missing. */
const firstConv = await p.$$eval(`${D('funnel-row')} [class*="funnelConv"]`, es =>
  es.slice(0, 1).map(e => e.textContent.trim()));
ok(firstConv[0] === '—', `  and the first conversion is a dash as well (${firstConv[0]})`);

// ══ 6. THE CITY RULE IS ON THE PAGE, IN VISIBLE TEXT ══════════════════════════════════════════
const rule = await p.$eval(D('funnel-city-rule'), e => e.textContent.replace(/\s+/g, ' ').trim());
ok(rule.length > 0, `CONTROL: the footnote rendered (${rule.length} chars)`);
ok(/declared when they registered/.test(rule), '  and it says the city is DECLARED at registration');
ok(/not where they played/.test(rule), '  and explicitly not where they played');
ok(/signups, not/.test(rule), '  and that a city funnel is signups rather than operations');
ok(/never city/.test(rule), '  and that the stores report country and region, never city');

// ══ 7. 390 AND 1320 ═══════════════════════════════════════════════════════════════════════════
for (const vw of [390, 1320]) {
  await load(vw);
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= vw + 2, `${vw}px: no page-level horizontal scroll (${sw})`);
  const geo = await p.evaluate(() => ({
    chips: [...document.querySelectorAll('[data-testid="funnel-city-chip"]')].map(e => ({
      h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })),
    scroller: (() => {
      const r = document.querySelector('[data-testid="funnel-row"]');
      let el = r?.parentElement;
      while (el && el !== document.body) {
        if (el.scrollWidth > el.clientWidth + 1) return { sw: el.scrollWidth, cw: el.clientWidth };
        el = el.parentElement;
      }
      return null;
    })(),
    controls: [...document.querySelectorAll('main button, main input, main select')]
      .filter(e => e.offsetParent !== null && e.getBoundingClientRect().height > 0
        && e.getBoundingClientRect().height < 31.5)
      .map(e => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 18)),
  }));
  ok(geo.chips.length > 0, `  CONTROL: ${vw}px: ${geo.chips.length} chips measured`);
  ok(geo.chips.every(c => c.h >= 32), `  ${vw}px: every chip at least 32px (min ${Math.min(...geo.chips.map(c => c.h))})`);
  ok(geo.chips.every(c => c.w <= vw), `  ${vw}px: no chip wider than the screen (max ${Math.max(...geo.chips.map(c => c.w))})`);
  ok(geo.controls.length === 0,
    `  ${vw}px: every control at least 32px${geo.controls.length ? ': ' + geo.controls.slice(0, 4).join(' / ') : ''}`);
  if (vw === 390) {
    ok(geo.scroller !== null,
      `  390px: the table scrolls in its own container rather than the page (${geo.scroller ? `${geo.scroller.sw} in ${geo.scroller.cw}` : 'NO SCROLLER'})`);
  }
}

// ══ 8. PeriodBar STILL WORKS WHERE IT IS USED ═════════════════════════════════════════════════
/* Removed from THIS page only, via a prop SectionFrame already had. BehaviorPanel still needs it. */
await p.setViewportSize({ width: 1320, height: 1000 });
await p.goto(`${BASE}/lifecycle/behavior`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector(D('growth-section'), { timeout: 60000 });
await p.waitForTimeout(1500);
ok(await p.$(D('growth-period')) !== null, 'PeriodBar still renders on Behavior, where it is used');
ok(await p.$$eval(`${D('growth-period')} button`, es => es.length) > 0,
  '  CONTROL: with its own controls, so it is the real bar and not an empty wrapper');

ok(errs.length === 0, `no page errors across the whole run${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
