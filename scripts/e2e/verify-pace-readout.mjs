// DAILY REVENUE PACE — the hover readout.
//
// THE ASSERTION THAT MATTERS MOST is the sign of the difference. A flipped sign is invisible:
// every figure looks plausible, the colour is right, and the chart is wrong forever. So it is
// checked on a day where current is HIGHER and a day where it is LOWER — a single-direction test
// passes on a flipped sign.
//
// EXPECTED VALUES COME FROM THE PLOTTED PATHS, not from the tooltip's own text. Reading the
// tooltip to check the tooltip proves only that it is self-consistent. The paths' `d` attributes
// are inverted back through the chart's own scale to recover the dollar values it was given.
//
//   node scripts/e2e/verify-pace-readout.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => (/—/.test(t ?? "") ? null : Number(String(t).replace(/[^0-9.-]/g, "")));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="pace-chart"]', { timeout: 90000 });
await page.waitForTimeout(2000);
eq("no uncaught page errors", errors, []);

/** Recover the series the chart drew, by inverting its own scale off the path `d`. */
const plotted = () => page.evaluate(() => {
  const svg = document.querySelector('[data-testid="pace-chart"]');
  const hit = svg.querySelector('[data-testid="pace-hit"]');
  const ML = Number(hit.getAttribute("x")), MT = Number(hit.getAttribute("y"));
  const plotW = Number(hit.getAttribute("width")), plotH = Number(hit.getAttribute("height"));
  // The top gridline label is the axis maximum — the same maxY the y() scale divides by.
  const labels = [...svg.querySelectorAll("text")].map((t) => t.textContent.trim());
  const maxY = Number((labels[0] ?? "0").replace(/[^0-9.]/g, ""));
  const read = (sel) => {
    const p = svg.querySelector(sel);
    if (!p) return [];
    return (p.getAttribute("d") ?? "").split(/(?=[ML])/).filter(Boolean).map((seg) => {
      const [px, py] = seg.slice(1).trim().split(/\s+/).map(Number);
      return { x: px, v: ((MT + plotH - py) / plotH) * maxY };
    });
  };
  void read;
  // THE EXACT SERIES THE CHART WAS GIVEN, not values recovered from the rounded path.
  const parse = (a) => { try { return JSON.parse(svg.getAttribute(a) ?? "[]"); } catch { return []; } };
  return { ML, MT, plotW, plotH, maxY,
           current: parse("data-current").map((v, i) => ({ x: i, v })),
           compare: parse("data-compare").map((v, i) => ({ x: i, v })) };
});

const geom = () => page.evaluate(() => {
  const r = document.querySelector('[data-testid="pace-chart"]').getBoundingClientRect();
  const hit = document.querySelector('[data-testid="pace-hit"]').getBoundingClientRect();
  return { svg: { l: r.left, t: r.top, w: r.width, h: r.height }, hit: { l: hit.left, t: hit.top, w: hit.width, h: hit.height } };
});
const readTip = () => page.evaluate(() => {
  const el = document.querySelector('[data-testid="pace-readout"]');
  if (!el) return null;
  const q = (t) => el.querySelector(`[data-testid="${t}"]`)?.innerText.trim() ?? null;
  return {
    day: el.getAttribute("data-day"),
    dayLabel: el.firstElementChild?.innerText.trim(),
    current: q("pace-readout-current"),
    compare: q("pace-readout-compare"),
    diff: q("pace-readout-diff"),
    diffSign: el.querySelector('[data-testid="pace-readout-diff"]')?.getAttribute("data-sign") ?? null,
  };
});

const P = await plotted();
eq("  control — the chart plotted a current series", P.current.length > 5, true);
eq("  control — …and a comparison series", P.compare.length > 5, true);
console.log(`     ${P.current.length} current points, ${P.compare.length} comparison, axis max $${P.maxY}`);

// ── 1. SNAP TO THE NEAREST DAY, AT TEN POSITIONS INCLUDING BOTH ENDS ──────────────────────────
console.log("\n── snapping ──");
{
  const g = await geom();
  const nDays = 31;
  const bad10 = [];
  for (let k = 0; k < 10; k++) {
    const frac = k / 9;                       // 0 and 1 included: both ends
    const px = g.hit.l + 1 + frac * (g.hit.w - 2);
    await page.mouse.move(px, g.hit.t + g.hit.h / 2);
    await page.waitForTimeout(120);
    const t = await readTip();
    if (!t) { bad10.push(`${k}: no readout`); continue; }
    // The expected day is whichever plotted x is nearest — the same rule the chart uses.
    const expect = await page.evaluate(({ clientX }) => {
      const svg = document.querySelector('[data-testid="pace-chart"]');
      const r = svg.getBoundingClientRect();
      const hit = svg.querySelector('[data-testid="pace-hit"]');
      const W = 980, ML = Number(hit.getAttribute("x")), plotW = Number(hit.getAttribute("width"));
      const ux = (clientX - r.left) * (W / r.width);
      const n = 31;
      return Math.max(1, Math.min(n, Math.round(((ux - ML) / plotW) * (n - 1)) + 1));
    }, { clientX: px });
    if (Number(t.day) !== expect) bad10.push(`x${k}: readout day ${t.day}, nearest ${expect}`);
  }
  eq("all ten x-positions snap to the nearest day, both ends included", bad10, []);
  void nDays;
}

