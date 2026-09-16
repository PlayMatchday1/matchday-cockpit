import { chromium } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let pass=0,fail=0; const ok=(c,m)=>{console.log((c?'✓ ':'✗ ')+m); c?pass++:fail++;};
const p = await b.newPage({ viewport:{width:1200,height:1000} });
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const load = async (w=1200,h=1000) => { await p.setViewportSize({width:w,height:h});
  await p.goto('file:///home/claude/competitors.html'); await p.waitForTimeout(180); };
const set = async v => { await p.click(`.sw button[data-s="${v}"]`); await p.waitForTimeout(160); };
const D = t => `[data-testid="${t}"]`;
const T = t => p.$eval(D(t), e=>e.textContent.replace(/\s+/g,' ').trim());
const CITY = c => `[data-testid="city"][data-city="${c}"]`;
const HOU = CITY("Houston"), DFW = CITY("Dallas / Fort Worth");
const inCity = (city,t) => p.$eval(`${city} ${D(t)}`, e=>e.textContent.replace(/\s+/g,' ').trim());
const cell = (city,fac,t) => p.$eval(`${city} ${D("wrap")}[data-fac="${fac}"] ${D(t)}`,
  e=>e.textContent.replace(/\s+/g,' ').trim());

await load();
ok(errs.length===0, `no script errors${errs.length?': '+errs[0]:''}`);

// ══ 0. NOTHING IS OFF SCREEN ═════════════════════════════════════════════════
// THE BUG THIS SECTION EXISTS FOR. The first cut summed row[2] for the matches total and row[2]
// was the facility NAME, so 26 names concatenated into one cell 3,596px wide and shoved every
// numeric column out of view. 51 assertions passed on that page, because the only width assertion
// was `scrollWidth >= clientWidth`, which is true of every element ever laid out.
const overflow = async () => p.evaluate(() => {
  const bad = [];
  document.querySelectorAll('.city, .frow, .rhead, .stats, .share').forEach(e => {
    if (e.scrollWidth > e.clientWidth + 2) bad.push({ sel:e.className, sw:e.scrollWidth, cw:e.clientWidth });
  });
  return bad;
});
const o1 = await overflow();
ok(o1.length===0, `no row or panel overflows its own box${o1.length?': '+JSON.stringify(o1[0]):''}`);
ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=1202, 'and the page does not scroll sideways');
// CONTROL: the check can fail. Force a wide unbreakable string into one cell and re-measure.
await p.evaluate(() => {
  const n = document.querySelector('.frow .fname .n');
  n.style.whiteSpace = 'nowrap'; n.style.overflow = 'visible';
  n.textContent = 'x'.repeat(400);
});
await p.waitForTimeout(80);
ok((await overflow()).length>0, 'CONTROL: and it DOES catch a cell that is too wide');

// ══ 1. WE ARE IN THE TABLE ═══════════════════════════════════════════════════
// A market review you are absent from is a list, not a review.
await load();
const usRows = await p.$$eval(`${HOU} [data-src="us"]`, es=>es.map(e=>e.dataset.fac));
ok(usRows.length===4, `our own four Houston fields are rows in the same table: ${usRows.length}`);
ok(usRows.includes("ATH Pearland"), '  including ATH Pearland');
ok(await p.$eval(`${HOU} ${D("row")}[data-fac="ATH Pearland"]`, e=>e.className.includes("ours")),
  '  and our rows are visually distinct from theirs');
await set("goodrec");
ok(await p.$$eval(`${HOU} [data-src="us"]`, es=>es.length)===4,
  'CONTROL: filtering the competitor source never filters US out');
ok(await p.$$eval(`${HOU} [data-src="plei"]`, es=>es.length)===0, '  CONTROL: but it does filter them');

