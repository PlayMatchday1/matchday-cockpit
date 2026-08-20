// THE "NOT MATCHED TO A VENUE" POPOVER, on the Revenue page.
//
// It replaced a block of month sentences above the table. The caveat is about ONE column —
// revenue matched to a venue — so it now lives on that column's header and nowhere else.
//
// WHAT THIS PINS, and why each one is here rather than left to a screenshot:
//   · the popover is PORTALLED out of the table's overflow-x container. Anchored inside it, it
//     would be clipped by that scroller or drift away from the ⓘ when the table scrolls sideways —
//     and Member mix is already off-screen, so the table really does scroll.
//   · opening it changes NO layout. A header that grows or a column that widens on open is a
//     table that moves under the reader.
//   · click works, not hover only. Hover-only is unreachable on a phone and from a keyboard.
//   · the ⓘ does not sort. These headers carry no sort handler today; the assertion is what keeps
//     that true if one is added.
//
//   node scripts/e2e/verify-revenue-notmatched.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const URL_ = `${BASE}/admin/finance/revenue`;
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForSelector('[data-testid="revenue-group-row"]', { timeout: 90000 });
await page.waitForTimeout(1500);
eq("no uncaught page errors", errors, []);
const rowCount = await page.locator('[data-testid="revenue-group-row"]').count();
eq("  control — the table rendered rows to reason about", rowCount > 2, true);

// ── 1. THE SENTENCES ARE GONE ─────────────────────────────────────────────────────────────────
console.log("\n── the month sentences are gone ──");
{
  const body = await page.evaluate(() => document.body.innerText);
  eq("  control — the scan read a real page", body.length > 1200, true);
  eq("  control — it finds text that IS present ('Revenue matched to a venue')",
     /revenue matched to a venue/i.test(body), true);
  eq("no 'is not matched to a venue —' sentence survives", /is not matched to a venue/i.test(body), false);
  eq("no '% of gross' sentence survives", /% of gross/i.test(body), false);
  eq("the old gap element is gone", await page.locator('[data-testid="revenue-gap"]').count(), 0);
  eq("…and so are its lines", await page.locator('[data-testid="gap-line"]').count(), 0);
  const planted = await page.evaluate(() => {
    const d = document.createElement("div"); d.textContent = "is not matched to a venue —";
    document.body.appendChild(d);
    const hit = /is not matched to a venue/i.test(document.body.innerText);
    d.remove(); return hit;
  });
  eq("  control — a planted sentence IS caught", planted, true);
}

// ── 2. CLOSED ON LOAD, AND ABSENT FROM THE TREE ───────────────────────────────────────────────
console.log("\n── closed on load ──");
const info = page.locator('[data-testid="notmatched-info"]');
eq("the ⓘ exists", await info.count(), 1);
eq("the panel is not in the DOM at all, not merely hidden", await page.locator('[data-testid="notmatched-panel"]').count(), 0);
eq("…and the trigger reports collapsed", await info.getAttribute("aria-expanded"), "false");
eq("it carries an aria-label", (await info.getAttribute("aria-label") ?? "").length > 5, true);
eq("it is a real button", await info.evaluate((e) => e.tagName), "BUTTON");
{
  const box = await info.boundingBox();
  eq("the hit area is at least 24×24 even though the glyph is 14px",
     box.width >= 24 && box.height >= 24, true);
  console.log(`     hit area ${Math.round(box.width)}×${Math.round(box.height)}`);
}

// ── 3. LAYOUT IS UNCHANGED BY OPENING ─────────────────────────────────────────────────────────
console.log("\n── opening it moves nothing ──");
const metrics = () => page.evaluate(() => {
  const th = [...document.querySelectorAll('[data-testid="revenue-group-table"] thead th')]
    .find((t) => /revenue matched to a venue/i.test(t.innerText));
  const row = th?.closest("tr");
  return {
    headerHeight: Math.round(row?.getBoundingClientRect().height ?? 0),
    colWidth: Math.round(th?.getBoundingClientRect().width ?? 0),
  };
});
const before = await metrics();
await info.click();
await page.waitForSelector('[data-testid="notmatched-panel"]', { timeout: 8000 });
const after = await metrics();
eq("the header row height is identical open and closed", after.headerHeight, before.headerHeight);
eq("the column width is identical open and closed", after.colWidth, before.colWidth);
console.log(`     header ${before.headerHeight}px · column ${before.colWidth}px`);

// ── 4. THE FIGURES ────────────────────────────────────────────────────────────────────────────
console.log("\n── the four figures ──");
{
  const rows = await page.locator('[data-testid="notmatched-row"]').evaluateAll((els) =>
    els.map((e) => {
      const td = e.querySelectorAll("td");
      return { month: td[0]?.innerText.trim(), amount: td[1]?.innerText.trim(), pct: td[2]?.innerText.trim() };
    }));
  eq("the panel lists a row per month with a gap", rows.length > 0, true);
  console.log("     " + rows.map((r) => `${r.month} ${r.amount} ${r.pct}`).join(" · "));
  eq("every amount is a dollar figure", rows.every((r) => /^\$[\d,]+$/.test(r.amount)), true);
  eq("every percentage is one decimal", rows.every((r) => /^\d+\.\d%$/.test(r.pct)), true);
  eq("the heading is exactly the specified text",
     (await page.locator('[data-testid="notmatched-panel"]').innerText()).split("\n")[0].trim(),
     "Not matched to a venue");
}