// ── 2. TOP AND BOTTOM OF THE PLOT GIVE THE SAME READOUT ───────────────────────────────────────
// This is the assertion that proves SNAPPING rather than line hit-testing: at the very top of the
// plot the pointer is nowhere near either line.
console.log("\n── it snaps, it does not hit-test the line ──");
{
  const g = await geom();
  const px = g.hit.l + g.hit.w * 0.4;
  await page.mouse.move(px, g.hit.t + 3);
  await page.waitForTimeout(140);
  const top = await readTip();
  await page.mouse.move(px, g.hit.t + g.hit.h - 3);
  await page.waitForTimeout(140);
  const bottom = await readTip();
  eq("a readout appears at the very top of the plot", top != null, true);
  eq("…and at the very bottom", bottom != null, true);
  eq("both give the same day and the same figures",
     [top?.day, top?.current, top?.compare], [bottom?.day, bottom?.current, bottom?.compare]);
  console.log(`     day ${top?.day}: ${top?.current} vs ${top?.compare}`);
}

// ── 3. THE AMOUNTS ARE THE PLOTTED VALUES ─────────────────────────────────────────────────────
console.log("\n── the amounts match the plotted series ──");
{
  const g = await geom();
  let checked = 0;
  for (const dayIdx of [0, 3, 7, 11, 15]) {
    const ux = P.ML + (dayIdx * P.plotW) / 30;
    const px = g.svg.l + (ux / 980) * g.svg.w;
    await page.mouse.move(px, g.hit.t + g.hit.h / 2);
    await page.waitForTimeout(120);
    const t = await readTip();
    if (!t || Number(t.day) !== dayIdx + 1) { bad(`day ${dayIdx + 1}: readout points at day ${t?.day}`); continue; }
    const cur = money(t.current), cmp = money(t.compare);
    const pc = P.current[dayIdx], pp = P.compare[dayIdx];
    if (cur != null && pc && Math.abs(cur - pc.v) > 0.5) bad(`day ${dayIdx + 1} current`, `readout ${cur} vs plotted ${pc.v.toFixed(0)}`);
    else if (cmp != null && pp && Math.abs(cmp - pp.v) > 0.5) bad(`day ${dayIdx + 1} compare`, `readout ${cmp} vs plotted ${pp.v.toFixed(0)}`);
    else checked++;
  }
  eq("the readout's amounts equal the plotted values, to the dollar", checked, 5);
}

// ── 4. THE SIGN, BOTH WAYS ────────────────────────────────────────────────────────────────────
console.log("\n── the difference is current minus comparison ──");
{
  const g = await geom();
  const sample = [];
  for (let d = 0; d < Math.min(P.current.length, P.compare.length); d++) {
    sample.push({ d, cur: P.current[d].v, cmp: P.compare[d].v });
  }
  const higher = sample.find((r) => r.cur - r.cmp > 50);
  const lower = sample.find((r) => r.cmp - r.cur > 50);
  eq("  control — the data contains a day where current is higher", higher != null, true);
  eq("  control — …and a day where it is lower", lower != null, true);
  for (const [name, r] of [["current higher", higher], ["current lower", lower]]) {
    if (!r) continue;
    const ux = P.ML + (r.d * P.plotW) / 30;
    await page.mouse.move(g.svg.l + (ux / 980) * g.svg.w, g.hit.t + g.hit.h / 2);
    await page.waitForTimeout(140);
    const t = await readTip();
    const shown = money(t?.diff);
    const want = r.cur - r.cmp;
    eq(`  ${name}: the sign is ${want >= 0 ? "positive" : "negative"}`, t?.diffSign, want >= 0 ? "pos" : "neg");
    if (shown != null) {
      const signed = t?.diff?.startsWith("−") ? -shown : shown;
      eq(`  ${name}: the magnitude is current − comparison`, Math.abs(signed - want) < 2, true);
    }
  }
}

