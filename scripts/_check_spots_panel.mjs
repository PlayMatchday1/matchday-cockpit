/* The Spots section of the match panel, driven. READ ONLY: it stages in the browser and reads the
 * pending state, and never presses Save, so nothing is written to the match.
 *
 *   node --env-file=.env.local scripts/_check_spots_panel.mjs            # localhost
 *   BASE=https://matchday-clubhouse.vercel.app  node --env-file=... ...  # the deployed build
 *
 * DERIVE, DO NOT PIN. The first version hardcoded 18760's spots per team as 8 and its ceiling as
 * 44, and reported four failures the day the match grew to 11 a side. Every expectation below is
 * computed from what the panel is showing when the run starts.
 */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();
const BASE = process.env.BASE || 'http://localhost:3000';
const M = process.env.MATCH || '18760';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport: { width: 1500, height: 1100 } })).newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); c ? pass++ : fail++; };
const D = (t) => `[data-testid="${t}"]`;

await p.goto(`${BASE}/match-ops/match-panel/${M}`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector(D('mp-max4'), { timeout: 40000 });
await p.waitForTimeout(900);
ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs[0] : ''}`);

const num = async (t) => Number(await p.$eval(D(t), (e) => e.textContent.trim()));
const rung4 = () => p.$eval(D('mp-max4'), (e) => Number(e.value));
const cap = () => p.$eval(D('mp-capacity'), (e) => Number(e.dataset.value));
const step = async (dir, times) => { for (let i = 0; i < times; i++) { await p.click(D(`mp-spt-${dir}`)); await p.waitForTimeout(70); } await p.waitForTimeout(200); };

const teams = await p.$$eval(`${D('mp-teams-seg')} button`, (es) => es.map((e) => ({ n: Number(e.textContent.trim()), on: e.dataset.on === 'true' })));
const teamCount = teams.find((t) => t.on)?.n ?? 0;
// EVERY EXPECTATION BELOW COMES FROM THESE THREE, read at rest.
const spt0 = await num('mp-spt'), cap0 = await cap(), rung0 = await rung4();
console.log(`\n${BASE}\nmatch ${M} at rest: teams=${teamCount} spots/team=${spt0} capacity=${cap0} max4=${rung0} max2=${await p.$eval(D('mp-max2'), (e) => Number(e.value))}`);

ok(teamCount === 4, `it is a 4-team match (${teamCount})`);
ok(cap0 === spt0 * teamCount, `capacity ${cap0} is ${teamCount} x ${spt0}, so the panel is internally consistent`);
ok(rung0 > 0, `CONTROL: the 4-team ceiling is a real number (${rung0}), not absent — the checks below would be vacuous on 0`);

// ── BUG 2. The ceiling must be reachable with auto bump OFF. ────────────────────────────────────
ok(await p.$eval(D('mp-max4'), (e) => !e.disabled), 'the 4-team max is editable with auto bump ON');
await p.click(D('mp-bump')); await p.waitForTimeout(200);
ok(await p.$eval(D('mp-max4'), (e) => !e.disabled), '  and STILL editable after turning auto bump OFF');
const opts = await p.$$eval(`${D('mp-max4')} option`, (es) => es.map((e) => ({ v: Number(e.value), t: e.textContent.trim(), d: e.disabled })));
const eleven = opts.find((o) => o.v === 11 * 4);
ok(!!eleven && !eleven.d, `  "${eleven?.t}" (44 spots) is selectable with no auto bump`);
await p.selectOption(D('mp-max4'), String(11 * 4)); await p.waitForTimeout(150);
ok(await rung4() === 44, '  and 4 teams x 11 can be set with no auto bump');
await p.selectOption(D('mp-max4'), String(rung0)); await p.waitForTimeout(150);
await p.click(D('mp-bump')); await p.waitForTimeout(200);   // toggle back; nothing is saved either way
ok(await rung4() === rung0, `  CONTROL: the ceiling is back to what it was (${rung0}), so what follows starts clean`);

// ── BUG 1. Lowering spots per team must not drag the ceiling down. ──────────────────────────────
await step('minus', 1);
const sptDown = await num('mp-spt');
console.log(`\nafter one minus: spots/team=${sptDown} capacity=${await cap()} max4=${await rung4()}`);
ok(sptDown === spt0 - 1, `spots per team stepped ${spt0} -> ${sptDown}`);
ok(await cap() === sptDown * teamCount, `  capacity followed it to ${await cap()}`);
ok(await rung4() === rung0, `  the ceiling is STILL ${rung0} — it was not pulled down`);
ok(await p.$eval(D('mp-max4'), (e) => !e.className.includes('mp-chg')), '  and it is not marked as a pending change');

// ── THE CLAMP IS UPWARD. Step past the ceiling and it must rise. ────────────────────────────────
// The target is derived: the first per-team figure whose capacity exceeds the saved ceiling.
const perOver = Math.floor(rung0 / teamCount) + 1;
await step('plus', perOver - sptDown);
const sptUp = await num('mp-spt'), capUp = await cap(), rungUp = await rung4();
console.log(`after stepping to ${sptUp}: capacity=${capUp} max4=${rungUp}`);
ok(sptUp === perOver, `stepped up to ${sptUp} a side, the first figure that clears the ${rung0} ceiling`);
ok(capUp > rung0, `  CONTROL: capacity ${capUp} really is above the old ceiling ${rung0}`);
ok(rungUp === capUp, `  the ceiling was RAISED to ${rungUp}, because ${rung0} would sit below the capacity`);
// THE SELECT MUST SAY WHAT IT HOLDS. SIZES stops at 12 a side, so a raised ceiling can be off-list;
// a select that cannot draw its value falls back to index 0 and reports a number nobody chose.
const shown = await p.$eval(D('mp-max4'), (e) => ({ v: Number(e.value), t: e.options[e.selectedIndex]?.textContent.trim() ?? '' }));
ok(shown.v === rungUp, `  and the control reads it back as ${shown.v} ("${shown.t}"), not a fallback`);

// ── AND IT DOES NOT FOLLOW THE STEPPER BACK DOWN. ──────────────────────────────────────────────
await step('minus', perOver - spt0);
ok(await num('mp-spt') === spt0, `stepped back down to ${await num('mp-spt')}`);
ok(await cap() === cap0, `  CONTROL: capacity tracked all the way back to ${await cap()}, so the panel is not frozen`);
ok(await rung4() === rungUp, `  and the ceiling stayed at ${rungUp} rather than following it down`);

ok(errs.length === 0, `no page errors across the run${errs.length ? ': ' + errs[0] : ''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail ? 1 : 0);
