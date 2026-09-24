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

// spots per team must not drag the rung down
await p.click(D('me-spt-minus'));
await p.waitForTimeout(250);
console.log(`after minus: spots/team=${await txt('me-spt')}  capacity=${await txt('me-capacity')}  max4=${await val('in-maxTeamSize4Team')}`);
ok(Number(await txt('me-spt'))===7, 'spots per team stepped down');
ok(Number(await val('in-maxTeamSize4Team'))===44, '  and the 4-team max is still 44');
const dirty = await p.$eval(`[data-f="maxTeamSize4Team"]`, e=>e.className);
ok(!/dirty/.test(dirty), `  and the field is not marked dirty (class "${dirty}")`);
const capDirty = await p.$eval(`[data-f="maxPlayerCount"]`, e=>e.className);
ok(/dirty/.test(capDirty), `  CONTROL: capacity IS marked dirty (class "${capDirty}"), so the dirty mark works`);
for (let i=0;i<5;i++){ await p.click(D('me-spt-plus')); await p.waitForTimeout(70); }
await p.waitForTimeout(200);
ok(Number(await txt('me-spt'))===12 && Number(await val('in-maxTeamSize4Team'))===48,
  `stepping to ${await txt('me-spt')} raised the ceiling to ${await val('in-maxTeamSize4Team')}`);
ok(errs.length===0, `no page errors across the run${errs.length?': '+errs[0]:''}`);
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
