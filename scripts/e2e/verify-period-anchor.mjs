// THE FINANCE PERIOD ANCHOR — `?p=` says which period, `?a=` says where in it you were standing.
//
// WHAT THIS EXISTS TO CATCH. `p` cannot carry a point in time: "2026" is a year, and parsing it back
// had to pick some day, which was always 1 January. That destroyed the anchor `changeGrain` exists
// to carry, so August 2026 → Q3 → 2026 → Month landed on JANUARY 2026. financePeriod.ts:8 has
// claimed since it was written that the zoom is reversible; it was not.
//
// NOTHING HERE IS PINNED TO A LIVE FIGURE. The month names come from the clock, and every revenue
// figure is read off the first screen and compared with a later one.
//
// ── WHAT THIS SUITE CANNOT COVER ──────────────────────────────────────────────────────────────
// The same commit fixes a SECOND defect that this lane structurally cannot see: on a PRODUCTION
// build `/admin/finance/*` is ○ (Static), and on a statically prerendered route `router.replace()`
// to the same pathname with different search params does not navigate — the whole period control,
// both steppers and all three grain buttons, was dead in production. It works in `next dev`, and
// this lane runs against `npm run dev`. That fix was verified by hand against `next build && next
// start`; the procedure is in docs/matchday-api-facts.md. Do not read a green run here as evidence
// the control works in production.

import { chromium } from "playwright";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";

installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let passed = 0;
const failures = [];
const ok = (n) => { passed += 1; console.log(`  ✓ ${n}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const MONTH_FULL = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// TODAY, from the clock — every expectation below is derived from it rather than written down.
const TODAY = new Date();
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY_ISO = ymd(TODAY);
const THIS_MONTH_LABEL = `${MONTH_FULL[TODAY.getMonth()]} ${TODAY.getFullYear()}`;
const THIS_YEAR = TODAY.getFullYear();

const browser = await chromium.launch();
const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const ctx = await browser.newContext({ storageState, viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));

const read = () => page.evaluate(() => ({
  url: location.search,
  label: document.querySelector('[data-testid="period-label"]')?.textContent ?? "",
  tile: document.querySelector('[data-testid="tile-revenue"] [data-testid="revenue-tile-value"]')?.textContent ?? null,
}));

/* WAIT ON WHAT THE PAGE EMITS, NEVER ON A CLOCK. The last suite that held on a timer reported a
 * clean pass against a build with the thing it was testing deleted. Here the signal is the period
 * label plus the revenue tile: the label is the period, and the tile only exists once the section
 * has rendered figures for it. */
const settle = async () => {
  await page.waitForFunction(() => {
    const l = document.querySelector('[data-testid="period-label"]')?.textContent ?? "";
    const t = document.querySelector('[data-testid="tile-revenue"] [data-testid="revenue-tile-value"]')?.textContent ?? "";
    return l.length > 0 && /\d/.test(t);
  }, null, { timeout: 240000 });
};

const go = async (q) => {
  await page.goto(`${BASE}/admin/finance/revenue${q}`, { waitUntil: "domcontentloaded" });
  await settle();
  return read();
};

/** Click, then wait for the LABEL to become what was asked for — a page-emitted signal, not a delay. */
const clickTo = async (testid, wantLabel) => {
  await page.click(`[data-testid="${testid}"]`);
  await page.waitForFunction(
    (w) => (document.querySelector('[data-testid="period-label"]')?.textContent ?? "") === w,
    wantLabel, { timeout: 120000 },
  ).catch(() => {});
  await settle();
  return read();
};

// ── 1. FROM ?p=2026, MONTH MOVES BOTH THE URL AND THE LABEL ───────────────────────────────────
// A URL that changes while the label does not is the same bug in a different costume, so both are
// asserted. This is also the shape Ryan reported: the button appeared to do nothing at all.
console.log("\n── the grain button moves the period ──");
{
  const before = await go(`?p=${THIS_YEAR}`);
  eq("  control — the year URL renders the year", before.label, String(THIS_YEAR));
  const after = await clickTo("period-grain-month", `${MONTH_FULL[0]} ${THIS_YEAR}`);
  eq("clicking Month changes the URL", after.url !== before.url, true);
  eq("  …and changes the rendered period label", after.label !== before.label, true);
  console.log(`     ${before.url || "(none)"} "${before.label}" → ${after.url} "${after.label}"`);
}

// ── 2. A LINK WITH NO `a` BEHAVES EXACTLY AS IT DID ───────────────────────────────────────────
// Every bookmark and shared URL predates the param. Absent `a` must mean "the period's start",
// which is what the code did before it existed — asserted by showing the two are indistinguishable.
console.log("\n── an old link with no `a` is unchanged ──");
{
  const bare = await go(`?p=${THIS_YEAR}`);
  const explicit = await go(`?p=${THIS_YEAR}&a=${THIS_YEAR}-01-01`);
  eq("no `a` renders the same period as `a` at the period's start", bare.label, explicit.label);
  eq("  …and the same figure", bare.tile, explicit.tile);
  // AND IT NARROWS THE SAME WAY: to January, the period's start. This is the OLD behaviour and it
  // is deliberately preserved for links that cannot carry an anchor.
  await go(`?p=${THIS_YEAR}`);
  const narrowed = await clickTo("period-grain-month", `${MONTH_FULL[0]} ${THIS_YEAR}`);
  eq("  …and narrowing an un-anchored year still lands on January", narrowed.label, `${MONTH_FULL[0]} ${THIS_YEAR}`);
}

// ── 3. AN ANCHORED YEAR NARROWS TO THE ANCHOR'S MONTH ─────────────────────────────────────────
console.log("\n── an anchored year narrows to the anchor's month ──");
{
  // The figure this must NOT show: January's.
  const jan = await go(`?p=${THIS_YEAR}-01`);
  eq("  control — January carries a figure of its own", /\d/.test(jan.tile ?? ""), true);
  // The figure it MUST show, read off the current month's own screen.
  const thisMonth = await go(`?p=${ymd(TODAY).slice(0, 7)}`);
  eq("  control — this month carries a figure of its own", /\d/.test(thisMonth.tile ?? ""), true);
  eq("  control — the two months' figures differ (so the next line can tell them apart)",
    jan.tile !== thisMonth.tile, true);

  await go(`?p=${THIS_YEAR}&a=${TODAY_ISO}`);
  const landed = await clickTo("period-grain-month", THIS_MONTH_LABEL);
  eq(`an anchored year narrows to ${THIS_MONTH_LABEL}, not ${MONTH_FULL[0]}`, landed.label, THIS_MONTH_LABEL);
  eq("  …and shows that month's figure", landed.tile, thisMonth.tile);
  eq("  …not January's", landed.tile === jan.tile, false);
}

// ── 4. THE FULL ROUND TRIP ────────────────────────────────────────────────────────────────────
// Month → Quarter → Year → Month, back to where it started. This is what financePeriod.ts:8 has
// always claimed. The figure is read off the FIRST screen, never written down.
console.log("\n── Month → Quarter → Year → Month ──");
{
  const start = await go("");
  eq("  control — the default period is this month", start.label, THIS_MONTH_LABEL);
  eq("  control — …carrying a figure", /\d/.test(start.tile ?? ""), true);

  const q = await clickTo("period-grain-quarter", `Q${Math.floor(TODAY.getMonth() / 3) + 1} ${THIS_YEAR}`);
  eq("  → quarter moved the period", q.label !== start.label, true);
  // THE ANCHOR IS IN THE URL. This is the line the mutation removes.
  eq(`  …and the URL now carries a=${TODAY_ISO}`, new URLSearchParams(q.url).get("a"), TODAY_ISO);

  const y = await clickTo("period-grain-year", String(THIS_YEAR));
  eq("  → year moved the period", y.label, String(THIS_YEAR));
  eq(`  …and still carries a=${TODAY_ISO}`, new URLSearchParams(y.url).get("a"), TODAY_ISO);

  const back = await clickTo("period-grain-month", THIS_MONTH_LABEL);
  eq("the round trip returns to the starting month", back.label, start.label);
  eq("  …with the starting figure", back.tile, start.tile);
}

// ── 5. NAVIGATION RESETS THE ANCHOR; ONLY GRAIN PRESERVES IT ──────────────────────────────────
console.log("\n── steppers and This-month reset the anchor ──");
{
  const from = await go(`?p=${ymd(TODAY).slice(0, 7)}&a=${TODAY_ISO}`);
  eq("  control — an anchored current month renders", from.label, THIS_MONTH_LABEL);

  // ‹ PREV sets the anchor to the NEW period's start, not to the day carried in.
  await page.click('[data-testid="period-prev"]');
  await page.waitForFunction((b) => (document.querySelector('[data-testid="period-label"]')?.textContent ?? "") !== b, from.label, { timeout: 120000 });
  await settle();
  const prev = await read();
  const prevA = new URLSearchParams(prev.url).get("a");
  eq("‹ prev moves the period", prev.label !== from.label, true);
  eq("  …and resets the anchor to the new period's first day", prevA?.slice(-2), "01");
  eq("  …in the period it moved to", prevA?.slice(0, 7), new URLSearchParams(prev.url).get("p"));

  // THIS MONTH sets the anchor to today — which is the default period, so both params drop away.
  const jump = await clickTo("period-jump", THIS_MONTH_LABEL);
  eq("This month returns to the current month", jump.label, THIS_MONTH_LABEL);
  eq("  …and the default period carries a clean URL", jump.url, "");
  // PROOF THAT THE ANCHOR CAME BACK TO TODAY, not to the 1st: widen, and read it out of the URL.
  const widened = await clickTo("period-grain-year", String(THIS_YEAR));
  eq("  …and the anchor it reset to is today", new URLSearchParams(widened.url).get("a"), TODAY_ISO);
}

// ── 6. POSITIVE CONTROL — A GRAIN CHANGE THAT SHOULD MOVE THE PERIOD DOES ─────────────────────
// Everything above that asserts "unchanged" or "returned to" needs this: the same click sequence,
// arranged so the period MUST move, proving these assertions can read a change at all.
console.log("\n── positive control ──");
{
  await go("");
  await page.click('[data-testid="period-prev"]');
  await page.waitForFunction((b) => (document.querySelector('[data-testid="period-label"]')?.textContent ?? "") !== b, THIS_MONTH_LABEL, { timeout: 120000 });
  await settle();
  const stepped = await read();
  eq("  control — the stepper moved off the current month", stepped.label !== THIS_MONTH_LABEL, true);
  const grained = await clickTo("period-grain-year", String(THIS_YEAR));
  eq("a grain change after a step DOES move the period", grained.label !== stepped.label, true);
  eq("  …and its figure differs too", grained.tile !== stepped.tile, true);
  // The stepper reset the anchor to that month's 1st, so widening carries THAT, not today.
  eq("  …carrying the anchor the stepper set, not today",
    new URLSearchParams(grained.url).get("a") === TODAY_ISO, false);
}

// ── 7. A CONTRADICTORY PAIR CLAMPS RATHER THAN BUILDING A PERIOD THE URL DOES NOT DESCRIBE ─────
console.log("\n── a stale `a` on a changed `p` ──");
{
  const clamped = await go(`?p=${THIS_YEAR}Q1&a=${TODAY_ISO}`);
  eq("  control — the quarter in `p` is what renders", clamped.label, `Q1 ${THIS_YEAR}`);
  const narrowed = await clickTo("period-grain-month", `${MONTH_FULL[0]} ${THIS_YEAR}`);
  eq("an out-of-period anchor clamps to the period's start", narrowed.label, `${MONTH_FULL[0]} ${THIS_YEAR}`);
}

eq("no uncaught page errors", errors, []);

console.log(`\n================ RESULT ================`);
console.log(`Assertions: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  ${f}`);
}
await closeContext(ctx);
await closeBrowser(browser);
process.exit(failures.length ? 1 : 0);
