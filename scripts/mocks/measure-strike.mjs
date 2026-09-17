import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
/* RESOLVE THE BROWSER, DO NOT PIN IT. An absolute path baked in here is a path on whichever machine
 * wrote the script, and it fails on every other one. Order: an explicit override, then the sandbox
 * build if it happens to be present, then whatever Playwright has installed locally. */
const CANDIDATES = [process.env.PW_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'];
const executablePath = CANDIDATES.find(p => p && existsSync(p));
const b = await chromium.launch(executablePath ? { executablePath } : {});
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:900} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=900) => { await p.setViewportSize({width:w,height:h});
  await p.goto(new URL('./remove-strike.html', import.meta.url).href); await p.waitForTimeout(170); };
const D = t => `[data-testid="${t}"]`;
const T = t => p.$eval(D(t), e=>e.textContent.replace(/\s+/g,' ').trim());
const has = async t => (await p.$(D(t))) !== null;
const scen = async s => { await p.click(`.sw button[data-s="${s}"]`); await p.waitForTimeout(150); };
const rows  = () => p.$$eval('[data-testid="row"]', es=>es.map(e=>e.dataset.id));
const row   = id => `[data-testid="row"][data-id="${id}"]`;
const rmBtn = id => `${D("rm")}[data-id="${id}"]`;
const dis   = id => p.$eval(rmBtn(id), e=>e.disabled);
const rmTxt = id => p.$eval(rmBtn(id), e=>e.textContent.replace(/\s+/g,' ').trim());
const open  = async id => { await p.click(rmBtn(id)); await p.waitForTimeout(160); };
const type  = async v => { await p.fill(D("d-reason"), v); await p.waitForTimeout(120); };
const go    = async r => { await type(r); await p.click(D("d-go")); await p.waitForTimeout(170); };
const pips  = () => p.$$eval('.pip.on, .pip.trip', es=>es.length);

// the seed by hand, so the script does not read its expectations out of the page it is checking
const LATE = 90412, LATECX = 90388, NOSHOW = 90301, PLAIN = 90277;   // pts 1, 1, 2, 1

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 1. THE TOTAL IS A SUM OF POINTS FROM THE SERVER, NOT A COUNT OF ROWS ════
// activeStrikes is MatchDay's number and a single strike can weigh 2. Four rows under "2 of 4"
// is correct, and anything that counts rows renders 4 of 4 and suspends a member who is not.
ok((await rows()).length===4, 'four strike rows are on screen');
ok(await T("hdr-pts")==="2 of 4", `and the header says "${await T("hdr-pts")}", not 4 of 4`);
ok(await T("s-pts")==="2 of 4 strike points", '  the strikebar agrees');
ok(await pips()===2, '  and 2 of the 4 pips are filled');
ok(await p.$$eval('.pip', es=>es.length)===4, '  CONTROL: there are 4 pips, so 2 is not "all of them"');
ok(/2 to go/.test(await T("strikebar")), '  and the "to go" line is computed from the same number');
const pc = await p.evaluate(() => [getComputedStyle(document.querySelector('.pip.on')).backgroundColor,
  getComputedStyle(document.querySelector('.pip:not(.on):not(.trip)')).backgroundColor]);
ok(pc[0]!==pc[1], `  CONTROL: on and off pips differ (${pc[0]} vs ${pc[1]})`);

// ══ 2. A STRIKE CAN WEIGH 2, AND THE BUTTON SAYS THE NUMBER ════════════════
// Retool's own labelling, and the reason for it: "remove this strike" reads as one point, and a
// NO SHOW is two. The number belongs on the control the operator is about to press.
ok(await rmTxt(NOSHOW)==="Expired 2", `the 2-point strike's control says its weight: "${await rmTxt(NOSHOW)}"`);
ok(await rmTxt(LATE)==="Remove 1", `  CONTROL: a 1-pointer says 1: "${await rmTxt(LATE)}"`);
ok(await rmTxt(PLAIN)==="Expired 1", '  and an expired 1-pointer says Expired 1');
ok(await p.$eval(`${row(NOSHOW)} ${D("kind")}`, e=>e.textContent.trim())==="NO SHOW",
  'the 2-pointer carries its reason label from userStatus');
