// THE EXPENSE FORECAST CARD IS GONE, and stays gone.
//
// Removing a card is easy to do badly: the element goes but its wrapper stays, leaving a doubled
// gap; or the strings survive in a heading nobody re-read. This asserts the absence AND that the
// page closed up, with a control proving the scan can see what is still there.
//
//   node scripts/e2e/verify-cashflow-no-forecast.mjs
import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
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

await page.goto(`${BASE}/admin/finance/cash-flow`, { waitUntil: "domcontentloaded" });
// PRESENCE FIRST — an absence scan against a spinner passes for the wrong reason.
await page.waitForSelector("h2, h3, table", { timeout: 90000 });
await page.waitForTimeout(3500);
eq("no uncaught page errors", errors, []);

console.log("\n── the strings are gone ──");
{
  const body = await page.evaluate(() => document.body.innerText);
  eq("  control — the scan read a loaded page", body.length > 800, true);
  // …and it can see a heading that IS still on this page.
  const stillHere = await page.evaluate(() => {
    const t = document.body.innerText;
    return ["cash flow", "insights", "trend"].filter((w) => new RegExp(w, "i").test(t));
  });
  eq("  control — it finds headings that ARE present", stillHere.length > 0, true);
  console.log(`     still present: ${stillHere.join(", ")}`);

  for (const gone of ["Expense forecast", "Top-level expenses", "Adjust manual entries as actuals roll in",
                      "Compare planned expenses across months"]) {
    eq(`"${gone}" appears nowhere`, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(body), false);
  }
  // "TOTAL EXPENSES" SURVIVES, AND SHOULD. The forecast card's footer row is gone with the card,
  // but the Monthly P&L table has its own Total Expenses row — a different card that has always
  // had one. Asserting the bare string against the whole page would have demanded that row be
  // renamed to satisfy a check about a card it has nothing to do with.
  {
    const outside = await page.evaluate(() => {
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (!/total expenses/i.test(n.textContent ?? "")) continue;
        if (n.parentElement?.closest("table")) continue;   // the P&L row
        out.push(n.textContent.trim().slice(0, 40));
      }
      return out;
    });
    eq('"Total expenses" survives only inside the P&L table, nowhere else', outside, []);
    const inTable = await page.evaluate(() => [...document.querySelectorAll("table td")]
      .filter((t) => /total expenses/i.test(t.innerText)).length);
    eq("  control — the P&L's own Total Expenses row IS still there", inTable > 0, true);
  }
  const planted = await page.evaluate(() => {
    const d = document.createElement("div"); d.textContent = "Expense forecast";
    document.body.appendChild(d);
    const hit = /expense forecast/i.test(document.body.innerText);
    d.remove(); return hit;
  });
  eq("  control — a planted 'Expense forecast' IS caught", planted, true);
}

console.log("\n── the page closed up ──");
{
  const m = await page.evaluate(() => {
    // The lens nav should now be the first thing in the content flow, with no empty box above it.
    // THE LENS NAV IS A <nav>. Searching for a div containing "cash flow" with three buttons
    // matched a page-sized ancestor, so the "element above" was the whole layout.
    const nav = document.querySelector('nav[aria-label="Cash flow lens"]');
    if (!nav) return null;
    const before = nav.previousElementSibling;
    return {
      hasSiblingAbove: !!before,
      emptyBoxAbove: before ? before.getBoundingClientRect().height : 0,
      navTop: Math.round(nav.getBoundingClientRect().top),
    };
  });
  // THERE IS LEGITIMATELY A CARD ABOVE THE NAV — the looking-ahead hero (Q3 net P&L, gross
  // revenue, pacing), which is a sibling and was never part of this removal. Asserting "nothing
  // above the nav" would have demanded that card's deletion too. What must be true is that
  // whatever sits there is NOT the forecast: no forecast heading, no month-pair toggle.
  const above = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Cash flow lens"]');
    const prev = nav?.previousElementSibling;
    return prev ? { text: prev.innerText.replace(/\s+/g, " ").trim(), h: Math.round(prev.getBoundingClientRect().height) } : null;
  });
  eq("  control — there IS an element above the nav to inspect", above != null, true);
  eq("the element above the nav is not the forecast card",
     /expense forecast|top-level expenses|planned expenses/i.test(above?.text ?? ""), false);
  eq("  …it is the looking-ahead hero, still rendering", /net p&l|gross revenue/i.test(above?.text ?? ""), true);
  console.log(`     above the nav: ${above?.h}px — "${(above?.text ?? "").slice(0, 46)}…"`);
  if (m) console.log(`     lens nav top ${m.navTop}px · element above: ${m.hasSiblingAbove ? m.emptyBoxAbove + "px" : "none"}`);

  // NO DOUBLED GAP. The lens nav is `sticky top-0`, so its viewport rect is pinned and useless
  // for spacing maths — these read DOCUMENT positions (offsetTop) and the nav's own declared
  // margin, which is what actually sets the distance to the card below it.
  const spacing = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Cash flow lens"]');
    if (!nav) return null;
    const prev = nav.previousElementSibling;
    const next = nav.nextElementSibling;
    const cs = getComputedStyle(nav);
    return {
      marginBottom: Math.round(parseFloat(cs.marginBottom)),
      // Distance from whatever sits above the nav to the nav itself, in the document.
      gapAbove: prev ? Math.round(nav.offsetTop - (prev.offsetTop + prev.offsetHeight)) : null,
      nextTag: next?.tagName ?? null,
    };
  });
  eq("  control — the lens nav was found and measured", spacing != null, true);
  eq("the nav keeps the page's own bottom spacing (mb-8 = 32px)", spacing?.marginBottom, 32);
  // Where the card was, there is now nothing: no residual margin stacking above the nav.
  eq("no doubled gap above the nav where the card used to be",
     spacing?.gapAbove == null || spacing.gapAbove <= 32, true);
  console.log(`     nav margin-bottom ${spacing?.marginBottom}px · gap above ${spacing?.gapAbove}px`);
}

console.log("\n── the rest of the page still renders ──");
{
  const m = await page.evaluate(() => ({
    tables: document.querySelectorAll("table").length,
    buttons: document.querySelectorAll("button").length,
    text: document.body.innerText.length,
  }));
  eq("the Cash Flow lens still renders a table", m.tables > 0, true);
  eq("the lens nav still renders its buttons", m.buttons >= 3, true);
  console.log(`     ${m.tables} tables · ${m.buttons} buttons · ${m.text} chars`);
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