// ══ 2. FOUR NUMBERS THAT DESCRIBE THE MARKET, BEFORE ANY ROW ═════════════════
await load();
ok(await inCity(HOU,"s-fac")==="26", 'Houston: 26 competing facilities');
ok(await inCity(HOU,"s-spots")==="4,710", '  4,710 of their spots a week');
ok(/261.7 MD Standard/.test(await p.$eval(`${HOU} .stat:nth-child(2) .n`, e=>e.textContent)),
  '  which is 261.7 MD Standard');
const med = await inCity(HOU,"s-median");
ok(/^\$\d+\.\d\d$/.test(med), `  a median price per player (${med})`);
ok(Number(await inCity(HOU,"s-under"))>0, `  and how many of them undercut us (${await inCity(HOU,"s-under")})`);

// ══ 3. SPOTS READS AS A SHAPE, NOT A COLUMN OF DIGITS ════════════════════════
// "the page looks bland" — the fix is that size is visible before it is read.
const bars = await p.$$eval(`${HOU} .fill`, es=>es.map(e=>Math.round(e.getBoundingClientRect().width)));
ok(bars.length===30, `every row carries a spots bar (${bars.length} rows)`);
ok(Math.max(...bars) > Math.min(...bars)*5,
  `and the bars actually differ: ${Math.max(...bars)}px against ${Math.min(...bars)}px`);
ok(Math.min(...bars)>=2, '  CONTROL: the smallest is still drawn, not collapsed to nothing');
ok(await cell(HOU,"Revolution Soccer Complex","spots")==="662", 'the number is there too');
ok(await cell(HOU,"Revolution Soccer Complex","mdstd")==="36.8", '  and its MD Standard');
ok(await cell(HOU,"Houston Select FC","mdstd")==="0.6", 'CONTROL: 10 spots is 0.6, not rounded to zero');

// ══ 4. PRICE IS A NUMBER ═════════════════════════════════════════════════════
// The first cut drew each facility as a segment on a shared $6 to $16 axis with a marker at our
// own price. Ryan: "the price per player makes no sense $600. I dont know what its trying to
// capture." A column that needs a legend has failed. A number needs none.
ok(await cell(HOU,"GoPro Arena","price")==="$6.50 to $10.50 under us",
  'a range reads as the two numbers');
ok(await cell(HOU,"Houston Dynamo Sports Park","price")==="$13.50",
  'CONTROL: a single price is not written twice');
ok(await p.$(`${HOU} .prange`)===null, 'and there is no positional bar left anywhere');
ok(await p.$(`${HOU} .pmark`)===null, '  CONTROL: nor the marker that needed explaining');

// the one comparison worth keeping, said in words on the row rather than drawn
ok(await p.$(`${HOU} [data-fac="GoPro Arena"] ${D("under")}`)!==null,
  'a facility cheaper than our floor says so in words');
ok(await p.$(`${HOU} [data-fac="Houston Dynamo Sports Park"] ${D("under")}`)===null,
  '  CONTROL: a dearer one does not');
ok(await p.$(`${HOU} [data-fac="ATH Pearland"] ${D("under")}`)===null,
  '  CONTROL: and our own row never undercuts itself');

// price that was never published is absent, not zero
await set("goodrec");
ok(await p.$(`${DFW} [data-fac="FIT - Forney"] ${D("noprice")}`)!==null,
  'a facility that published no price says so');
ok(await cell(DFW,"FIT - Forney","noprice")==="not shown", '  in words, not as $0.00');

// ══ 4b. EXPAND INTO A FACILITY'S WEEK ════════════════════════════════════════
// Ryan: "we should be able to expand/minimize into each field and see their matches and size and
// price per day also."
await load();
const ROW = fac => `${HOU} [data-testid="row"][data-fac="${fac}"]`;
const DET = fac => `${HOU} [data-testid="detail"][data-fac="${fac}"]`;
ok(await p.$eval(ROW("Revolution Soccer Complex"), e=>e.getAttribute("aria-expanded"))==="false",
  'a facility starts closed');
ok(!await p.$eval(DET("Revolution Soccer Complex"), e=>e.checkVisibility?.() ?? false),
  '  CONTROL: and its week is not on screen');
