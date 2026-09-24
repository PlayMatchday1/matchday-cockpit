/* READ ONLY against the full editor for 18760. Stages in the browser; never presses Save. */
import { chromium } from 'playwright';
import { installHarnessGuard, storageStateFor } from './e2e/_session.mjs';
installHarnessGuard();
const BASE = process.env.BASE || 'http://localhost:3000';
const { storageState } = await storageStateFor('rmancuso@playmatchday.com', BASE);
const b = await chromium.launch();
const p = await (await b.newContext({ storageState, viewport:{width:1500,height:1200} })).newPage();
const errs=[]; p.on('pageerror', e=>errs.push(e.message));
let pass=0, fail=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); c?pass++:fail++;};
const D = t => `[data-testid="${t}"]`;
await p.goto(`${BASE}/match-ops/matches/18760`, { waitUntil:'domcontentloaded' });
await p.waitForSelector(D('sec-capacity-head'), { timeout:40000 });
// The Capacity section is folded by default; open it, and open Automation too for the toggle.
if (!await p.$(D('in-maxTeamSize4Team'))) { await p.click(D('sec-capacity-head')); await p.waitForTimeout(400); }
if (!await p.$(D('in-isAutoBump')))      { await p.click(D('sec-auto-head'));     await p.waitForTimeout(400); }
await p.waitForSelector(D('in-maxTeamSize4Team'), { timeout:20000 });
await p.waitForTimeout(400);
ok(errs.length===0, `no page errors${errs.length?': '+errs[0]:''}`);
const val = async t => p.$eval(D(t), e=>e.value);
const txt = async t => p.$eval(D(t), e=>e.textContent.trim());
console.log(`\neditor 18760: spots/team=${await txt('me-spt')}  capacity=${await txt('me-capacity')}  max4=${await val('in-maxTeamSize4Team')}  max2=${await val('in-maxTeamSize2Team')}`);
const bump = await p.$eval(D('in-isAutoBump'), e => e.getAttribute('aria-checked') ?? String(e.checked)).catch(()=>'n/a');
console.log(`auto bump: ${bump}`);
ok(await p.$eval(D('in-maxTeamSize4Team'), e=>!e.disabled), 'the 4-team rung is editable');
ok(Number(await val('in-maxTeamSize4Team'))===44, `and reads 44 (${await val('in-maxTeamSize4Team')})`);
ok(await txt('perside-maxTeamSize4Team') === '4 × 11 = 44 spots', `its hint reads "${await txt('perside-maxTeamSize4Team')}"`);

// turn auto bump OFF and confirm it stays editable
const toggle = await p.$(D('in-isAutoBump'));
if (toggle) { await toggle.click(); await p.waitForTimeout(200); }
ok(await p.$eval(D('in-maxTeamSize4Team'), e=>!e.disabled), 'and STILL editable with auto bump off');
if (toggle) { await toggle.click(); await p.waitForTimeout(200); }

/* DERIVE, DO NOT PIN. This pinned 18760 at 7 and 12 a side and went red the day the match grew
 * to 11. Everything below is computed from what the editor shows at rest. */
const spt0 = Number(await txt('me-spt'));
const rung0 = Number(await val('in-maxTeamSize4Team'));
ok(rung0 > 0, `CONTROL: the ceiling is a real number (${rung0}), so the checks below are not vacuous`);

// spots per team must not drag the rung down
await p.click(D('me-spt-minus'));
await p.waitForTimeout(250);
console.log(`after minus: spots/team=${await txt('me-spt')}  capacity=${await txt('me-capacity')}  max4=${await val('in-maxTeamSize4Team')}`);
ok(Number(await txt('me-spt'))===spt0-1, `spots per team stepped ${spt0} -> ${await txt('me-spt')}`);
ok(Number(await val('in-maxTeamSize4Team'))===rung0, `  and the 4-team max is still ${rung0}`);
const dirty = await p.$eval(`[data-f="maxTeamSize4Team"]`, e=>e.className);
ok(!/dirty/.test(dirty), `  and the field is not marked dirty (class "${dirty}")`);
const capDirty = await p.$eval(`[data-f="maxPlayerCount"]`, e=>e.className);
ok(/dirty/.test(capDirty), `  CONTROL: capacity IS marked dirty (class "${capDirty}"), so the dirty mark works`);

// the first per-team figure whose capacity clears the saved ceiling
const perOver = Math.floor(rung0 / 4) + 1;
for (let i = spt0 - 1; i < perOver; i++) { await p.click(D('me-spt-plus')); await p.waitForTimeout(70); }
await p.waitForTimeout(250);
const sptUp = Number(await txt('me-spt')), rungUp = Number(await val('in-maxTeamSize4Team'));
ok(sptUp === perOver, `stepped up to ${sptUp} a side, the first figure that clears ${rung0}`);
ok(rungUp === sptUp * 4, `  the ceiling was RAISED to ${rungUp}`);
ok(rungUp > rung0, `  CONTROL: and ${rungUp} really is above the old ${rung0}`);
ok(errs.length===0, `no page errors across the run${errs.length?': '+errs[0]:''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
