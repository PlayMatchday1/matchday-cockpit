// MATCH PROMOTION ON A PHONE — measured, not eyeballed.
//
// WHAT THIS PINS. The desktop page is three city × weekday grids. At 390px a column is 48px, so the
// phone renders a different tree entirely. The failures that matter are the ones a screenshot at
// one width hides: a row that overflows by 3px at 360 but not 390, a tap target too small to hit,
// an input under 15px that makes iOS zoom the whole page on focus, and a seven-column grid that
// survived the port and quietly renders unreadable.
//
// EVERY GEOMETRY ASSERTION RUNS AT BOTH 390 AND 360.
//
//   node scripts/e2e/verify-match-promotion-mobile.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const URL_ = `${BASE}/match-ops/match-promotion`;
const WIDTHS = [390, 360];

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();

for (const width of WIDTHS) {
  console.log(`\n══════════ ${width}px ══════════`);
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  // PRESENCE FIRST — every geometry and absence assertion below is meaningless against a spinner.
  await page.waitForSelector('[data-testid="m-root"]', { timeout: 45000 });
  await page.waitForSelector('[data-testid="m-due-counts"]', { timeout: 45000 });
  ok("the phone tree rendered (not the desktop one)");
  eq("the DESKTOP tree is absent at this width", await page.locator('[data-testid="city-block"]').count(), 0);
  eq("no uncaught page errors", errors, []);

  // DUE IS THE LANDING TAB.
  eq("Due is the tab marked on at load", await page.locator('[data-testid="m-tab-due"]').getAttribute("data-on"), "1");
  eq("…and it is the only one marked", await page.locator('[data-testid="m-tabs"] [data-on="1"]').count(), 1);

  // NO HORIZONTAL SCROLL, on every tab.
  for (const tab of ["due", "week", "coverage"]) {
    await page.locator(`[data-testid="m-tab-${tab}"]`).click();
    await page.waitForTimeout(350);
    const m = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    }));
    eq(`  ${tab}: document.scrollWidth <= clientWidth`, m.sw <= m.cw, true);

    // NO ELEMENT'S BOX ESCAPES THE VIEWPORT. Measured on every rendered element, not a sample.
    const escapees = await page.evaluate((w) => {
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.right > w + 0.5 || r.left < -0.5) out.push(`${el.tagName}.${(el.className || "").toString().slice(0, 40)} [${Math.round(r.left)}→${Math.round(r.right)}]`);
      }
      return out.slice(0, 6);
    }, width);
    eq(`  ${tab}: no element escapes the viewport`, escapees, []);

    // NO SEVEN-COLUMN GRID WITH COLUMNS UNDER 44px. The coverage dots ARE a 7-col grid and are
    // allowed — they are 7 dots, not 7 columns of content — so the rule is applied to grids that
    // are NOT the dot strip.
    const narrow = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.display !== "grid") continue;
        const cols = cs.gridTemplateColumns.split(" ").filter(Boolean);
        if (cols.length < 7) continue;
        if (el.querySelector('[data-testid="m-dot"]')) continue; // the dot strip is 7 by design
        const min = Math.min(...cols.map((c) => parseFloat(c) || 0));
        if (min < 44) out.push(`${cols.length} cols, min ${Math.round(min)}px`);
      }
      return out;
    });
    eq(`  ${tab}: no content grid renders 7 columns under 44px`, narrow, []);
  }
  // CONTROL for those empty arrays: the same viewport scan DOES catch a deliberately widened box.
  const caught = await page.evaluate((w) => {
    const el = document.querySelector('[data-testid="m-root"]');
    const probe = document.createElement("div");
    probe.style.cssText = `position:absolute;left:${w + 40}px;top:0;width:50px;height:10px`;
    el.appendChild(probe);
    const r = probe.getBoundingClientRect();
    const hit = r.right > w + 0.5;
    probe.remove();
    return hit;
  }, width);
  eq("  CONTROL — the viewport scan catches a box placed outside it", caught, true);

  // TAP TARGETS. Every interactive control at least 30px tall.
  await page.locator('[data-testid="m-tab-week"]').click();
  await page.waitForSelector('[data-testid="m-row"]', { timeout: 20000 });
  await page.locator('[data-testid="m-row"]').first().click();
  await page.waitForSelector('[data-testid="m-panel"]', { timeout: 15000 });

  const small = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("button, input, select, textarea, label[data-testid^='m-ch-']")) {
      if (el.type === "checkbox" && el.classList.contains("sr-only")) continue; // the visually-hidden input; its label is the target
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 30) out.push(`${el.tagName}${el.dataset.testid ? "[" + el.dataset.testid + "]" : ""} ${Math.round(r.height)}px`);
    }
    return out;
  });
  eq("every button, switch, input and select is at least 30px tall", small, []);

  // INPUTS AT 15px+ — under that iOS zooms the page on focus.
  const tiny = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("input:not(.sr-only), select, textarea")) {
      const fs = parseFloat(getComputedStyle(el).fontSize);
      if (fs < 15) out.push(`${el.dataset.testid ?? el.tagName} ${fs}px`);
    }
    return out;
  });
  eq("every input is at least 15px font-size", tiny, []);
  // CONTROL: the scan is reading real font sizes, not defaulting.
  const sizes = await page.$$eval("input:not(.sr-only), textarea", (els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)));
  eq("  CONTROL — the font-size scan found inputs to measure", sizes.length > 0, true);

  // ALL SIX CHIPS INSIDE THEIR ROW.
  const chipEsc = await page.evaluate(() => {
    let escaped = 0, counts = [];
    for (const row of document.querySelectorAll('[data-testid="m-row"]')) {
      const rb = row.getBoundingClientRect();
      const chips = [...row.querySelectorAll('[data-testid="m-chip"]')];
      counts.push(chips.length);
      escaped += chips.filter((c) => { const b = c.getBoundingClientRect(); return b.right > rb.right + 0.5 || b.left < rb.left - 0.5; }).length;
    }
    return { escaped, distinct: [...new Set(counts)] };
  });
  eq("every week row renders all six channel chips", chipEsc.distinct, [6]);
  eq("…and none escapes its row", chipEsc.escaped, 0);

  // THE PANEL: in flow, one column, next to its row.
  const panel = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="m-panel"]');
    const row = document.querySelector('[data-testid="m-row"]');
    const cs = getComputedStyle(p);
    const cols = cs.gridTemplateColumns === "none" ? 1 : cs.gridTemplateColumns.split(" ").filter(Boolean).length;
    return {
      position: cs.position,
      columns: cols,
      gap: Math.round(p.getBoundingClientRect().top - row.getBoundingClientRect().bottom),
    };
  });
  eq("the panel is NOT position:fixed", panel.position === "fixed", false);
  eq("the panel is a single column", panel.columns, 1);
  eq("the panel opens within 30px of its row", panel.gap >= -1 && panel.gap < 30, true);
  console.log(`     measured gap: ${panel.gap}px`);

  // The city chip is not optional — the day header can no longer say where a match is.
  const cities = await page.$$eval('[data-testid="m-row"]', (rows) => rows.filter((r) => !r.querySelector('[data-testid="m-city"]')).length);
  eq("every week row carries its city chip", cities, 0);
  eq("  CONTROL — there are rows that could have been missing one", await page.locator('[data-testid="m-row"]').count() > 0, true);

  // CANCEL RANKING: no 1-of-4 on the phone. Wait for the derivation to land first — it rides
  // useMatchData, which is a large fetch, and asserting through it makes "no 1-of-4" pass on an
  // empty list.
  await page.waitForSelector('[data-testid="m-cancel-row"]', { timeout: 90000 });
  const ones = await page.$$eval('[data-testid="m-cancel-row"]', (els) => els.filter((e) => e.dataset.n === "1").length);
  eq("no 1-of-4 slot appears in the phone ranking", ones, 0);
  const rank = await page.$$eval('[data-testid="m-cancel-row"]', (els) => els.map((e) => Number(e.dataset.n)));
  eq("  CONTROL — the ranking rendered rows to filter", rank.length > 0, true);
  eq("…and it is ordered worst first", JSON.stringify(rank), JSON.stringify([...rank].sort((a, b) => b - a)));

  // COVERAGE: seven dots per city, three states only.
  await page.locator('[data-testid="m-tab-coverage"]').click();
  await page.waitForSelector('[data-testid="m-cov-card"]', { timeout: 15000 });
  const dots = await page.$$eval('[data-testid="m-cov-card"]', (cards) => ({
    perCard: [...new Set(cards.map((c) => c.querySelectorAll('[data-testid="m-dot"]').length))],
    states: [...new Set([...document.querySelectorAll('[data-testid="m-dot"]')].map((d) => d.dataset.st))].sort(),
  }));
  eq("every coverage card has exactly seven dots", dots.perCard, [7]);
  eq("…and the dots use only the three desktop states", dots.states.every((s) => ["p", "o", "n"].includes(s)), true);

  await page.setViewportSize({ width, height: 900 });
  await page.locator('[data-testid="m-tab-week"]').click();
  await page.waitForSelector('[data-testid="m-row"]');
  await page.screenshot({ path: `/tmp/mp-mobile-week-${width}.png`, fullPage: true });
  await page.locator('[data-testid="m-tab-due"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/tmp/mp-mobile-due-${width}.png`, fullPage: true });
  await page.locator('[data-testid="m-tab-coverage"]').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `/tmp/mp-mobile-cov-${width}.png`, fullPage: true });
  console.log(`  saved /tmp/mp-mobile-{week,due,cov}-${width}.png`);
  await closeContext(ctx);
}

// ── DESKTOP IS UNTOUCHED ──────────────────────────────────────────────────────────────────────
console.log("\n══════════ 1620px — desktop must be exactly as it was ══════════");
{
  const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
  const page = await ctx.newPage();
  await page.goto(URL_, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="strip-counts"]', { timeout: 45000 });
  // Same wait on the desktop side — the matrix renders only once the cancel data has arrived.
  await page.waitForSelector('[data-testid="cancel-patterns"]', { timeout: 90000 });
  eq("the desktop tree renders at 1620", await page.locator('[data-testid="city-block"]').count() > 0, true);
  // NO MOBILE-ONLY BLOCK IS RENDERED — by presence, since the phone tree is not in the DOM at all.
  eq("no phone-only block exists in the desktop DOM", await page.locator('[data-testid="m-root"]').count(), 0);
  eq("the desktop tabs are still Plan / Coverage only", await page.locator('[data-testid="view-tabs"] button').count(), 2);
  eq("the desktop cancel MATRIX still renders (not the phone ranking)",
     await page.locator('[data-testid="cancel-patterns"]').count(), 1);
  eq("…and the phone ranking is absent", await page.locator('[data-testid="m-cancel-row"]').count(), 0);
  await closeContext(ctx);
}

await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
