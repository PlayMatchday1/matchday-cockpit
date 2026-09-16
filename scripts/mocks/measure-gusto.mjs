import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1100,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1100,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/gusto-mapping.html'); await p.waitForTimeout(170); };
const set = async (k,v) => { await p.click(`.sw button[data-${k}="${v}"]`); await p.waitForTimeout(150); };
const D = t => `[data-testid="${t}"]`;
const T = t => p.$eval(D(t), e=>e.textContent.replace(/\s+/g,' ').trim());
const has = async t => (await p.$(D(t))) !== null;
const vis = async t => { const e = await p.$(D(t)); return e ? await e.isVisible() : false; };
const dis = t => p.$eval(D(t), e=>e.disabled);
const fill = async (t,v) => { await p.fill(D(t), v); await p.waitForTimeout(140); };

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. TODAY: A CORRECT REFUSAL WITH NO DOOR BESIDE IT ═══════════════════════
// The only AliasEditor in the app renders inside MgrDetail, which renders for a row already on
// the sheet. She cannot get onto the sheet without a mapping, and cannot get a mapping without
// being on the sheet.
ok(await vis('blocked'), 'today the dialog refuses her');
ok(/cannot be saved/.test(await T('blocked')), '  and is right to: a row with no mapping does not pay');
ok(!await has('m-first'), 'and there is NOTHING on this screen to fix it with');
ok(!await has('m-save'), '  no control at all, which is the whole bug');
ok(await dis('save'), 'CONTROL: Add to the sheet is disabled, so the dead end is real');
ok(await dis('amount') && await dis('reason'),
  '  CONTROL: and the fields below it are dead too, so there is nowhere to go');

// ══ 2. THE FIX IS OFFERED WHERE THE BLOCK HAPPENS ════════════════════════════
await set('s','after');
ok(await vis('mapform'), 'the block becomes a form');
ok(/does not pay/.test(await T('mapform')), '  keeping the reason, because the reason is true');
ok(await has('m-first') && await has('m-last') && await has('m-email'),
  'first name, last name and an optional Gusto email');
ok(await dis('m-save'), 'save is off until both names are there');
await fill('m-first','Chrystal');
ok(await dis('m-save'), '  CONTROL: one name alone is not enough');
await fill('m-last','Morales');
ok(!await dis('m-save'), 'and on once both are');

// THE WARNING THAT CANNOT BE DROPPED. Clubhouse cannot verify a Gusto worker exists.
const hint = await T('m-hint');
ok(/exactly/.test(hint), 'the copy says the name must match Gusto exactly');
ok(/cannot check it/.test(hint), '  and admits Clubhouse cannot verify it');
ok(/already exist as a worker in Gusto/.test(hint), '  and that she must already be in Gusto');

// ══ 3. SAVING CLEARS THE BLOCK AND NOTHING ELSE ══════════════════════════════
await p.click(D('m-save')); await p.waitForTimeout(160);
ok(await vis('mapped'), 'saving the mapping clears the block');
ok(!await has('mapform'), '  and the form goes');
ok(await vis('tag-gusto'), 'the person row now carries the Gusto name');
ok(/Gusto: Chrystal Morales/.test(await T('tag-gusto')), `  "${await T('tag-gusto')}"`);
ok(!await vis('tag-nogusto'), '  CONTROL: and stops saying it has none');

// A MAPPING IS NOT A BYPASS. Every other guard on this dialog still applies.
ok(!await dis('amount') && !await dis('reason'), 'the fields below come alive');
ok(await dis('save'), 'CONTROL: but Add to the sheet is STILL off, because there is no amount');
await fill('amount','40');
ok(await dis('save'), '  CONTROL: and still off with an amount and no reason');
await fill('reason','Covered Tuesday at NEMP');
ok(!await dis('save'), 'and on only once the amount AND the reason are both there');

// ══ 4. THE DUPLICATE GUSTO WORKER, WHICH THE INDEX ALREADY REFUSES ═══════════
// unique (lower(gusto_first_name), lower(gusto_last_name)). The route returns 409; the dialog
// has to show it rather than swallow it.
await load(); await set('s','after'); await set('g','taken');
await fill('m-first','Chrystal'); await fill('m-last','Morales');
await p.click(D('m-save')); await p.waitForTimeout(160);
ok(await vis('m-err'), 'a Gusto name another manager already holds is refused');
ok(/cannot share a Gusto worker/.test(await T('m-err')), `  and says why: "${await T('m-err')}"`);
ok(!await has('mapped'), '  CONTROL: nothing was saved');
ok(await vis('tag-nogusto'), '  CONTROL: and she still has no mapping');
ok(await dis('save'), '  CONTROL: so the row still cannot be added');
ok(await vis('mapform'), '  with the form still there to correct');

// ══ 5. THE HIDDEN PEOPLE STOP BEING A DEAD FACT ══════════════════════════════
// 11 of 100 on the rosters carry a mapping. The other 89 are behind this line.
await load();
const before = await T('hiddenline');
ok(/no Gusto mapping, hidden/.test(before), `today the line just states it: "${before}"`);
ok(!await has('showall'), '  CONTROL: with nothing to click');
await set('s','after');
ok(await has('showall'), 'after, it is something to act on');
ok(/can be set up here/.test(await T('showall')), `  "${await T('showall')}"`);

// ══ 6. SIZES ═════════════════════════════════════════════════════════════════
for (const w of [390, 1100]){
  await load(w);
  for (const s of ['before','after']){
    await set('s',s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
  }
  await set('s','after');
  const fields = await p.$$eval('.fld', es=>es.map(e=>e.getBoundingClientRect().height));
  ok(fields.length>=5, `  (${fields.length} fields on screen to measure)`);
  ok(Math.min(...fields)>=32, `  every field is ${Math.round(Math.min(...fields))}px`);
  const btns = await p.$$eval('.btn', es=>es.map(e=>e.getBoundingClientRect().height));
  ok(btns.length>=3, `  (${btns.length} buttons to measure)`);
  ok(Math.min(...btns)>=32, `  every button is ${Math.round(Math.min(...btns))}px`);
  // nothing in the dialog may spill out of it
  const over = await p.evaluate(() => {
    const m = document.querySelector('.modal').getBoundingClientRect();
    return [...document.querySelectorAll('.modal *')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && (r.right > m.right + 1 || r.left < m.left - 1);
    }).length;
  });
  ok(over===0, '  nothing spills out of the dialog');
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
