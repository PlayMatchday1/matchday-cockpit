/* READ ONLY. Renders the page as it will look on the 1st, by rewriting the API response in flight:
 * the current month's cell becomes days 0 / partial true and its spots are emptied, exactly what
 * the route will send on day one. Nothing is written and no control is pressed. */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();
const BASE = process.env.BASE || 'http://localhost:3000';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport: { width: 1500, height: 1200 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const D = t => `[data-testid="${t}"]`;

let realGoal = null, realNow = null;
await p.route('**/api/growth/field-goals**', async (route) => {
  const res = await route.fetch();
  const j = await res.json();
  const cur = j.currentMonth;
  // what the route itself will send on the 1st
  j.months[cur] = { ...j.months[cur], spots: 0, days: 0, partial: true };
  for (const r of [...j.rows, ...j.slots]) r.monthly[cur] = { ...r.monthly[cur], spots: 0, matches: 0, days: 0, partial: true, daily: 0 };
  await route.fulfill({ response: res, body: JSON.stringify(j) });
});
// first, the REAL page, to capture the goal tile's true value as a control
await p.goto(`${BASE}/growth/daily-matches`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector(D('fg-goal-v'), { timeout: 40000 });
await p.waitForTimeout(900);
realGoal = await p.$eval(D('fg-goal-v'), e => e.textContent.trim());
realNow = await p.$eval(D('fg-now-v'), e => e.textContent.trim());
console.log(`\nday-one render: "${MONTHLABEL()}" tiles -> now "${realNow}"  goal "${realGoal}"  gap "${await p.$eval(D('fg-gap-v'), e => e.textContent.trim())}"`);
function MONTHLABEL() { return 'current month'; }

const now = await p.$eval(D('fg-now-v'), e => e.textContent.trim());
const goal = await p.$eval(D('fg-goal-v'), e => e.textContent.trim());
const gap = await p.$eval(D('fg-gap-v'), e => e.textContent.trim());
const nowSub = await p.$eval(D('fg-now'), e => e.lastElementChild.textContent.trim());
const gapSub = await p.$eval(D('fg-gap'), e => e.lastElementChild.textContent.trim());
const goalSub = await p.$eval(D('fg-goal'), e => e.lastElementChild.textContent.trim());

ok(now === '—', `the actual tile dashes ("${now}")`);
ok(nowSub === 'no completed days yet', `  and says why ("${nowSub}")`);
ok(gap === '—', `the To find tile dashes ("${gap}")`);
ok(gapSub === 'needs a completed day', `  and says why ("${gapSub}")`);
// THE CHECK THAT MATTERS: the goal is TYPED, not derived, so it must survive.
ok(/^[0-9]/.test(goal), `the Dec goal tile KEEPS its number ("${goal}")`);
ok(goal !== '—', `  CONTROL: it is not a dash`);
ok(goalSub === 'matches a day', `  and keeps its own unit label ("${goalSub}")`);
ok(await p.$(D('fg-bar')) === null, 'the progress bar is hidden rather than drawn at zero');

// the table: actual and gap dash, the typed December goal does not
await p.waitForSelector(D('fg-row'));
const row = await p.$$eval(D('fg-row'), es => {
  const e = es.find(x => x.querySelector('[data-testid="fg-goal-Dec"]')?.value);
  return e && { actual: e.querySelector('[data-testid="fg-actual"]').textContent.trim(),
                gap: e.querySelector('[data-testid="fg-gap-cell"]').textContent.trim(),
                dec: e.querySelector('[data-testid="fg-goal-Dec"]').value,
                oct: e.querySelector('[data-testid="fg-goal-Oct"]').value };
});
ok(!!row, `CONTROL: found a row carrying a typed December goal (dec=${row?.dec})`);
ok(row.actual === '—', `  its actual dashes ("${row.actual}")`);
ok(row.gap === '—', `  its gap dashes ("${row.gap}")`);
ok(/^[0-9]/.test(row.dec), `  its typed December goal SURVIVES ("${row.dec}")`);
ok(row.oct === '', `  and the Oct ramp is blank, because there is no actual to ramp from ("${row.oct}")`);

// the city grain, same rule
await p.click(D('grain-city'));
await p.waitForSelector(D('crow'));
await p.waitForTimeout(300);
const c = await p.$eval(D('crow'), e => ({
  sep: e.querySelector('[data-testid="sep"]').textContent.trim(),
  dec: e.querySelector('[data-testid="dec"]').textContent.trim(),
  gap: e.querySelector('[data-testid="gap"]').textContent.trim() }));
ok(c.sep === '—' && c.gap === '—', `city row: actual and gap dash ("${c.sep}" / "${c.gap}")`);
ok(/^[0-9]/.test(c.dec), `  city row: the December goal SURVIVES ("${c.dec}")`);
const tdec = await p.$eval(D('tdec'), e => e.textContent.trim());
ok(/^[0-9]/.test(tdec), `  and so does the All MatchDay December total ("${tdec}")`);
const title = await p.$eval(D('chart'), e => e.querySelector('.text-\\[13px\\]')?.textContent.trim() ?? '');
ok(/December goal by city/.test(title), `the city chart stops claiming to be a comparison ("${title}")`);
ok(await p.$$eval(D('bgoal'), es => es.length) > 0, `  CONTROL: the goal bars are still drawn (${await p.$$eval(D('bgoal'), es => es.length)})`);
ok(await p.$$eval(D('bact'), es => es.length) === 0, `  and the actual bars are not`);

// THE RAMP BARS. A ramp runs FROM the current month's actual, so on day one it has nothing to run
// from and must not draw a third of the December goal as though somebody suggested it.
await p.click(D('grain-field'));
await p.waitForSelector(D('fg-existing'));
await p.waitForTimeout(300);
const bars = await p.$$eval('[data-testid^="fg-bar-"]', es => es.map(e => ({
  m: e.getAttribute('data-testid').replace('fg-bar-', ''), state: e.dataset.state, v: e.dataset.value })));
const labels = await p.$$eval('svg text', es => es.map(e => e.textContent.trim()));
const dec = bars.find(b => b.m === 'Dec');
ok(Number(dec.v) > 0, `the December bar keeps its typed total (${dec.v})`);
ok(labels.filter(t => t === '\u2014').length >= 3,
  `the month-to-date bar and both ramp months are labelled with a dash (${labels.filter(t => t === '\u2014').length} dashes)`);
ok(labels.includes(String(dec.v)) || labels.some(t => /^[0-9]+\.[0-9]$/.test(t)),
  `  CONTROL: a real number is still drawn somewhere, so the dashes are not the whole axis`);

ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail ? 1 : 0);