const l2 = await p.$eval(`${row(NOSHOW)} .l2`, e=>e.textContent.replace(/\s+/g,' ').trim());
ok(/×2/.test(l2), `  and the row line still marks it too: "${l2}"`);
const l2one = await p.$eval(`${row(LATE)} .l2`, e=>e.textContent.replace(/\s+/g,' ').trim());
ok(!/×/.test(l2one), '  CONTROL: a 1-point strike is NOT marked, so ×2 means something');
ok(/Cancelled 3h before kickoff/.test(await p.$eval(`${row(LATECX)} .l2`, e=>e.textContent)),
  'a late cancel shows how late it was');
ok(/Reason not recorded/.test(await p.$eval(`${row(PLAIN)} .l2`, e=>e.textContent)),
  '  CONTROL: and a log with no known userStatus invents no reason');

// ══ 3. EVERY ROW ADDRESSES ONE STRIKE, BY ITS OWN ID ════════════════════════
// This is the whole reason the feature does not exist yet: playerProfile.ts drops l.id when it
// maps the logs, and the panel keys its rows by array index.
const ids = await rows();
ok(ids.every(id => /^\d+$/.test(id)), `each row carries a numeric strike id: ${ids.join(', ')}`);
ok(new Set(ids).size===4, '  CONTROL: the four ids are distinct, so a Remove cannot hit the wrong log');
const btnIds = await p.$$eval(D("rm"), es=>es.map(e=>e.dataset.id));
ok(btnIds.join()===ids.join(), 'every row has a Remove carrying that row\'s id');

// ══ 4. AN EXPIRED STRIKE CANNOT BE REMOVED ══════════════════════════════════
// Retool's own enable condition: penaltyPoint > 0 AND strike.expiredAt in the future.
ok(await p.$eval(`${row(NOSHOW)} ${D("state")}`, e=>e.textContent.trim())==="EXPIRED", 'the NO SHOW is expired');
ok(await dis(NOSHOW), '  and its control is disabled');
ok(await dis(PLAIN), '  so is the other expired one');
ok(!await dis(LATE) && !await dis(LATECX), 'CONTROL: the two ACTIVE strikes ARE removable');
ok((await rmTxt(LATE)).startsWith("Remove") && (await rmTxt(NOSHOW)).startsWith("Expired"),
  '  and the word on the control is the state, so it reads without the tag beside it');
await p.$eval(rmBtn(NOSHOW), e=>e.click());
await p.waitForTimeout(120);
ok(!await has("scrim"), 'CONTROL: clicking a disabled Remove opens nothing');

// ══ 5. REMOVE OPENS A CONFIRM. IT DOES NOT REMOVE. ══════════════════════════
await open(LATE);
ok(await has("scrim"), 'Remove opens a confirm');
ok((await rows()).length===4, '  CONTROL: the row is still there');
ok(await T("hdr-pts")==="2 of 4", '  CONTROL: and the total has not moved');
const what = await T("d-what");
ok(/LATE/.test(what), `the confirm names the kind: "${what}"`);
ok(/Soccer Central Field 4/.test(what), '  the match');
ok(/Sep 15, 2026, 9:00 PM/.test(what), '  when');
ok(/Arrived after kickoff/.test(what), '  why it was issued');
ok(new RegExp(`strike ${LATE}`).test(what), '  and the strike id, which is what the API is given');

// ══ 6. THE REASON IS REQUIRED, AND WHITESPACE IS NOT A REASON ═══════════════
ok(await p.$eval(D("d-go"), e=>e.disabled), 'Remove strike starts disabled');
await type("   ");
ok(await p.$eval(D("d-go"), e=>e.disabled), '  CONTROL: three spaces do not enable it');
await type("Issued in error, we cancelled the match");
ok(!await p.$eval(D("d-go"), e=>e.disabled), '  a real reason enables it');
ok(/change log/.test(await T("d-hint")) && /your name/.test(await T("d-hint")),
  'and the field says where the reason goes and that it is attributed');