await p.click(ROW("Revolution Soccer Complex")); await p.waitForTimeout(150);
ok(await p.$eval(ROW("Revolution Soccer Complex"), e=>e.getAttribute("aria-expanded"))==="true",
  'clicking it opens');
const days = await p.$$eval(`${DET("Revolution Soccer Complex")} [data-testid="day"]`, es=>es.map(e=>e.dataset.day));
ok(days.join(",")==="Mon,Tue,Wed,Thu,Fri,Sat,Sun", `seven days, in week order: ${days.join(" ")}`);
const matches = await p.$$eval(`${DET("Revolution Soccer Complex")} [data-testid="match"]`, es=>es.map(e=>e.textContent.replace(/\s+/g,' ').trim()));
ok(matches.length===19, `every match in the week is listed (${matches.length})`);
ok(/6:00 PM/.test(matches[0]) && /7v7/.test(matches[0]) && /14 spots/.test(matches[0]) && /\$12\.50/.test(matches[0]),
  `and each carries time, size, spots and price: "${matches[0]}"`);
const dsum = await p.$eval(`${DET("Revolution Soccer Complex")} [data-testid="daysum"]`, e=>e.textContent.replace(/\s+/g,' ').trim());
ok(/3 matches/.test(dsum) && /38 spots/.test(dsum), `each day totals itself: "${dsum}"`);

// a second facility opens without closing the first
await p.click(ROW("ATH Pearland")); await p.waitForTimeout(150);
ok(await p.$eval(ROW("ATH Pearland"), e=>e.getAttribute("aria-expanded"))==="true", 'a second opens');
ok(await p.$eval(ROW("Revolution Soccer Complex"), e=>e.getAttribute("aria-expanded"))==="true",
  '  CONTROL: and the first stays open');
await p.click(ROW("Revolution Soccer Complex")); await p.waitForTimeout(150);
ok(await p.$eval(ROW("Revolution Soccer Complex"), e=>e.getAttribute("aria-expanded"))==="false",
  'clicking again minimizes it');
ok(await p.$eval(ROW("ATH Pearland"), e=>e.getAttribute("aria-expanded"))==="true",
  '  CONTROL: without touching the other one');

// THE HONEST EMPTY STATE. The September capture is weekly totals only, so most facilities have no
// match log. An empty panel would read as "no matches".
await p.click(ROW("Pegaso HTX")); await p.waitForTimeout(150);
const nod = await p.$eval(`${DET("Pegaso HTX")} ${D("nodetail")}`, e=>e.textContent.replace(/\s+/g,' ').trim());
ok(/not captured for this facility/.test(nod), `a facility with no match log says so: "${nod.slice(0,44)}…"`);
ok(/weekly totals only/.test(nod), '  and says why, so it does not read as zero matches');

// ══ 5. FORMATS, AND FILTERING ON THEM ════════════════════════════════════════
await load();
const chips = await p.$$eval(`${HOU} [data-fac="Peek Sports Texas"] .fchip`, es=>es.map(e=>e.textContent.trim()));
ok(chips.join(",")==="7v7,8v8,10v10", `a multi-format facility shows each: ${chips.join(" ")}`);
ok(await p.$$eval(`${HOU} [data-fac="Pegaso HTX"] .fchip`, es=>es.length)===1,
  'CONTROL: and a single-format one shows one');

// THE BUBBLES ARE IN GAME ORDER, not alphabetical. "10v10" sorts before "5v5" as a string.
const fbtns = await p.$$eval(D("fbtn"), es=>es.map(e=>e.textContent.trim()));
ok(fbtns.join(",")==="5v5,6v6,7v7,8v8,9v9,10v10,11v11",
  `the format bubbles run smallest to largest: ${fbtns.join(" ")}`);

