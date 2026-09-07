// THE ROSTER PANEL DOES NOT PAN SIDEWAYS ON A PHONE.
//   node scripts/e2e/verify-roster-mobile.mjs      (needs `npm run dev` up)
//
// WHY THIS EXISTS AND WHY THE OLD CHECK MISSED IT. The previous mobile verification measured
// `document.documentElement.scrollWidth` against `clientWidth`. `.mp-body` is a scroll container,
// so it absorbs any overflow inside it: the document stayed exactly 390 and reported nothing while
// the panel panned. The instrument has to be the CONTAINER, not the document.
//
// WHAT IT CAUGHT. `.mp-movepick` is a child of `.mp-player`, so under the mobile grid it is a grid
// ITEM — and it had no grid-area, so it was auto-placed into a column track. With the picker open
// the name and phone tracks collapsed to 0px at every width, and at 360px and below `.mp-pacts`
// was pushed past the panel's right edge and the panel panned.
//
// MEASURED WITH THE PICKER BOTH CLOSED AND OPEN, because closed it fits and the bug is invisible.
import { chromium } from "playwright";
import { storageStateFor, closeBrowser, nonEmpty } from "./_session.mjs";
const BASE = process.env.BASE || "http://localhost:3000";
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const yes = (n, c, d = "") => (c ? ok(n) : bad(n, d));

/* Widest descendant of .mp-body against its OWN client width — the measurement the document-level
 * one could never make. Returns the worst offender by how far it reaches past the right edge. */
const measure = (p) => p.evaluate(() => {
  const body = document.querySelector(".mp-body");
  if (!body) return null;
  const bl = body.getBoundingClientRect().left, bw = body.clientWidth;
  let worst = null, n = 0;
  for (const el of body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    n++;
    const over = r.right - (bl + bw);
    if (over > 0.5 && (!worst || over > worst.over)) {
      worst = { cls: (el.className || el.tagName).toString().split(" ")[0],
        testid: el.getAttribute("data-testid"), width: Math.round(r.width), over: Math.round(over) };
    }
  }
  return { clientWidth: bw, scrollWidth: body.scrollWidth, pans: body.scrollWidth > bw + 0.5,
    worst, descendants: n, overflowX: getComputedStyle(body).overflowX,
    nameWidth: Math.round(document.querySelector(".mp-pname")?.getBoundingClientRect().width ?? -1) };
});

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
  const b = await chromium.launch();
  const ID = process.env.ID || "18564";
  /* 390 is the brief's width; 360 is where the bug actually surfaced, and a phone that narrow is
   * ordinary. Checking only the wider one is how this survived the last build. */
  for (const w of [390, 360]) {
    const ctx = await b.newContext({ viewport: { width: w, height: 800 }, storageState, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/match-ops/match-panel/${ID}`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('[data-testid="mp-player"]', { timeout: 240000 });
    await p.waitForFunction(() => !document.body.innerText.includes("Loading teams…"), { timeout: 120000 });
    const rows = nonEmpty(await p.$$('[data-testid="mp-player"]'), `roster rows at ${w}px`);
    yes(`${w}px: the roster rendered ${rows.length} rows to measure`, rows.length > 0);

    const closed = await measure(p);
    is(`${w}px, picker closed: nothing reaches past .mp-body`, closed.worst, null);
    is(`${w}px, picker closed: .mp-body does not pan`, closed.pans, false);

    /* OPEN IT. Closed, the row fits and the bug is invisible — which is the whole reason the
     * previous check passed while the panel panned. */
    const um = await p.$eval('[data-testid="mp-player"]', (e) => e.getAttribute("data-um"));
    await p.click(`[data-testid="mp-move-${um}"]`);
    await p.waitForSelector('[data-testid="mp-movepick"]', { timeout: 20000 });
    await p.waitForTimeout(250);
    const open = await measure(p);
    is(`${w}px, picker OPEN: nothing reaches past .mp-body`, open.worst, null);
    is(`${w}px, picker OPEN: .mp-body does not pan`, open.pans, false);
    /* THE PICKER IS A ROW, NOT A COLUMN. If it is ever auto-placed again, the name is the track it
     * steals from — so the name keeping its width is the same bug seen from the other side. */
    yes(`${w}px, picker OPEN: the player's name still has width (${open.nameWidth}px)`, open.nameWidth > 20, String(open.nameWidth));
    const span = await p.$eval('[data-testid="mp-movepick"]', (e) => getComputedStyle(e).gridColumnStart);
    yes(`${w}px: the picker spans the row rather than sitting in a track (grid-column-start ${span})`, span === "1");

    // second step: the spot list, which is the widest thing the picker ever shows
    const teams = await p.$$('[data-testid^="mp-movepick-team-"]');
    if (teams[0]) {
      await teams[0].click();
      await p.waitForSelector('[data-testid^="mp-movepick-spot-"]', { timeout: 20000 });
      await p.waitForTimeout(250);
      const spots = await p.$$('[data-testid^="mp-movepick-spot-"]');
      const step = await measure(p);
      is(`${w}px, spot step (${spots.length} spots): nothing reaches past .mp-body`, step.worst, null);
      is(`${w}px, spot step: .mp-body does not pan`, step.pans, false);
      yes(`${w}px, spot step: the name still has width (${step.nameWidth}px)`, step.nameWidth > 20, String(step.nameWidth));
    }

    /* THE GUARD, asserted separately from the fix it backs up. */
    is(`${w}px: .mp-body clips sideways rather than scrolling`, closed.overflowX, "hidden");

    /* THE CONTROL. The measurement must be able to SEE an overflow — otherwise every zero above is
     * just a selector that matches nothing. Widen one row past the box and confirm it is found. */
    await p.evaluate(() => { const r = document.querySelector('[data-testid="mp-player"]');
      r.dataset.probe = "1"; r.style.width = "900px"; });
    const probed = await measure(p);
    yes(`${w}px: CONTROL — a deliberately 900px row IS detected (${probed.worst?.cls} +${probed.worst?.over}px)`, probed.worst != null);
    await p.evaluate(() => { const r = document.querySelector('[data-testid="mp-player"][data-probe="1"]'); r.style.width = ""; });
    await ctx.close();
  }
  await closeBrowser(b);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