// ══ 7. KEEP IT WRITES NOTHING ═══════════════════════════════════════════════
await p.click(D("d-cancel")); await p.waitForTimeout(150);
ok(!await has("scrim"), 'Keep it closes the confirm');
ok((await rows()).length===4 && (await rows()).includes(String(LATE)), '  CONTROL: all four rows survive');
ok(await T("hdr-pts")==="2 of 4", '  CONTROL: and the total is untouched');

// ══ 8. A 1-POINT REMOVAL MOVES THE TOTAL BY 1 ═══════════════════════════════
await open(LATE);
ok(await T("d-effect")==="Removes 1 strike point. They go to 1 of 4.",
  `the confirm names the weight and the landing: "${await T("d-effect")}"`);
ok(!await has("d-lifts") && !await has("d-held"), '  CONTROL: and claims nothing about a suspension');
await go("Issued in error, we cancelled the match");
const after = await rows();
ok(!await has("scrim"), 'confirming closes the dialog');
ok(after.length===3 && !after.includes(String(LATE)), 'the row that was named is gone');
ok(after.includes(String(LATECX)) && after.includes(String(NOSHOW)) && after.includes(String(PLAIN)),
  '  CONTROL: the other three are untouched');
ok(await T("hdr-pts")==="1 of 4", `and the total drops by that strike's own point: "${await T("hdr-pts")}"`);
ok(await pips()===1, '  the pips follow');
ok(/3 to go/.test(await T("strikebar")), '  and so does the "to go" line');

// ══ 9. A 2-POINT REMOVAL MOVES IT BY 2 ══════════════════════════════════════
// The sharpest test that the number is a point sum: same click, different amount.
await load(); await scen("susp");
ok(await T("hdr-pts")==="4 of 4", 'the suspended member is at 4 of 4');
ok(await has("strike-suspended"), '  and the suspension banner is up');
ok(await pips()===4, '  every pip is filled');
ok(!await dis(NOSHOW), '  CONTROL: here the 2-pointer is inside the window, so it IS removable');
ok(await rmTxt(NOSHOW)==="Remove 2", `  and its control now reads "${await rmTxt(NOSHOW)}"`);
await open(NOSHOW);
ok(/Removes 2 strike points/.test(await T("d-lifts")),
  `the confirm says TWO points come off: "${await T("d-lifts")}"`);
ok(/2 of 4/.test(await T("d-lifts")), '  and that they land on 2 of 4, not 3');
ok(/suspension lifts/.test(await T("d-lifts")), '  and that the suspension lifts');
await go("Marked absent but he played, manager error");
ok(await T("hdr-pts")==="2 of 4", 'after it lands they are at 2 of 4, down TWO');
ok(!await has("strike-suspended"), '  CONTROL: and the suspension banner is gone');
ok(await pips()===2, '  two pips');
ok((await rows()).length===3, '  and three rows, so rows and points moved by different amounts');

// ══ 10. OVER THE THRESHOLD: REMOVING ONE DOES NOT LIFT ANYTHING ═════════════
// Five points against a limit of four. A removal that lands back ON the threshold still leaves
// them suspended, and a confirm that promised a lift would be a lie an operator acts on.
await load(); await scen("over");
ok(await T("hdr-pts")==="5 of 4", 'the over-threshold member is at 5 of 4');
ok(await has("pip-over"), '  with an over pip');
ok(await T("pip-over")==="+1", `  reading "${await T("pip-over")}"`);
ok(/1 OVER the threshold/.test(await T("strikebar")), '  and the strikebar says so');
ok(await pips()===4, '  CONTROL: only 4 pips can fill, which is why the over pip exists');
await open(LATE);
ok(await has("d-held"), 'removing 1 of the 5 does NOT claim to lift the suspension');
ok(!await has("d-lifts"), '  CONTROL: the lift line is absent');
ok(/Removes 1 strike point\./.test(await T("d-held")), `  it still names the weight: "${await T("d-held")}"`);
ok(/4 of 4/.test(await T("d-held")), '  says where they land');
ok(/stay suspended/.test(await T("d-held")), '  and that they stay suspended');
const heldBg = await p.$eval(D("d-held"), e=>getComputedStyle(e).backgroundColor);
await go("Logged twice for the same match");
ok(await T("hdr-pts")==="4 of 4", 'after it lands they are at 4 of 4');
ok(await has("strike-suspended"), '  CONTROL: and STILL suspended, as the confirm said');
ok(!await has("pip-over"), '  the over pip is gone');

