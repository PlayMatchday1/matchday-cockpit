// THE GROWTH TAB, RENDERED — the fourth and last push of the /growth rename sequence.
//
// /growth and can_access_growth belonged to Player Lifecycle until 2026-08-23. Push A moved that
// section to /lifecycle and its permission to can_access_lifecycle; Push B moved Field Pipeline
// here; migration 0140 reset can_access_growth to false on every row; this push gives both names
// to the new tab.
//
// WHAT THIS SUITE CANNOT DO, AND WHY THE DECISION TABLE IS A SEPARATE FILE. 0140 reset the column
// on all 16 accounts, so there is no account holding can_access_growth to log in as, and every
// admin sees the tab through the is_admin short-circuit rather than through the flag. The FLAG's
// behaviour is therefore asserted offline in scripts/growth-access-test.ts, which runs on every
// commit. This suite asserts what only a browser can: that the tab, the rail, the route and the
// board are really there, and that the paths the previous three pushes moved still land right.

import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
// A CONFINED account: the boundary refuses Growth regardless of any flag, and beats is_admin.
const CONFINED = "garrettsuits@gmail.com";

let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const atLeast = (n, got, min) => (got >= min ? ok(`${n} (${got} ≥ ${min})`) : bad(n, `got ${got}, want ≥ ${min}`));

const STAGES = ["Field Backlog", "Contacted", "Ongoing Negotiation", "Confirmed Fields", "Archived Fields"];

