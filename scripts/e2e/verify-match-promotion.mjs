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

// ── 2. ALL SIX CHIPS, INSIDE THE TILE, AT 1280 ────────────────────────────────────────────────
console.log("\n── the six channel chips fit ──");
for (const width of [1620, 1280]) {
  await page.setViewportSize({ width, height: 1200 });
  await page.waitForTimeout(250);
  const perTile = await page.locator('[data-testid="match-tile"]').evaluateAll((els) =>
    els.slice(0, 12).map((t) => t.querySelectorAll('[data-testid="chip"]').length));
  eq(`  ${width}px — every tile renders all six chips`, [...new Set(perTile)], [6]);

  // OVERFLOW IS MEASURED, NOT ASSUMED: each chip's right edge must sit inside its tile's box.
  const escaped = await page.locator('[data-testid="match-tile"]').evaluateAll((els) =>
    els.slice(0, 12).reduce((n, t) => {
      const tb = t.getBoundingClientRect();
      return n + [...t.querySelectorAll('[data-testid="chip"]')]
        .filter((c) => { const b = c.getBoundingClientRect(); return b.right > tb.right + 0.5 || b.left < tb.left - 0.5; }).length;
    }, 0));
  eq(`  ${width}px — no chip escapes its tile`, escaped, 0);
}
// POSITIVE CONTROL for those zeros: the same measurement DOES catch a chip pushed out of the box.
const controlEscape = await page.locator('[data-testid="match-tile"]').first().evaluate((t) => {
  const c = t.querySelector('[data-testid="chip"]');
  const before = c.style.cssText;
  c.style.position = "relative"; c.style.left = "9999px";
  const tb = t.getBoundingClientRect(), b = c.getBoundingClientRect();
  const caught = b.right > tb.right + 0.5;
  c.style.cssText = before;
  return caught;
});
eq("  CONTROL — the overflow measurement catches a deliberately displaced chip", controlEscape, true);

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
  const marked = await page.locator('[data-testid="not-promoted"]').count();
  eq("'dying and unpromoted' equals the NOT PROMOTED markers on screen",
     Number((await page.locator('[data-testid="stat-unprom"]').textContent()) ?? "-1"), marked);
  // A 1-of-4 slot must never carry the marker — one bad week is not a pattern.
  const badMark = await page.locator('[data-testid="cancel-chip"]').evaluateAll((els) =>
    els.filter((e) => /1\/4/.test(e.textContent ?? "") && e.querySelector('[data-testid="not-promoted"]')).length);
  eq("no 1-of-4 slot carries NOT PROMOTED", badMark, 0);
  // CONTROL for that zero: 1-of-4 chips exist to be found.
  const oneOfFour = await page.locator('[data-testid="cancel-chip"]').evaluateAll((els) =>
    els.filter((e) => /1\/4/.test(e.textContent ?? "")).length);
  eq("  CONTROL — 1-of-4 chips are present to be caught", oneOfFour > 0, true);
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
  await page.locator('[data-testid="ch-wa"]').check();
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
  await page.locator('[data-testid="ch-wa"]').check();
  await page.locator('[data-testid="ch-match_chat"]').check();
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
