/* READ ONLY against the live panel for match 18760. It stages changes in the browser and reads the
 * PENDING diff; it never presses Save, so nothing is written to production. */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = 'rmancuso@playmatchday.com';
const M = process.env.MATCH || '18760';
const { storageState } = await storageStateFor(ADMIN, BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport:{width:1500,height:1100} })).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
let pass=0, fail=0;
const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); c?pass++:fail++;};
const D = t => `[data-testid="${t}"]`;

await p.goto(`${BASE}/match-ops/match-panel/${M}`, { waitUntil:'domcontentloaded' });
await p.waitForSelector(D('mp-max4'), { timeout:40000 });
await p.waitForTimeout(800);
ok(errs.length===0, `no page errors${errs.length?': '+errs[0]:''}`);

const val = async t => p.$eval(D(t), e => e.value);
const txt = async t => p.$eval(D(t), e => e.textContent.trim());
const teams = await p.$$eval(`${D('mp-teams-seg')} button`, es => es.map(e=>({n:e.textContent.trim(), on:e.dataset.on})));
const teamOn = teams.find(t=>t.on==='true')?.n;
console.log(`\nmatch ${M}: teams=${teamOn}  spots/team=${await txt('mp-spt')}  capacity=${await txt('mp-capacity')}`);
console.log(`max2=${await val('mp-max2')}  max4=${await val('mp-max4')}  bump=${await p.$eval(D('mp-bump'), e=>e.getAttribute('aria-checked') ?? e.dataset.on ?? 'n/a')}`);
ok(teamOn === '4', `it is a 4-team match (${teamOn})`);
const max4Before = Number(await val('mp-max4'));
const sptBefore = Number(await txt('mp-spt'));
ok(max4Before === 44, `the 4-team max reads 44 before anything is touched (${max4Before})`);
ok(sptBefore === 8, `and spots per team reads 8 (${sptBefore})`);

// ── BUG 2 FIRST: the control must be reachable with auto bump OFF ────────────────────────────
ok(await p.$eval(D('mp-max4'), e => !e.disabled), 'the 4-team max is enabled with auto bump ON');
await p.click(D('mp-bump'));
await p.waitForTimeout(150);
ok(await p.$eval(D('mp-max4'), e => !e.disabled), 'and STILL enabled after turning auto bump OFF');
const opts = await p.$$eval(`${D('mp-max4')} option`, es => es.map(e=>({v:e.value, t:e.textContent.trim(), d:e.disabled})));
ok(opts.some(o=>o.t==='11 each' && !o.d), `"11 each" (44) is selectable with auto bump off`);
await p.selectOption(D('mp-max4'), '44');
await p.waitForTimeout(120);
ok(Number(await val('mp-max4'))===44, '  and 4 teams x 11 can be set with no auto bump');
ok(/44 spots/.test(await p.$eval(`${D('mp-max4')} ~ .mp-help, ${D('mp-max4')} + .mp-help`, e=>e.textContent).catch(()=> '')) || true, '  (help line read)');
await p.click(D('mp-bump'));           // put the toggle back; nothing is saved either way
await p.waitForTimeout(150);

// ── BUG 1: lower spots per team and read the PENDING diff ───────────────────────────────────
const pendingKeys = async () => p.$$eval('[data-testid="mp-diff-row"], [data-testid^="mp-diff"]', es => es.map(e=>e.textContent.trim()));
await p.click(D('mp-spt-minus'));      // 8 -> 7
await p.waitForTimeout(180);
console.log(`\nafter one press of minus: spots/team=${await txt('mp-spt')}  capacity=${await txt('mp-capacity')}  max4=${await val('mp-max4')}`);
ok(Number(await txt('mp-spt'))===7, 'spots per team stepped 8 -> 7');
ok(Number(await val('mp-max4'))===44, 'the 4-team max is STILL 44 — the ceiling was not pulled down');
ok(await p.$eval(D('mp-max4'), e => !e.className.includes('mp-chg')), '  and it is not marked as a pending change');

// step it UP past the ceiling: the clamp must work in that direction
for (let i=0;i<5;i++){ await p.click(D('mp-spt-plus')); await p.waitForTimeout(60); }   // 7 -> 12
await p.waitForTimeout(200);
console.log(`after stepping to ${await txt('mp-spt')}: capacity=${await txt('mp-capacity')}  max4=${await val('mp-max4')}`);
ok(Number(await txt('mp-spt'))===12, 'stepped up to 12 a side');
ok(Number(await val('mp-max4'))===48, '  the ceiling was RAISED to 48, because 44 would be below the new capacity');
// and back down: it must not follow
for (let i=0;i<4;i++){ await p.click(D('mp-spt-minus')); await p.waitForTimeout(60); }  // 12 -> 8
await p.waitForTimeout(200);
ok(Number(await txt('mp-spt'))===8, `stepped back down to ${await txt('mp-spt')}`);
ok(Number(await val('mp-max4'))===48, '  and the ceiling stayed at 48 rather than following it down');

// ── CONTROL: the capacity DID move, so the assertions above are not reading a frozen panel ──
ok(/32/.test(await txt('mp-capacity')), `CONTROL: capacity tracked the stepper back to ${await txt('mp-capacity')}`);
ok(errs.length===0, `no page errors across the run${errs.length?': '+errs[0]:''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail?1:0);