// the same scenario, the 2-pointer instead, DOES lift: the control that proves d-held is conditional
await load(); await scen("over");
await open(NOSHOW);
ok(await has("d-lifts"), 'CONTROL: in the SAME state, removing the 2-pointer does promise a lift');
const liftBg = await p.$eval(D("d-lifts"), e=>getComputedStyle(e).backgroundColor);
ok(liftBg!==heldBg, `  and the two read differently (${liftBg} vs ${heldBg})`);
await go("Marked absent but he played, manager error");
ok(await T("hdr-pts")==="3 of 4", '  it lands at 3 of 4');
ok(!await has("strike-suspended"), '  and the banner is gone');

// ══ 11. THE EXPLANATORY FOOTER IS GONE ══════════════════════════════════════
await load();
ok(!await has("pfoot"), 'the footer paragraph is gone');
const body = await p.$eval('.panel', e=>e.textContent.replace(/\s+/g,' '));
ok(!/Read-only here/.test(body), '  CONTROL: including the sentence this change made false');
ok(!/see docs/.test(body) && !/suspends the membership for a week/.test(body),
  '  and the rest of the explanation with it');
ok(/suspends a member for a week/.test(await T("strikebar")),
  'CONTROL: the strikebar still carries the one fact that was load-bearing');

// ══ 12. SIZES ═══════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['two','susp','over']){
    await scen(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
    const bad = await p.evaluate(() => [...document.querySelectorAll('.panel, .row.srow, .strikebar, .banner, .dlg, .what')]
      .filter(e => e.scrollWidth > e.clientWidth + 2).length);
    ok(bad===0, `  ${w}px ${s}: nothing overflows its own box`);
    const names = await p.$$eval('.stitle .l1', es=>es.map(e=>Math.round(e.getBoundingClientRect().width)));
    ok(names.length===4 && Math.min(...names)>=110,
      `  ${w}px ${s}: the match name has ${Math.min(...names)}px to read in (${names.length} rows)`);
  }
  await scen('two');
  const btns = await p.$$eval('.sw button, .rm', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(btns.length>=7, `  ${w}px: (${btns.length} controls to measure)`);
  ok(Math.min(...btns)>=32, `  ${w}px: every control is ${Math.min(...btns)}px`);
  await open(LATE);
  const dlg = await p.$eval('.dlg', e=>Math.round(e.getBoundingClientRect().width));
  ok(dlg<=w-24, `  ${w}px: the confirm fits the screen (${dlg}px)`);
  const fld = await p.$eval(D("d-reason"), e=>e.getBoundingClientRect());
  ok(Math.round(fld.height)>=36 && Math.round(fld.width)>=220,
    `  ${w}px: the reason field is ${Math.round(fld.width)}×${Math.round(fld.height)}px`);
  const dbt = await p.$$eval('.dbtns .btn', es=>es.map(e=>Math.round(e.getBoundingClientRect().height)));
  ok(dbt.length===2 && Math.min(...dbt)>=32, `  ${w}px: its two buttons are ${Math.min(...dbt)}px`);
  const bg = await p.evaluate(() => ({
    go: getComputedStyle(document.querySelector('[data-testid="d-go"]')).backgroundColor,
    keep: getComputedStyle(document.querySelector('[data-testid="d-cancel"]')).backgroundColor,
    rm: getComputedStyle(document.querySelector('[data-testid="rm"]')).backgroundColor }));
  ok(bg.rm==="rgb(255, 255, 255)", `  ${w}px: CONTROL: the in-row Remove is quiet, not a solid invitation`);
  ok(bg.go!==bg.keep && bg.go!=="rgb(255, 255, 255)", `  ${w}px: only the confirm button is solid`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