const nRows = async city => p.$$eval(`${city} [data-testid="row"]`, es=>es.length);
const before = await nRows(HOU);
await p.click(`${D("fbtn")}[data-fmt="11v11"]`); await p.waitForTimeout(160);
const after = await nRows(HOU);
ok(after < before, `picking 11v11 narrows Houston from ${before} facilities to ${after}`);
const facs = await p.$$eval(`${HOU} [data-testid="row"]`, es=>es.map(e=>e.dataset.fac));
ok(facs.includes("Athlete Training & Health | Cypress"), '  and the 11v11 facilities are the ones left');
ok(!facs.includes("Pegaso HTX"), '  CONTROL: a 6v6-only facility is gone');

// MULTI-SELECT, because the real question is usually two formats, not one.
await p.click(`${D("fbtn")}[data-fmt="7v7"]`); await p.waitForTimeout(160);
const both = await p.$$eval(`${HOU} [data-testid="row"]`, es=>es.map(e=>e.dataset.fac));
ok(both.length > after, `adding 7v7 widens it again to ${both.length}`);
ok(both.includes("Athlete Training & Health | Cypress") && both.includes("Turf On Soccer Fields"),
  '  CONTROL: and both formats are represented, so it is OR and not AND');

/* THE FILTER NARROWS THE LIST AND NOTHING ELSE. The capture holds spots per FACILITY, not per
 * format, so a total or a share recomputed under a format filter would be a number the data
 * cannot support. */
ok(await inCity(HOU,"s-spots")==="4,710", 'the city totals do NOT move with the format filter');
ok(/16%/.test(await inCity(HOU,"sharepct")), '  nor does the share');
const note = await T("fnote");
ok(/still cover every format/.test(note), `and the page says so out loud: "${note.slice(0,52)}…"`);
ok(/spots per facility, not per format/.test(note), '  naming the reason');

await p.click(D("fclear")); await p.waitForTimeout(160);
ok(await nRows(HOU)===before, 'Clear puts every facility back');
ok(await p.$(D("fnote")).then(async e => !(await e.isVisible())), '  CONTROL: and the caveat goes with it');

// ══ 6. ABSENCE IS NOT EVIDENCE ═══════════════════════════════════════════════
const cov = await T("coverage");
ok(/2 of 8 MatchDay cities/.test(cov), 'coverage is stated before any table');
ok(/Austin/.test(cov) && /El Paso/.test(cov), '  every uncaptured city named');
ok(/has not been looked at/.test(cov), '  saying what an empty city means');

// ══ 7. THE WINDOW TRAVELS WITH THE NUMBERS ═══════════════════════════════════
const w = await inCity(DFW,"window");
ok(/Plei/.test(w) && /GoodRec/.test(w), `both windows named on the city: "${w}"`);
ok(/Mon 21 plus/.test(w), '  including the one that is not a clean 7 days');
await set("plei");
ok(!/GoodRec/.test(await inCity(DFW,"window")), 'CONTROL: filtering shows only that source\'s window');