async function main() {
  const browser = await chromium.launch();
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  const boardReady = () =>
    page.waitForFunction(
      (stages) => !/Loading pipeline/.test(document.body.innerText)
        && !!document.querySelector("h1")
        && [...document.querySelectorAll("span")].some((s) => stages.includes(s.textContent.trim())),
      STAGES, { timeout: 180000 },
    );

  // ═══ 1. /growth IS THE GROWTH TAB NOW, not a redirect out of the section ═══════════════════════
  console.log("\n── /growth belongs to Growth");
  await page.goto(`${BASE}/growth`, { waitUntil: "domcontentloaded" });
  await boardReady();
  eq("/growth → /growth/field-pipeline", new URL(page.url()).pathname, "/growth/field-pipeline");
  eq("…and NOT out to /lifecycle", new URL(page.url()).pathname.startsWith("/lifecycle"), false);
  eq("browser tab title", await page.title(), "Growth");

  // ═══ 2. THE TAB, AND THE ONE IT MUST NOT BE ════════════════════════════════════════════════════
  console.log("\n── the top nav carries BOTH tabs, distinctly");
  const tabs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="topnav-tab"]')].map((e) => ({
      label: e.getAttribute("data-tab"), href: e.getAttribute("href"), active: e.getAttribute("data-active"),
    })));
  eq("Growth is present", tabs.filter((t) => t.label === "Growth").map((t) => t.href), ["/growth"]);
  eq("Player Lifecycle is present and separate", tabs.filter((t) => t.label === "Player Lifecycle").map((t) => t.href), ["/lifecycle"]);
  eq("…they are two different tabs", tabs.filter((t) => t.label === "Growth" || t.label === "Player Lifecycle").length, 2);
  eq("Growth is the lit tab on a Growth route", tabs.find((t) => t.label === "Growth")?.active, "true");
  eq("…and Player Lifecycle is not", tabs.find((t) => t.label === "Player Lifecycle")?.active, "false");

  // ═══ 3. THE SHELL PUSH B GAVE UP IS BACK ═══════════════════════════════════════════════════════
  console.log("\n── the section shell Field Pipeline lost in the move");
  const shell = await page.evaluate(() => {
    const rail = document.querySelector('[data-testid="app-rail"]');
    const h1 = document.querySelector("h1");
    return {
      rail: !!rail,
      items: [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.innerText.trim().split("\n")[0]),
      hrefs: [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.getAttribute("href")),
      h1Left: h1 ? Math.round(h1.getBoundingClientRect().left) : null,
      mobileOnlyTotal: document.querySelectorAll('[class~="min-[900px]:hidden"]').length,
      mobileOnlyShown: [...document.querySelectorAll('[class~="min-[900px]:hidden"]')]
        .filter((e) => getComputedStyle(e).display !== "none").length,
      hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  eq("the rail is mounted", shell.rail, true);
  eq("…with Field Pipeline in it", shell.items, ["Field Pipeline"]);
  eq("…pointing at the new route", shell.hrefs, ["/growth/field-pipeline"]);
  // The rail is 212px expanded; the content must sit clear of it, as it did under Match Ops.
  atLeast("content is offset clear of the rail", shell.h1Left ?? 0, 212);
  // Expects ≥ 1, so it is its own control: a page with no mobile bar yields 0 and fails.
  atLeast("the mobile screen-picker bar is back", shell.mobileOnlyTotal, 1);
  eq("…and correctly hidden at 1600px", shell.mobileOnlyShown, 0);
  eq("no horizontal overflow at 1600px", shell.hOverflow, false);

  // ═══ 4. THE BOARD STILL WORKS, under its new permission ════════════════════════════════════════
  console.log("\n── the board itself");
  const board = await page.evaluate((stages) => ({
    stageTitles: [...document.querySelectorAll("span")].map((s) => s.textContent.trim()).filter((t) => stages.includes(t)),
    cards: document.querySelectorAll('[draggable="true"]').length,
    selects: document.querySelectorAll("select").length,
  }), STAGES);
  eq("all five stages render", board.stageTitles, STAGES);
  atLeast("cards render", board.cards, 1);
  eq("both filter controls render", board.selects, 2);

  // ═══ 5. THE THREE PATHS THE PREVIOUS PUSHES MOVED ══════════════════════════════════════════════
  console.log("\n── every path the rename sequence touched");
  const land = async (p) => { await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" }); return new URL(page.url()).pathname; };
  eq("/match-ops/field-pipeline → /growth/field-pipeline (Push B)", await land("/match-ops/field-pipeline"), "/growth/field-pipeline");
  eq("/growth/funnel → /lifecycle/funnel (Push A, and STILL enumerated)", await land("/growth/funnel"), "/lifecycle/funnel");
  eq("/growth/austin → /lifecycle/austin (Push A)", await land("/growth/austin"), "/lifecycle/austin");
  eq("/cities → /lifecycle/funnel, not into Growth", await land("/cities"), "/lifecycle/funnel");

  // ═══ 6. THE BOUNDARY REFUSES GROWTH ════════════════════════════════════════════════════════════
  // A confined account is offered matchops and chats and nothing else — asserted here because the
  // boundary is the one rule that beats is_admin, and a new tab is exactly where it gets forgotten.
  console.log("\n── a confined account is not offered Growth");
  const { storageState: confinedState } = await storageStateFor(CONFINED, BASE);
  const cctx = await browser.newContext({ storageState: confinedState, viewport: { width: 1600, height: 1100 } });
  const cpage = await cctx.newPage();
  await cpage.goto(`${BASE}/city/manager-pay`, { waitUntil: "domcontentloaded" });
  await cpage.waitForSelector('[data-testid="topnav-tab"]', { timeout: 120000 }).catch(() => {});
  const ctabs = await cpage.evaluate(() =>
    [...document.querySelectorAll('[data-testid="topnav-tab"]')].map((e) => e.getAttribute("data-tab")));
  // POSITIVE CONTROL for the absence below: this selector is proven to find tabs for the ADMIN in
  // this same run (block 2). Here the tier legitimately renders none, so the control is that
  // comparison, not a count — stated rather than faked with an atLeast that would fail by design.
  eq("no Growth tab for a confined account", ctabs.filter((t) => t === "Growth"), []);
  eq("…and the admin DID get one (the same selector, same run)", tabs.filter((t) => t.label === "Growth").length, 1);
  await closeContext(cctx);

  eq("no page errors", pageErrors, []);
  await closeContext(ctx);
  await closeBrowser(browser);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
  if (passed === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main().catch(fatal);