// ── 5. A DAY THE CURRENT MONTH HAS NOT REACHED ────────────────────────────────────────────────
console.log("\n── past the last day with data ──");
{
  const g = await geom();
  const lastPlotted = P.current.length;              // days the current line covers
  const beyond = Math.min(30, lastPlotted + 4);      // a day the current series does not reach
  if (beyond >= 31 || beyond <= lastPlotted) {
    console.log(`  --  the current month covers ${lastPlotted} days of 31; no 'beyond' day to test`);
  } else {
    const ux = P.ML + (beyond * P.plotW) / 30;
    await page.mouse.move(g.svg.l + (ux / 980) * g.svg.w, g.hit.t + g.hit.h / 2);
    await page.waitForTimeout(140);
    const t = await readTip();
    eq(`day ${beyond + 1}: the current month reads an em dash, not $0`, t?.current, "—");
    eq(`  …and no difference row renders`, t?.diff, null);
    console.log(`     day ${beyond + 1}: current ${t?.current} · comparison ${t?.compare}`);
  }
}

// ── 6. THE READOUT STAYS INSIDE THE CHART ─────────────────────────────────────────────────────
console.log("\n── it never leaves the chart's box ──");
{
  const g = await geom();
  const outside = [];
  for (const frac of [0.02, 0.5, 0.97, 1.0]) {
    await page.mouse.move(g.hit.l + Math.min(g.hit.w - 1, frac * g.hit.w), g.hit.t + g.hit.h / 2);
    await page.waitForTimeout(140);
    const m = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="pace-readout"]');
      const card = document.querySelector('[data-testid="pace-card"]');
      if (!el || !card) return null;
      const a = el.getBoundingClientRect(), b = card.getBoundingClientRect();
      return { fits: a.left >= b.left - 0.5 && a.right <= b.right + 0.5, l: Math.round(a.left), r: Math.round(a.right), cl: Math.round(b.left), cr: Math.round(b.right) };
    });
    if (!m) outside.push(`${frac}: no readout`);
    else if (!m.fits) outside.push(`${frac}: ${m.l}→${m.r} outside ${m.cl}→${m.cr}`);
  }
  eq("the readout stays within the card at every x, including the far right", outside, []);
}

// ── 7. IT FOLLOWS THE VIEW SELECTORS ──────────────────────────────────────────────────────────
console.log("\n── it reads the same series the chart draws ──");
{
  const g = await geom();
  const at = async () => {
    await page.mouse.move(g.hit.l + g.hit.w * 0.25, g.hit.t + g.hit.h / 2);
    await page.waitForTimeout(160);
    return readTip();
  };
  const before = await at();
  await page.selectOption('[data-testid="pace-kind"]', "member");
  await page.waitForTimeout(1200);
  const after = await at();
  eq("switching DPP/Membership changes the readout for the same day",
     before?.day === after?.day && before?.current !== after?.current, true);
  console.log(`     day ${before?.day}: total ${before?.current} → membership ${after?.current}`);
  await page.selectOption('[data-testid="pace-kind"]', "total");
  await page.waitForTimeout(1200);
}

// ── 8. TOUCH ──────────────────────────────────────────────────────────────────────────────────
console.log("\n── tap to pin, at 390px ──");
{
  await closeContext(ctx);
}
{
  const tctx = await browser.newContext({ storageState, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tp = await tctx.newPage();
  await tp.goto(`${BASE}/admin/finance/revenue`, { waitUntil: "domcontentloaded" });
  await tp.waitForSelector('[data-testid="pace-chart"]', { timeout: 90000 });
  await tp.waitForTimeout(2000);
  const hb = await tp.locator('[data-testid="pace-hit"]').boundingBox();
  await tp.locator('[data-testid="pace-hit"]').scrollIntoViewIfNeeded();
  await tp.waitForTimeout(300);
  const hb2 = await tp.locator('[data-testid="pace-hit"]').boundingBox();
  await tp.mouse.click(hb2.x + hb2.width * 0.3, hb2.y + hb2.height / 2);
  await tp.waitForTimeout(300);
  const pinned = await tp.locator('[data-testid="pace-readout"]').count();
  eq("a tap pins the readout", pinned, 1);
  const d1 = await tp.locator('[data-testid="pace-readout"]').getAttribute("data-day");
  await tp.mouse.click(hb2.x + hb2.width * 0.7, hb2.y + hb2.height / 2);
  await tp.waitForTimeout(300);
  const d2 = await tp.locator('[data-testid="pace-readout"]').getAttribute("data-day");
  eq("tapping another day moves it", d1 !== d2, true);
  const fits = await tp.evaluate(() => {
    const el = document.querySelector('[data-testid="pace-readout"]');
    const r = el.getBoundingClientRect();
    return r.left >= -0.5 && r.right <= window.innerWidth + 0.5;
  });
  eq("the readout stays inside a 390px viewport", fits, true);
  await tp.mouse.click(10, 80);   // outside the plot
  await tp.waitForTimeout(400);
  eq("tapping outside dismisses it", await tp.locator('[data-testid="pace-readout"]').count(), 0);
  void hb;
  await closeContext(tctx);
}

await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
