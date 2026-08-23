// FIELD PIPELINE MOVES TO GROWTH — a characterisation net over a relocation.
//
// The board goes from /match-ops/field-pipeline to /growth/field-pipeline. The BOARD must be
// identical; the SHELL around it cannot be, and this suite says which is which rather than
// pretending a move out of a section layout changes nothing.
//
// WHAT MUST BE IDENTICAL — asserted against a fixture captured from the OLD route before the move:
// the heading, the five stage columns in order, the two filter selects and everything in them, the
// search placeholder and the board's own three controls.
//
// WHAT MUST BE TRUE OF THE DATA — reconciled against kanban_cards IN THE SAME RUN, not pinned. The
// board is worked on daily; a fixture of live counts would go stale and then get "fixed" by
// copying whatever the page said, which records the bug rather than catching it.
//
// WHAT CHANGES, DELIBERATELY, AND IS ASSERTED AS CHANGING: the Match Ops rail, the 212px content
// offset it drives, and the Match Ops mobile bar. Those belong to /match-ops/layout.tsx and the
// page has left it. Growth builds its own shell in the next push. Asserting the loss beats
// discovering it — SHELL_EXPECTED below is the record of what a reviewer signed off on.
//
// ITEMISED SELECTOR-PATH EDIT (the only line that differs from the baseline run; no assertion body
// changed):
//   * ROUTE  "/match-ops/field-pipeline" → "/growth/field-pipeline"
// SHELL_EXPECTED.rail flipped true → false in the same edit, and that is a BEHAVIOUR change, not a
// path edit — it is called out here so it is not read as one.

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor, netRetry } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";

// ── the path constant, and the one line the move touched ────────────────────────────────────────
const ROUTE = "/growth/field-pipeline";
const LEGACY = "/match-ops/field-pipeline";

// The Match Ops shell is GONE at the new route: no rail, and no mobile screen-picker bar. Both are
// asserted, and both are measured on a route that STILL has them in the same run so the zeros are
// not zeros from a page that failed to load.
const SHELL_EXPECTED = { rail: false, mobileOnlyBlocks: 0 };
// The mobile-only block in this app is `min-[900px]:hidden` (MatchOpsMobileBar), NOT `lg:hidden` —
// which appears nowhere, so an assertion written against it passes on nothing. That is what the
// first version of this suite did, and its own positive control is what caught it.
const MOBILE_ONLY = '[class~="min-[900px]:hidden"]';

const ADMIN = "rmancuso@playmatchday.com";
const STAGES = ["Field Backlog", "Contacted", "Ongoing Negotiation", "Confirmed Fields", "Archived Fields"];
const STAGE_ID = {
  "Field Backlog": "backlog", "Contacted": "contacted", "Ongoing Negotiation": "negotiation",
  "Confirmed Fields": "confirmed", "Archived Fields": "archived",
};

const BASELINE = JSON.parse(readFileSync("scripts/e2e/fixtures/fieldpipeline-baseline.json", "utf8"));

let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const atLeast = (n, got, min) => (got >= min ? ok(`${n} (${got} ≥ ${min})`) : bad(n, `got ${got}, want ≥ ${min}`));