// ══ 8. THE SHARE, AND WHERE IT REFUSES TO BE A PERCENTAGE ════════════════════
// MD share = our MD Standard / (ours + theirs). Ours is spots/18 too, so a two-pitch match counts 2.
//
// A PERCENTAGE IS ONLY PRINTED WHERE THE WINDOWS ACTUALLY ALIGN. Ryan: "A number with a footnote
// gets screenshotted without the footnote and ends up in a deck, and this feeds raise prep."
// Houston aligns (both sides Tue 15 to Mon 21). DFW does not: Plei is eight days of listings and
// GoodRec is a different week again. The bar and both absolutes still render either way.
await set("plei");
// 864/18 = 48.0 ours against 4710/18 = 261.7 theirs. 48/309.7 = 15.50%, which rounds to 16.
ok(/16%/.test(await inCity(HOU,"sharepct")), `Houston aligns, so it gets a number: 864 against 4,710 is 16%`);
await set("both");
ok(await p.$(`${DFW} ${D("sharepct")}`)===null, 'DFW does NOT get a percentage, because its windows do not line up');
const nos = await inCity(DFW,"nosharepct");
ok(/do not line up/.test(nos), `  it says so instead: "${nos}"`);
const why = await inCity(DFW,"sharewhy");
ok(/Plei is Mon 21 plus/.test(why), `  and names which window is wrong: "${why.slice(0,54)}…"`);
ok(/GoodRec/.test(why), '  including the second source');
// CONTROL: the ABSOLUTES are still there, because a listing count is true whatever the window.
ok(await p.$(`${DFW} ${D("seg-goodrec")}`)!==null, 'GoodRec is its own segment, never merged into Plei');
ok(await p.$(`${DFW} ${D("seg-us")}`)!==null, '  CONTROL: and our own side is still drawn');
// CONTROL: the rule is decided by COMPARISON, not by city, and the sharpest proof is that the two
// sources in ONE city answer differently. Plei alone still refuses, because its window_note says
// eight days of listings. GoodRec alone covers a clean seven days and ours is measured over the
// same seven, so it DOES get a percentage. Nothing here knows which city it is looking at.
await set("plei");
ok(await p.$(`${DFW} ${D("sharepct")}`)===null, 'CONTROL: Plei alone in DFW still refuses, on its window note');
await set("goodrec");
ok(await p.$(`${DFW} ${D("sharepct")}`)!==null, '  CONTROL: but GoodRec alone DOES get one, so it is not hardcoded per city');
await set("both");

// ══ 9. THEY BOOK OUR FIELDS ══════════════════════════════════════════════════
ok(await p.$(`${HOU} [data-fac="Katy International Sports Complex"] ${D("ours")}`)!==null,
  'Plei selling KISC is flagged');
ok(await p.$(`${HOU} [data-fac="Pac Global Academy | West Houston"] ${D("ours")}`)!==null, '  so is PAC Global');
ok(await p.$(`${HOU} [data-fac="Athlete Training and Health | Katy"] ${D("ours")}`)!==null, '  and ATH Katy');
ok(await p.$(`${HOU} [data-fac="Athlete Training & Health | Cypress"] ${D("ours")}`)===null,
  'CONTROL: Cypress is NOT Katy and is not flagged');
ok(await p.$(`${HOU} [data-fac="ATH Katy"] ${D("ours")}`)===null,
  'CONTROL: our OWN row does not claim to also be our field');
await set("goodrec");
ok(await p.$(`${DFW} [data-fac="Crossbar, Rowlett"] ${D("ours")}`)!==null,
  'and it works across sources: GoodRec sells Crossbar Rowlett');

// ══ 10. SIZES ════════════════════════════════════════════════════════════════
for (const w of [390, 1200]){
  await load(w);
  for (const s of ['both','plei','goodrec']){
    await set(s);
    ok(await p.evaluate(()=>document.documentElement.scrollWidth)<=w+2, `${w}px ${s}: no horizontal scroll`);
    const bad = await overflow();
    ok(bad.length===0, `  ${w}px ${s}: nothing overflows its own box`);
  }
  await set('both');
  const btn = await p.$$eval('.sw button', es=>Math.min(...es.map(e=>e.getBoundingClientRect().height)));
  ok(btn>=32, `  the source control is ${Math.round(btn)}px`);
  const names = await p.$$eval(`${HOU} .fname .n`, es=>es.map(e=>Math.round(e.getBoundingClientRect().width)));
  ok(names.length>25, `  (${names.length} facility names to measure)`);
  ok(Math.min(...names)>=120, `  every facility name keeps ${Math.round(Math.min(...names))}px`);
  // NON-VACUITY, the same trap as before: Math.min over [] is Infinity and passes every >= test.
  // The price axis this used to measure no longer exists; measuring it would have "passed" forever.
  const px = await p.$$eval(`${HOU} ${D("price")}`, es=>es.map(e=>Math.round(e.getBoundingClientRect().width)));
  ok(px.length>25, `  (${px.length} price cells to measure)`);
  ok(Math.min(...px)>=90, `  every price cell is ${Math.round(Math.min(...px))}px, wide enough for a range`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); process.exit(fail?1:0);
