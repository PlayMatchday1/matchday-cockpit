// MATCH PROMOTION — verified by clicking, not by reading.
//
// WHAT THIS SUITE IS FOR. The page reads the mdapi mirror and writes exactly one Clubhouse table.
// The failure modes worth pinning are (1) the page 500s before match_promotion_plan exists rather
// than degrading to "no plan", (2) an empty push date stores "" instead of SQL NULL and the amber
// "needs a decision" state silently disappears, and (3) the six channel chips overflow their tile —
// SMS ran off the edge at seven columns, which is why chips wrap.
//
// IT ADAPTS TO WHETHER THE MIGRATION HAS BEEN APPLIED. Before 0128 lands the persistence half
// cannot run at all, so it asserts the DEGRADE path instead and says plainly that it skipped. Once
// the table exists the same file runs the full round-trip. Nothing is silently not-run.
//
//   node scripts/e2e/verify-match-promotion.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const URL_ = `${BASE}/match-ops/match-promotion`;

let PASS = 0, FAIL = 0, SKIP = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const skip = (n) => { SKIP++; console.log(`  ~ SKIPPED ${n}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const tableReady = !(await svc.from("match_promotion_plan").select("match_api_id").limit(1)).error;
console.log(`match_promotion_plan: ${tableReady ? "EXISTS — running the full round-trip" : "ABSENT — migration 0128 not applied yet"}\n`);

// storageStateFor returns { storageState, session, token } and keys localStorage to an ORIGIN —
// pass BASE or the session lands on the deployed host and localhost bounces to /login.
const { storageState } = await storageStateFor(ADMIN, BASE);
const browser = await chromium.launch();

/** Wait on a POSITIVE ready signal. An absence check against a loading screen proves nothing. */
async function ready(page) {
  await page.waitForSelector('[data-testid="strip-counts"]', { timeout: 45000 });
}

// ── 1. THE PAGE RENDERS, AND DEGRADES RATHER THAN 500s ────────────────────────────────────────
console.log("── the page loads ──");
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const resp = await page.goto(URL_, { waitUntil: "domcontentloaded" });
eq("the route returns 200, not 500", resp?.status(), 200);
await ready(page);
ok("the week rendered (strip counts present)");

const tiles = await page.locator('[data-testid="match-tile"]').count();
// PRESENCE FIRST — every absence and count assertion below leans on this being non-zero.
if (tiles > 0) ok(`the week has ${tiles} match tiles`);
else bad("the week has match tiles", "zero tiles — every assertion below would pass vacuously");

if (!tableReady) {
  const states = await page.locator('[data-testid="match-tile"]').evaluateAll((els) => els.map((e) => e.dataset.state));
  eq("with no table, EVERY match reads as 'no plan' rather than erroring",
     [...new Set(states)], ["none"]);
  const warn = await page.getByText("match_promotion_plan is not in the database yet").count();
  eq("…and the page says so instead of pretending", warn > 0, true);
}
eq("no uncaught page errors", errors, []);

// ── 2. ONLY THE SELECTED CHANNELS, INSIDE THE TILE, AT 1280 ───────────────────────────────────
//
// ITEMISED — AN EXPECTATION CHANGE, NOT A SELECTOR EDIT. This used to assert "every tile renders
// all six chips". It no longer does, deliberately: six chips, a "No code" pill and a "No push
// planned" line rendered on every one of 109 tiles was three rows of chrome saying the same thing
// three times, and most tiles carry no plan at all. A chip now appears ONLY when its channel is
// selected. What that assertion was really protecting — a chip running off the tile edge, which is
// the failure this layout actually had — is unchanged below and still carries its control.
console.log("\n── only the selected channels render, and they fit ──");
for (const width of [1620, 1280]) {
  await page.setViewportSize({ width, height: 1200 });
  await page.waitForTimeout(250);
  // NO UNLIT CHIP EXISTS ANYWHERE. This is the new behaviour stated as an assertion rather than
  // as an absence: an unlit chip would carry data-on="0", and none may be rendered.
  const unlit = await page.locator('[data-testid="chip"][data-on="0"]').count();
  eq(`  ${width}px — no unlit channel chip is rendered`, unlit, 0);
  /* THE CONTROL FOR THAT ZERO, AND IT MUST NOT DATE THE SUITE. `match_promotion_plan` is
   * frequently EMPTY — on 2026-08-25 all 109 tiles carried no plan, so "at least one lit chip
   * exists" would have been red on a page that was working perfectly. The zero is instead
   * explained by the data: chips appear only on tiles that HAVE a plan, so with every tile at
   * state="none" a chip count of zero is the correct render, and with any planned tile present
   * the chips must be there. Both directions are asserted, so neither can pass vacuously. */
  const census = await page.locator('[data-testid="match-tile"]').evaluateAll((els) => ({
    tiles: els.length,
    noPlan: els.filter((t) => t.getAttribute("data-state") === "none").length,
    chips: els.reduce((n, t) => n + t.querySelectorAll('[data-testid="chip"]').length, 0),
    overSix: els.filter((t) => t.querySelectorAll('[data-testid="chip"]').length > 6).length,
    chipsOnNoPlan: els.filter((t) => t.getAttribute("data-state") === "none"
      && t.querySelectorAll('[data-testid="chip"]').length > 0).length,
    planNoChips: els.filter((t) => t.getAttribute("data-state") === "needs-decision"
      && t.querySelectorAll('[data-testid="chip"]').length === 0).length,
  }));
  eq(`  ${width}px — PRESENCE: tiles rendered, so an absence check means something`, census.tiles > 0, true);
  eq(`  ${width}px — no tile renders more than the six channels`, census.overSix, 0);
  eq(`  ${width}px — a tile with no plan renders no chips`, census.chipsOnNoPlan, 0);
  // The other direction: a tile whose state says channels ARE lit must render them.
  eq(`  ${width}px — a tile needing a decision has its lit channels drawn`, census.planNoChips, 0);
  if (census.chips === 0) {
    eq(`  ${width}px — zero chips is explained: every tile carries no plan`, census.noPlan, census.tiles);
    console.log(`     no promotion plans exist this week — ${census.tiles} tiles, all state="none"`);
  } else {
    console.log(`     ${census.chips} lit chips across ${census.tiles - census.noPlan} planned tiles`);
  }

  // OVERFLOW IS MEASURED, NOT ASSUMED: each chip's right edge must sit inside its tile's box.
  const escaped = await page.locator('[data-testid="match-tile"]').evaluateAll((els) =>
    els.reduce((n, t) => {
      const tb = t.getBoundingClientRect();
      return n + [...t.querySelectorAll('[data-testid="chip"]')]
        .filter((c) => { const b = c.getBoundingClientRect(); return b.right > tb.right + 0.5 || b.left < tb.left - 0.5; }).length;
    }, 0));
  eq(`  ${width}px — no chip escapes its tile`, escaped, 0);
}
// POSITIVE CONTROL for those zeros: the same measurement DOES catch a chip pushed out of the box.
// The tile is chosen BY HAVING A CHIP — .first() no longer works now that most tiles have none.
/* The control is measured on whatever inline element the tile actually has — a chip when one
 * exists, otherwise the NEW badge, otherwise the venue line. The MEASUREMENT is what is being
 * proved (that a box escaping its tile is detected), and it must not depend on this week having a
 * promotion plan. Returns null only if the grid rendered nothing at all, which fails. */
const controlEscape = await page.evaluate(() => {
  const t = [...document.querySelectorAll('[data-testid="match-tile"]')][0];
  if (!t) return null;
  const c = t.querySelector('[data-testid="chip"]') ?? t.querySelector('[data-testid="new-badge"]') ?? t.lastElementChild;
  if (!c) return null;
  const before = c.style.cssText;
  c.style.position = "relative"; c.style.left = "9999px";
  const tb = t.getBoundingClientRect(), b = c.getBoundingClientRect();
  const caught = b.right > tb.right + 0.5;
  c.style.cssText = before;
  return caught;
});
eq("  CONTROL — the overflow measurement catches a deliberately displaced box", controlEscape, true);

// ── 2b. THE CHROME THAT WAS REMOVED STAYS REMOVED ─────────────────────────────────────────────
console.log("\n── absence, proved against a page that rendered ──");
const gridText = await page.locator('[data-testid="city-block"]').first().innerText();
eq("  CONTROL — the grid rendered and has text to search", gridText.length > 40, true);
for (const gone of ["No code", "No push planned"]) {
  eq(`  the grid no longer prints "${gone}"`, gridText.includes(gone), false);
}
// A tile with no plan is the time, the field, and nothing else — so it carries no push line.
const noPlanPush = await page.locator('[data-testid="match-tile"][data-state="none"]').evaluateAll((els) =>
  els.filter((t) => /Push |Needs a decision/.test(t.innerText)).length);
eq("  a tile with no plan carries no push line", noPlanPush, 0);
eq("  CONTROL — there are no-plan tiles to check",
   await page.locator('[data-testid="match-tile"][data-state="none"]').count() > 0, true);

// ── 2c. THE NEW BADGE, AND THE CITY COUNT THAT DESCRIBES IT ───────────────────────────────────
console.log("\n── NEW badges and their city counts ──");
eq("the rule is stated on the page", await page.locator('[data-testid="new-rule"]').count(), 1);
const ruleText = await page.locator('[data-testid="new-rule"]').innerText();
for (const must of ["cancelled", "NEW FIELD", "NEW DAY", "NEW TIME"]) {
  eq(`  the rule says "${must}"`, ruleText.includes(must), true);
}
const badgeAudit = await page.evaluate(() => {
  const LABELS = ["NEW FIELD", "NEW DAY", "NEW TIME"];
  const out = [];
  let bad = 0;
  for (const block of document.querySelectorAll('[data-testid="city-block"]')) {
    const badges = [...block.querySelectorAll('[data-testid="new-badge"]')];
    for (const b of badges) if (!LABELS.includes(b.innerText.trim())) bad++;
    // ONE badge per tile at most — the brief is one badge saying which it is, not a set.
    const multi = [...block.querySelectorAll('[data-testid="match-tile"]')]
      .filter((t) => t.querySelectorAll('[data-testid="new-badge"]').length > 1).length;
    const chipEl = block.querySelector('[data-testid="city-new-count"]');
    out.push({
      city: block.querySelector("h2")?.innerText.trim() ?? "?",
      badges: badges.length,
      claimed: chipEl ? Number(chipEl.innerText.replace(/\D/g, "")) : 0,
      multi,
    });
  }
  return { rows: out, bad };
});
eq("every badge reads one of the three labels", badgeAudit.bad, 0);
eq("no tile carries more than one badge", badgeAudit.rows.filter((r) => r.multi > 0).map((r) => r.city), []);
eq("every city's 'N new' equals the badges rendered under it",
   badgeAudit.rows.filter((r) => r.badges !== r.claimed).map((r) => `${r.city} ${r.badges}≠${r.claimed}`), []);
const totalBadges = badgeAudit.rows.reduce((n, r) => n + r.badges, 0);
// THE CONTROL FOR THE EQUALITY ABOVE, which would hold vacuously if nothing were badged at all.
// A week with no new slots is possible, so the check is two-directional rather than a fixed count:
// either badges exist, or NO city claims any.
if (totalBadges === 0) {
  eq("  no new slots this week — and no city claims one", badgeAudit.rows.filter((r) => r.claimed > 0), []);
} else {
  eq(`  CONTROL — ${totalBadges} badges rendered, so the equality had something to compare`, totalBadges > 0, true);
}

// ── 3. THE STRIP COUNTS EQUAL WHAT IS RENDERED ────────────────────────────────────────────────
console.log("\n── the next-48-hours counts equal the page ──");
await page.setViewportSize({ width: 1620, height: 1200 });
const stripText = (await page.locator('[data-testid="strip-counts"]').textContent()) ?? "";
const [nPush, nOver, nNoPlan] = [...stripText.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
eq("the push count equals the job chips rendered", nPush, await page.locator('[data-testid="job"]').count());
eq("the no-plan count equals the dashed tiles rendered", nNoPlan,
   await page.locator('[data-testid="match-tile"][data-state="none"]').count());
const overdueChips = await page.locator('[data-testid="job"]').evaluateAll((els) =>
  els.filter((e) => /Overdue/.test(e.textContent ?? "")).length);
eq("the overdue count equals the chips marked Overdue", nOver, overdueChips);

// ── 4. THE TAB ────────────────────────────────────────────────────────────────────────────────
console.log("\n── Coverage, and back ──");
await page.getByRole("button", { name: "coverage", exact: false }).click();
await page.waitForSelector('[data-testid="coverage-grid"]', { timeout: 15000 });
ok("Coverage renders its grid");
const covRows = await page.locator('[data-testid="coverage-row"]').count();
eq("Coverage has one row per city with matches", covRows > 0, true);
eq("the cancel grid is NOT on the Coverage tab", await page.locator('[data-testid="cancel-patterns"]').count(), 0);

/* COLOUR MARKS THE EXCEPTION. Every open cell used to be a filled coral block reading OPEN, so on
 * a week with no plans the whole grid was coral and the colour said nothing. Both states are
 * asserted as arithmetic in scripts/match-promotion-new-test.ts — production's plan table is
 * empty, so a screen check can only ever observe the no-plans half. What is checked HERE is the
 * DOM contract that half depends on. */
const cov = await page.evaluate(() => {
  const cells = [...document.querySelectorAll('[data-testid="coverage-day"]')];
  const opens = [...document.querySelectorAll('[data-testid="coverage-open"]')];
  const cap = document.querySelector('[data-testid="coverage-caption"]');
  return {
    caption: cap?.innerText.trim() ?? null,
    anyPlanned: cap?.getAttribute("data-any-planned"),
    byState: Object.fromEntries(["planned", "open", "none"].map((k) =>
      [k, cells.filter((c) => c.getAttribute("data-cov") === k).length])),
    saysOpenWord: opens.filter((e) => /\bOPEN\b/.test(e.innerText)).length,
    marked: opens.filter((e) => e.getAttribute("data-marked") === "1").length,
    // A FILLED coral block: opaque-ish, red-dominant. This is the thing that was removed.
    filled: opens.filter((e) => {
      const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g);
      if (!m) return false;
      const [r, g, b, a = 1] = m.map(Number);
      return a > 0.35 && r > 200 && g < 190 && b < 190;
    }).length,
    // THE DISTINCTION THIS VIEW ANSWERS, read off the DOM rather than off the colour.
    openHaveText: opens.every((e) => e.innerText.trim().length > 3),
    noneAreDashes: cells.filter((c) => c.getAttribute("data-cov") === "none")
      .every((c) => c.innerText.trim() === "—"),
  };
});
eq("the caption is on the page", cov.caption !== null && cov.caption.length > 10, true);
eq("  CONTROL — the grid rendered cells for it to describe", cov.byState.planned + cov.byState.open + cov.byState.none > 0, true);
eq("no open cell is a filled coral block", cov.filled, 0);
eq("no open cell prints the word OPEN", cov.saysOpenWord, 0);
// THE DISTINCTION MUST SURVIVE THE COLOUR: content separates the two, not the fill.
eq("every open cell names its field and time", cov.openHaveText, true);
eq("every no-match cell is a dash", cov.noneAreDashes, true);
eq("  CONTROL — both kinds of cell are present to be told apart",
   cov.byState.open > 0 && cov.byState.none > 0, true);
/* THE MARKER TRACKS anyPlanned IN BOTH DIRECTIONS, so neither branch passes vacuously on a week
 * that happens to be empty — which every week is until someone plans a push. */
if (cov.anyPlanned === "0") {
  eq("nothing planned — the caption says so once", /^No pushes planned this week\./.test(cov.caption), true);
  eq("  …and not one open cell carries the coral marker", cov.marked, 0);
} else {
  eq("coverage exists — the caption counts covered days", /covered day/.test(cov.caption), true);
  eq("  …and every open cell carries the coral marker", cov.marked, cov.byState.open);
  eq("  …and covered cells are present to be the loud ones", cov.byState.planned > 0, true);
}
console.log(`     coverage: ${cov.byState.planned} covered · ${cov.byState.open} open · ${cov.byState.none} no matches · anyPlanned=${cov.anyPlanned}`);
await page.getByRole("button", { name: "plan", exact: false }).click();
await page.waitForSelector('[data-testid="match-tile"]', { timeout: 15000 });
ok("back on Plan, the week is rendered again");

// ── 5. CANCEL PATTERNS — the hand-checks, done by the machine ─────────────────────────────────
console.log("\n── cancel patterns: the cards are true of the grid beneath them ──");
await page.waitForSelector('[data-testid="cancel-patterns"]', { timeout: 60000 });
const rowCounts = await page.locator('[data-testid="cancel-row-count"]').evaluateAll((els) =>
  els.map((e) => Number((e.textContent ?? "0").replace(/\D/g, ""))));
const headline = Number((await page.locator('[data-testid="stat-total"]').textContent()) ?? "0");
const chips = await page.locator('[data-testid="cancel-chip"]').count();
if (chips === 0) {
  skip("cancel-grid arithmetic — no cancellations in the window, nothing to check");
} else {
  eq("the city rows sum to the headline total", rowCounts.reduce((a, b) => a + b, 0), headline);
  eq("…and the headline equals the chips actually drawn", headline, chips);
  // Worst day card must name the weekday column carrying the most chips.
  const perDay = await page.locator('[data-testid="cancel-row"]').evaluateAll((els) => {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const r of els) [...r.querySelectorAll("td")].slice(1).forEach((td, i) => {
      c[i] += td.querySelectorAll('[data-testid="cancel-chip"]').length;
    });
    return c;
  });
  // The worst-slot card must be the worst slot IN THE GRID, not a separately computed figure.
  const maxN = await page.locator('[data-testid="cancel-chip"]').evaluateAll((els) =>
    Math.max(...els.map((e) => Number((e.textContent ?? "").match(/(\d)\/4/)?.[1] ?? 0))));
  const worstCard = (await page.locator('[data-testid="stat-worst"]').textContent()) ?? "";
  const worstNote = (await page.locator('[data-testid="stat-worst"]').evaluate((e) => e.nextElementSibling?.textContent)) ?? "";
  eq("the 'worst slot' card's N-of-4 is the highest N in the grid",
     Number(worstNote.match(/(\d) of 4/)?.[1] ?? -1), maxN);
  // …and the slot it names is really drawn in the grid, at that frequency.
  const worstCode = worstCard.split("·")[0].trim();
  const drawn = await page.locator('[data-testid="cancel-chip"]').evaluateAll(
    (els, n) => els.filter((e) => new RegExp(`${n}\\/4`).test(e.textContent ?? "")).length, maxN);
  eq("  …and at least one chip in the grid carries that frequency", drawn > 0, true);
  void worstCode;

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  eq("the 'worst day' card names the fullest column in the grid",
     (await page.locator('[data-testid="stat-worstday"]').textContent())?.trim(),
     DOW[perDay.indexOf(Math.max(...perDay))]);
}

// ── 5b. THE PANEL OPENS INLINE, UNDER ITS OWN CITY ────────────────────────────────────────────
// The panel used to render once at the foot of the page: clicking an Atlanta match scrolled you
// past every other city to reach the editor. Correct-but-a-page-away is the bug, so proximity is
// measured in pixels and position is checked in DOM order — either alone would miss it.
console.log("\n── the plan panel opens inline, beside the tile that opened it ──");
{
  const cityBlocks = page.locator('[data-testid="city-block"]');
  const nCities = await cityBlocks.count();
  eq("there is more than one city, so 'under the right one' is a real question", nCities > 1, true);

  // Deliberately use a tile in the LAST city — the case the old layout got most wrong.
  const lastCity = cityBlocks.nth(nCities - 1);
  const tile = lastCity.locator('[data-testid="match-tile"]').first();
  await tile.click();
  await page.waitForSelector('[data-testid="panel"]', { timeout: 15000 });

  const gap = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="match-tile"][data-open="1"]')
      ?? document.querySelector('[data-testid="panel"]')?.closest('[data-testid="city-block"]')?.querySelector('[data-testid="match-tile"]');
    const p = document.querySelector('[data-testid="panel"]');
    if (!t || !p) return null;
    return Math.round(p.getBoundingClientRect().top - t.getBoundingClientRect().bottom);
  });
  eq("the panel's top edge is within 420px of the open tile's bottom edge", gap !== null && gap < 420, true);
  console.log(`     measured gap: ${gap}px`);

  // DOM ORDER: the panel must live inside its own city block, and that block must be the one
  // holding the clicked tile — not a later sibling, and not the page root.
  const placement = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="panel"]');
    const own = p?.closest('[data-testid="city-block"]') ?? null;
    const blocks = [...document.querySelectorAll('[data-testid="city-block"]')];
    return {
      insideACityBlock: !!own,
      indexOfOwn: own ? blocks.indexOf(own) : -1,
      lastIndex: blocks.length - 1,
      // the panel comes AFTER the week grid within its block
      afterTheGrid: !!own && own.lastElementChild === p,
    };
  });
  eq("the panel sits INSIDE a city block, not at the page root", placement.insideACityBlock, true);
  eq("…specifically the block whose tile was clicked (the last city)", placement.indexOfOwn, placement.lastIndex);
  eq("…and after that city's week grid, before the next city", placement.afterTheGrid, true);

  eq("the clicked tile keeps its selected border while the panel is open",
     await page.locator('[data-testid="match-tile"][data-open="1"]').count(), 1);
  eq("only one panel is open at a time", await page.locator('[data-testid="panel"]').count(), 1);

  // Clicking a tile in a DIFFERENT city moves the panel with it.
  const firstCity = cityBlocks.nth(0);
  await firstCity.locator('[data-testid="match-tile"]').first().click();
  await page.waitForTimeout(400);
  const moved = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="panel"]');
    const blocks = [...document.querySelectorAll('[data-testid="city-block"]')];
    return blocks.indexOf(p?.closest('[data-testid="city-block"]'));
  });
  eq("clicking another city's tile moves the panel to THAT city", moved, 0);
  eq("…and still only one panel exists", await page.locator('[data-testid="panel"]').count(), 1);

  // CLOSING RETURNS THE PAGE TO THE SAME SCROLL POSITION.
  const before = await page.evaluate(() => window.scrollY);
  await page.locator('[data-testid="panel"]').getByText("Cancel", { exact: true }).click();
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.scrollY);
  eq("closing the panel leaves the scroll position within 4px of where it was", Math.abs(after - before) <= 4, true);
  eq("…and the panel is gone", await page.locator('[data-testid="panel"]').count(), 0);
}

// ── 5c. THE STRIPPING STAYS STRIPPED ──────────────────────────────────────────────────────────
// Explanatory prose grows back one helpful sentence at a time. These assertions are the ratchet:
// they fail on the FIRST paragraph re-added, not once the panel is a wall of text again.
console.log("\n── the panel and cancel grid stay stripped ──");
{
  const tile = page.locator('[data-testid="city-block"]').first().locator('[data-testid="match-tile"]').first();
  await tile.click();
  await page.waitForSelector('[data-testid="panel"]', { timeout: 15000 });

  const h = await page.locator('[data-testid="panel"]').evaluate((e) => Math.round(e.getBoundingClientRect().height));
  eq("the panel is under 250px tall", h < 250, true);
  console.log(`     measured height: ${h}px`);

  // NO TEXT NODE OF FIVE OR MORE WORDS anywhere inside the panel — excluding its title and the
  // user's own comment, which are content rather than explanation.
  const longNodes = await page.locator('[data-testid="panel"]').evaluate((panel) => {
    const out = [];
    const walk = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el) continue;
      if (el.closest("h3")) continue;                       // the title
      if (el.tagName === "TEXTAREA" || el.closest("textarea")) continue; // the operator's comment
      const words = (n.textContent ?? "").trim().split(/\s+/).filter(Boolean);
      if (words.length >= 5) out.push(words.join(" "));
    }
    return out;
  });
  eq("no text node inside the panel runs to five or more words", longNodes, []);
  // CONTROL for that empty array: the walker DOES see the panel's short labels, so an empty result
  // means "nothing long", not "nothing scanned".
  const seen = await page.locator('[data-testid="panel"]').evaluate((panel) => {
    const walk = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    let n = 0; for (let x = walk.nextNode(); x; x = walk.nextNode()) if ((x.textContent ?? "").trim()) n++;
    return n;
  });
  eq("  CONTROL — the walker found text nodes to scan", seen > 5, true);

  eq("the lead time survives as a fragment beside the When field",
     await page.locator('[data-testid="lead"]').count(), 1);
  const leadWords = ((await page.locator('[data-testid="lead"]').textContent()) ?? "").trim().split(/\s+/).length;
  eq("…and it is a fragment, not a sentence", leadWords <= 4, true);

  await page.locator('[data-testid="panel"]').getByText("Cancel", { exact: true }).click();
  await page.waitForTimeout(300);
}
{
  eq("there are three stat cards, not four", await page.locator('[data-testid^="stat-"]').count(), 3);
  eq("the 'dying and unpromoted' card is gone", await page.locator('[data-testid="stat-unprom"]').count(), 0);
  const grid = page.locator('[data-testid="cancel-patterns"]');
  const text = ((await grid.textContent()) ?? "").toLowerCase();
  eq("'not promoted' appears nowhere in the cancel grid", text.includes("not promoted"), false);
  // CONTROL: the same scan DOES find text that is definitely there.
  eq("  CONTROL — the scan reads the grid (it finds 'cancel patterns')", text.includes("cancel patterns"), true);
  const longChips = await page.locator('[data-testid="cancel-chip"]').evaluateAll((els) =>
    els.map((e) => (e.textContent ?? "").trim().split(/\s+/).filter(Boolean))
       .filter((w) => w.length > 5).map((w) => w.join(" ")));
  eq("no chip's text runs longer than five words", longChips, []);
  eq("  CONTROL — there are chips to measure", await page.locator('[data-testid="cancel-chip"]').count() > 0, true);
}

// ── 6. SCREENSHOTS ────────────────────────────────────────────────────────────────────────────
console.log("\n── screenshots ──");
for (const width of [1620, 1280]) {
  await page.setViewportSize({ width, height: 1400 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `/tmp/mp-plan-${width}.png`, fullPage: true });
  await page.getByRole("button", { name: "coverage", exact: false }).click();
  await page.waitForSelector('[data-testid="coverage-grid"]');
  await page.screenshot({ path: `/tmp/mp-coverage-${width}.png`, fullPage: true });
  await page.getByRole("button", { name: "plan", exact: false }).click();
  await page.waitForSelector('[data-testid="match-tile"]');
  console.log(`  saved /tmp/mp-plan-${width}.png and /tmp/mp-coverage-${width}.png`);
}

// ── 7. THE ROUND TRIP ─────────────────────────────────────────────────────────────────────────
console.log("\n── plan a match, reload, clear the date ──");
if (!tableReady) {
  // The write must FAIL LOUDLY rather than pretend, and that IS testable now.
  const first = page.locator('[data-testid="match-tile"]').first();
  await first.click();
  await page.waitForSelector('[data-testid="panel"]');
  await page.locator('[data-testid="ch-wa"]').click();
  await page.locator('[data-testid="save"]').click();
  await page.waitForTimeout(2500);
  const msg = (await page.locator('[data-testid="panel"]').textContent()) ?? "";
  eq("with no table the save REFUSES and names the migration",
     /FAILED|NOT APPLIED/.test(msg) && /0128/.test(msg), true);
  skip("persist → reload → clear-date round trip (needs migration 0128 applied)");
  skip("push_at stores SQL NULL rather than an empty string (needs migration 0128 applied)");
} else {
  // Clear anything a previous interrupted run left behind, so this starts from a known state.
  for (const r of (await svc.from("match_promotion_plan").select("match_api_id").eq("promo_code", "E2E-PROBE")).data ?? [])
    await svc.from("match_promotion_plan").delete().eq("match_api_id", r.match_api_id);
  const probeMatch = await page.locator('[data-testid="match-tile"]').first().evaluate((e) => e.textContent);
  const first = page.locator('[data-testid="match-tile"]').first();
  await first.click();
  await page.waitForSelector('[data-testid="panel"]');
  await page.locator('[data-testid="ch-wa"]').click();
  await page.locator('[data-testid="ch-match_chat"]').click();
  await page.locator('[data-testid="promo-code"]').fill("E2E-PROBE");
  // A push time inside this week so the tile renders as planned.
  //
  // fill(), NOT `el.value = ...`. React overrides the value setter and tracks it, so assigning
  // .value and dispatching an input event updates the DOM and leaves React state untouched — the
  // save then posts an empty date and the tile comes back as "needs a decision". That is exactly
  // how this assertion failed the first time it ran, and the product was right both times.
  const p2 = (n) => String(n).padStart(2, "0");
  const d0 = new Date(); d0.setDate(d0.getDate() + 1);
  const iso = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}T15:00`;
  await page.locator('[data-testid="push-at"]').fill(iso);
  // The field really holds it — a fill that silently no-ops would fake this whole section.
  eq("  the push-date field holds the value that was typed",
     await page.locator('[data-testid="push-at"]').inputValue(), iso);
  await page.locator('[data-testid="save"]').click();
  await page.waitForTimeout(3000);

  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  const planned = await page.locator('[data-testid="match-tile"][data-state="planned"]').count();
  eq("after reload the match persisted as PLANNED", planned > 0, true);

  // CLEAR THE DATE — the state that must survive as NULL, not "".
  await page.locator('[data-testid="match-tile"][data-state="planned"]').first().click();
  await page.waitForSelector('[data-testid="panel"]');
  await page.locator('[data-testid="push-at"]').fill("");
  await page.locator('[data-testid="save"]').click();
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "domcontentloaded" });
  await ready(page);
  eq("after clearing the date the tile reads NEEDS A DECISION",
     await page.locator('[data-testid="match-tile"][data-state="needs-decision"]').count() > 0, true);

  // AND IT IS SQL NULL IN THE DATABASE, not an empty string.
  const { data: probe } = await svc.from("match_promotion_plan").select("*").eq("promo_code", "E2E-PROBE");
  eq("a row was actually written", (probe ?? []).length > 0, true);
  eq("push_at is SQL NULL, not an empty string", (probe ?? []).every((r) => r.push_at === null), true);
  eq("…and the channels survived the clear", (probe ?? []).every((r) => r.wa === true), true);

  // The audit entry exists — the finance recorder's own table.
  const { data: log } = await svc.from("fin_change_log").select("row_id,before_json,after_json")
    .eq("table_name", "match_promotion_plan");
  eq("the write was recorded in fin_change_log", (log ?? []).length > 0, true);

  // CLEAN UP every row this suite created — INCLUDING its audit entries. Retaining history is the
  // right default for a real change, but fin_change_log is a table Ryan reads, and a suite that
  // runs on every push would otherwise silt it up with probes.
  const probeIds = (probe ?? []).map((r) => r.match_api_id);
  for (const id of probeIds) await svc.from("match_promotion_plan").delete().eq("match_api_id", id);
  for (const id of probeIds) await svc.from("fin_change_log").delete().eq("table_name", "match_promotion_plan").eq("row_id", id);
  const left = (await svc.from("match_promotion_plan").select("match_api_id").eq("promo_code", "E2E-PROBE")).data ?? [];
  eq("no probe rows remain", left.length, 0);
  const leftLog = (await svc.from("fin_change_log").select("id").eq("table_name", "match_promotion_plan").in("row_id", probeIds)).data ?? [];
  eq("no probe audit entries remain either", leftLog.length, 0);
  void probeMatch; void iso;

}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