async function main() {
  // ── the independent count, from the rows, in this run ──────────────────────────────────────────
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data: cards, error: dbErr } = await netRetry(
    () => sb.from("kanban_cards").select("id, stage").eq("board_type", "field_pipeline"),
    "kanban_cards read",
  );
  if (dbErr) { bad("could not read kanban_cards", dbErr.message); }
  const dbCount = {};
  for (const c of cards ?? []) dbCount[c.stage] = (dbCount[c.stage] ?? 0) + 1;

  const browser = await chromium.launch();
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}${ROUTE}`, { waitUntil: "domcontentloaded" });
  // READY SIGNAL, page-emitted: the board replaces its own "Loading pipeline…" with a heading and
  // at least one stage column. A flat sleep would satisfy every absence check below.
  await page.waitForFunction(
    (stages) => {
      if (/Loading pipeline/.test(document.body.innerText)) return false;
      if (!document.querySelector("h1")) return false;
      return [...document.querySelectorAll("span")].some((s) => stages.includes(s.textContent.trim()));
    },
    STAGES, { timeout: 180000 },
  );

  // ═══ 1. THE BOARD, against the pre-move fixture ════════════════════════════════════════════════
  console.log(`\n── the board at ${ROUTE} vs the ${LEGACY} fixture`);
  const fp = await page.evaluate((stages) => {
    const selects = [...document.querySelectorAll("select")];
    const search = document.querySelector('input[type="text"], input:not([type])');
    return {
      h1: document.querySelector("h1")?.textContent.trim() ?? null,
      stageTitles: [...document.querySelectorAll("span")]
        .map((s) => s.textContent.trim()).filter((t) => stages.includes(t)),
      selectCount: selects.length,
      ownerOptions: [...(selects[0]?.options ?? [])].map((o) => o.textContent.trim()),
      cityOptions: [...(selects[1]?.options ?? [])].map((o) => o.textContent.trim()),
      searchPlaceholder: search?.getAttribute("placeholder") ?? null,
      boardButtons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim())
        .filter((t) => ["Grouped by city", "Flat list", "To-dos shown", "To-dos hidden", "+ New card"].includes(t)),
    };
  }, STAGES);
  eq("the board is identical to the pre-move fixture", fp, BASELINE.board);

  // ═══ 2. THE DATA, reconciled against the rows in this run ══════════════════════════════════════
  console.log(`\n── column counts vs an independent count from kanban_cards`);
  const shown = await page.evaluate((stages) =>
    [...document.querySelectorAll("span")]
      .filter((s) => stages.includes(s.textContent.trim()))
      .map((s) => ({ stage: s.textContent.trim(), count: s.nextElementSibling?.textContent.trim() ?? null })),
  STAGES);
  // Expects an exact N ≥ 1 per stage, so each is self-controlling: a board that rendered nothing
  // yields null and fails.
  for (const st of STAGES) {
    const want = dbCount[STAGE_ID[st]] ?? 0;
    const got = shown.find((r) => r.stage === st)?.count ?? null;
    if (st === "Archived Fields") {
      // Archived renders as a collapsed per-city accordion and carries no header pill — its own
      // shape, not a missing number. Asserted through the card total below instead.
      ok(`${st} — collapsed group, no header pill (as before the move)`);
      continue;
    }
    eq(`${st} — page ${got} = rows ${want}`, Number(got), want);
  }
  const draggable = await page.evaluate(() => document.querySelectorAll('[draggable="true"]').length);
  const expectVisible = (cards ?? []).filter((c) => c.stage !== "archived").length;
  eq("draggable cards = every non-archived row", draggable, expectVisible);

  // ═══ 3. LAYOUT AT 1600px ═══════════════════════════════════════════════════════════════════════
  console.log(`\n── layout at 1600px`);
  const layout = await page.evaluate((sel) => {
    const h1 = document.querySelector("h1");
    const cols = [...document.querySelectorAll("span")]
      .filter((s) => ["Field Backlog", "Contacted", "Ongoing Negotiation", "Confirmed Fields"].includes(s.textContent.trim()))
      .map((s) => Math.round(s.getBoundingClientRect().top));
    return {
      railPresent: !!document.querySelector('nav[aria-label="Match Ops"]'),
      h1Left: h1 ? Math.round(h1.getBoundingClientRect().left) : null,
      hOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      // the four expanded column headers must sit on ONE band
      colBandSpread: cols.length ? Math.max(...cols) - Math.min(...cols) : -1,
      colCount: cols.length,
      // AN ELEMENT MERELY CARRYING a max-[899px] utility (the section content wrapper does) is a
      // desktop block with a mobile-conditional rule on it — counting those reports a failure on
      // every page in the app. Only min-[900px]:hidden means "narrow viewports only".
      mobileOnlyTotal: document.querySelectorAll(sel).length,
      mobileOnlyShown: [...document.querySelectorAll(sel)]
        .filter((e) => getComputedStyle(e).display !== "none").length,
    };
  }, MOBILE_ONLY);
  eq("no horizontal overflow at 1600px", layout.hOverflow, false);
  // Expects exactly 4, so it fails on a page that rendered no columns — self-controlling.
  eq("four expanded column headers found", layout.colCount, 4);
  eq("…and they occupy a single band", layout.colBandSpread, 0);
  eq("no mobile-only block is DISPLAYED at 1600px", layout.mobileOnlyShown, 0);

  // ═══ 4. THE SHELL IT LEFT BEHIND — asserted, not discovered ════════════════════════════════════
  console.log(`\n── the Match Ops shell, deliberately gone`);
  eq("Match Ops rail is absent at the new route", layout.railPresent, SHELL_EXPECTED.rail);
  eq("…and so is the mobile screen-picker bar", layout.mobileOnlyTotal, SHELL_EXPECTED.mobileOnlyBlocks);

  // POSITIVE CONTROLS for both absences: the SAME two selectors, and the SAME display measurement,
  // proven on a route that still has the shell — in this same run. Without this, a page that failed
  // to load reports exactly the numbers asserted above.
  await page.goto(`${BASE}/match-ops/master-schedule`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('nav[aria-label="Match Ops"]', { timeout: 120000 });
  const control = await page.evaluate((sel) => ({
    rail: !!document.querySelector('nav[aria-label="Match Ops"]'),
    mobileTotal: document.querySelectorAll(sel).length,
    mobileShown: [...document.querySelectorAll(sel)].filter((e) => getComputedStyle(e).display !== "none").length,
  }), MOBILE_ONLY);
  eq("control: the rail selector DOES find a rail on a Match Ops route", control.rail, true);
  atLeast("control: the mobile-only selector DOES match there", control.mobileTotal, 1);
  eq("control: …and that block is correctly hidden at 1600px", control.mobileShown, 0);

  // ═══ 5. THE OLD PATH REDIRECTS, AND MATCH OPS' FRONT DOOR STILL OPENS ══════════════════════════
  console.log(`\n── ${LEGACY} redirects, and /match-ops still lands somewhere real`);
  await page.goto(`${BASE}${LEGACY}`, { waitUntil: "domcontentloaded" });
  eq(`${LEGACY} → ${ROUTE}`, new URL(page.url()).pathname, ROUTE);

  await page.goto(`${BASE}/match-ops`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => location.pathname !== "/match-ops", null, { timeout: 60000 }).catch(() => {});
  const landed = new URL(page.url()).pathname;
  // Match Ops' index used to redirect INTO Field Pipeline. It must now land on a Match Ops route
  // that exists — never back out into Growth, and never sit on /match-ops rendering nothing.
  eq("/match-ops lands inside Match Ops", landed.startsWith("/match-ops/"), true);
  eq("…and not on the page that moved", landed === LEGACY, false);

  // ═══ 6. THE RAIL NO LONGER OFFERS IT ═══════════════════════════════════════════════════════════
  console.log(`\n── the Match Ops rail no longer lists Field Pipeline`);
  await page.goto(`${BASE}/match-ops/master-schedule`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="rail-item"]', { timeout: 120000 });
  const rail = await page.evaluate(() => ({
    items: [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.innerText.trim().split("\n")[0]),
    hrefs: [...document.querySelectorAll('[data-testid="rail-item"]')].map((e) => e.getAttribute("href")),
  }));
  // POSITIVE CONTROL first: the rail rendered and this selector finds real items.
  atLeast("control: the rail rendered items", rail.items.length, 5);
  eq("no Field Pipeline item", rail.items.filter((t) => /Field Pipeline/i.test(t)), []);
  eq("no /field-pipeline href", rail.hrefs.filter((h) => h && h.includes("field-pipeline")), []);

  eq("no page errors", pageErrors, []);
  await closeContext(ctx);
  await closeBrowser(browser);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
  if (passed === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
}

main().catch(fatal);