// ── 5. IT DOES NOT SORT ───────────────────────────────────────────────────────────────────────
console.log("\n── the ⓘ does not re-sort the table ──");
{
  const first = () => page.locator('[data-testid="revenue-group-row"]').first().getAttribute("data-label");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const a = await first();
  await info.click(); await page.waitForTimeout(400);
  const b = await first();
  await info.click(); await page.waitForTimeout(400);
  const c = await first();
  eq("the first row is unchanged by opening and closing it", [b, c], [a, a]);
  eq("  control — there IS a first row to have been reordered", a != null, true);
}

// ── 6. OPEN / CLOSE BEHAVIOUR ─────────────────────────────────────────────────────────────────
console.log("\n── click, click again, Escape, outside click ──");
const isOpen = () => page.locator('[data-testid="notmatched-panel"]').count().then((n) => n > 0);
await info.click(); await page.waitForTimeout(350);
eq("click opens it", await isOpen(), true);
await info.click(); await page.waitForTimeout(350);
eq("clicking again closes it", await isOpen(), false);
await info.click(); await page.waitForTimeout(350);
await page.keyboard.press("Escape"); await page.waitForTimeout(350);
eq("Escape closes it", await isOpen(), false);
await info.click(); await page.waitForTimeout(350);
// A BLIND COORDINATE CLICK IS NOT AN "OUTSIDE CLICK" — (20,400) landed on a page control and
// navigated away, taking the table with it. Dispatch the event the handler actually listens for,
// on the body, where nothing can be hit by accident.
await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
await page.waitForTimeout(350);
eq("an outside click closes it", await isOpen(), false);

// ── 7. IT SURVIVES A SIDEWAYS SCROLL, UNCLIPPED ───────────────────────────────────────────────
console.log("\n── the table scrolls sideways and the panel keeps up ──");
{
  // Reset the table's horizontal scroll and bring the trigger into view before clicking — a
  // previous assertion left the pointer elsewhere and the header can sit outside the scrollport.
  await page.evaluate(() => {
    const t = document.querySelector('[data-testid="revenue-group-table"]');
    if (t?.parentElement) t.parentElement.scrollLeft = 0;
  });
  await info.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await info.click();
  await page.waitForSelector('[data-testid="notmatched-panel"]');
  const scrolled = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="revenue-group-table"]');
    const wrap = t?.parentElement;
    if (!wrap) return 0;
    wrap.scrollLeft = wrap.scrollWidth;   // all the way right — Member mix is off-screen
    return wrap.scrollLeft;
  });
  eq("  control — the table really does scroll horizontally", scrolled > 0, true);
  await page.waitForTimeout(500);
  const geo = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="notmatched-panel"]').getBoundingClientRect();
    const b = document.querySelector('[data-testid="notmatched-info"]').getBoundingClientRect();
    return {
      inViewport: p.left >= -0.5 && p.right <= window.innerWidth + 0.5 && p.top >= -0.5,
      dx: Math.round(Math.abs(p.left - b.left)),
      dy: Math.round(p.top - b.bottom),
      stillOpen: true,
    };
  });
  eq("the panel is still fully inside the viewport after scrolling", geo.inViewport, true);
  eq("…and still adjacent to its trigger", geo.dy >= 0 && geo.dy < 40, true);
  console.log(`     offset from trigger after scroll: ${geo.dx}px across, ${geo.dy}px below`);
  await page.keyboard.press("Escape");
}

// ── 8. AT 390px ───────────────────────────────────────────────────────────────────────────────
console.log("\n── 390px ──");
{
  // The previous section left the table scrolled fully right. Reset it — otherwise the trigger
  // sits outside the scrollport at 390px and this measures the consequence of that, not the
  // popover's own placement.
  await page.evaluate(() => {
    const t = document.querySelector('[data-testid="revenue-group-table"]');
    if (t?.parentElement) t.parentElement.scrollLeft = 0;
    window.scrollTo(0, 0);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1500);
  const i2 = page.locator('[data-testid="notmatched-info"]');
  if (await i2.count() === 0) {
    console.log("  --  the group table is not rendered at 390px; popover not applicable");
  } else {
    await i2.scrollIntoViewIfNeeded();
    await i2.click();
    await page.waitForSelector('[data-testid="notmatched-panel"]', { timeout: 8000 });
    const openW = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="notmatched-panel"]').getBoundingClientRect();
      return {
        inViewport: p.left >= -0.5 && p.right <= window.innerWidth + 0.5,
        scrollWidth: document.documentElement.scrollWidth,
        left: Math.round(p.left), right: Math.round(p.right),
      };
    });
    eq("the panel is fully within a 390px viewport", openW.inViewport, true);
    console.log(`     panel ${openW.left}→${openW.right} in a 390px viewport`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    const closedW = await page.evaluate(() => document.documentElement.scrollWidth);
    // THE PAGE ALREADY SCROLLS SIDEWAYS AT 390px, WITH THE PANEL SHUT — the Revenue control row
    // (.ctrlStack / .ctrlGroup / .seg) runs to 591px. That is a pre-existing defect of this page
    // and is reported, not fixed here. What this asserts is that the popover ADDS nothing to it.
    eq("the popover adds nothing to the page's horizontal extent", openW.scrollWidth, closedW);
    console.log(`     page scrollWidth ${closedW}px at 390px viewport — pre-existing, panel shut`);
  }
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
