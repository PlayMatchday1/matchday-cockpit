// THE MONTH VIEW'S CELLS AND PRICES — MEASURED IN A REAL BROWSER.
//
// month-and-copy-test.ts pins the CSS text and the priceLabel transform. Neither can answer the
// questions this suite exists for, because both are questions about LAYOUT: does a cell actually
// scroll, are cells in a row actually the same height, does a price actually fit. A stylesheet
// saying `min-height` proves nothing about the box the browser built from it.
//
// EVERY STRUCTURAL ASSERTION RUNS ON A FIXTURE, and the fixture is shaped to make the assertions
// discriminating: three week rows whose busiest days hold 3, 21 and 7 matches, so "rows differ"
// has something to differ about, and prices covering 1500 / 800 / 3900 / 0 / null.
//
// NOTHING IS WRITTEN. Every request is a GET and the range fetch is intercepted. The final phase
// drops the intercept to measure the REAL September page height, which is a read.
//
//   node scripts/e2e/verify-month-cells.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor , nonEmpty } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/match-ops/master-schedule`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

/* ── THE FIXTURE ───────────────────────────────────────────────────────────────────────────────
 * September 2026. The range is Sep 1 – Sep 20 so the grid is exactly three week rows, which keeps
 * the row comparison readable. Busiest day per row: 3, then 21, then 7.
 *
 * 21 IS NOT ARBITRARY — it is the real maximum, measured on production for 2026-09-08. The point
 * of the change is that a day like that shows all 21. */
const FROM = "2026-09-01", TO = "2026-09-20";
const PEAK_DAY = "2026-09-08";   // 21 matches — the row this suite is really about
const QUIET_DAY = "2026-09-02";  //  3 matches
const MID_DAY = "2026-09-15";    //  7 matches

/* PRICES, IN CENTS, INCLUDING THE TWO THAT MUST NOT LOOK ALIKE. `null` renders nothing; `0`
 * renders $0.00. Both are real: production carries 347 zero-price matches and no null ones, so the
 * null case is defensive — and a defensive branch nobody exercises is a branch nobody has tested. */
const PRICE_NULL_ID = 5001;
const PRICE_ZERO_ID = 5002;
const PRICE_1500_ID = 5003;
const PRICE_800_ID = 5004;
const PRICE_3900_ID = 5005;

// A LONG FIELD NAME, so there is something for the narrow-viewport truncation control to bite on.
const LONG_FIELD = "Northeast Metropolitan Park Complex Field 7";
const SHORT_FIELD = "PARMER";

function fixture() {
  const matches = [];
  let id = 6000;
  const add = (date, venue, price, apiId) => {
    const n = matches.filter((m) => m.date === date).length;
    matches.push({
      apiId: apiId ?? id++, city: "Austin", date,
      time: `${6 + (n % 6)}:00 PM`, minutes: (18 + (n % 6)) * 60,
      venue, fieldRaw: venue, name: `Match ${apiId ?? id}`, rawName: `Match ${apiId ?? id}`,
      veo: false, hasEmoji: false, price,
    });
  };
  // ROW 1 — quiet. 3 on the 2nd, 1 on the 4th. Carries the five price cases.
  add(QUIET_DAY, LONG_FIELD, null, PRICE_NULL_ID);
  add(QUIET_DAY, LONG_FIELD, 0, PRICE_ZERO_ID);
  add(QUIET_DAY, LONG_FIELD, 1500, PRICE_1500_ID);
  add("2026-09-04", SHORT_FIELD, 800, PRICE_800_ID);
  // ROW 2 — the peak. 21 on the 8th, plus a couple of neighbours.
  for (let i = 0; i < 21; i++) add(PEAK_DAY, i === 0 ? SHORT_FIELD : LONG_FIELD, i === 0 ? 3900 : 1200, i === 0 ? PRICE_3900_ID : undefined);
  add("2026-09-10", LONG_FIELD, 900);
  add("2026-09-10", LONG_FIELD, 900);
  // ROW 3 — middling. 7 on the 15th.
  for (let i = 0; i < 7; i++) add(MID_DAY, LONG_FIELD, 500);
  return {
    from: FROM, to: TO, today: "2026-09-01", matches,
    cities: ["Austin"], fields: [LONG_FIELD, SHORT_FIELD].sort(),
    dataAsOf: "2026-09-01T06:00:00.000Z", generatedAt: "2026-09-01T12:00:00.000Z",
  };
}
const FIX = fixture();
const TOTAL = FIX.matches.length;
const NULL_PRICED = FIX.matches.filter((m) => m.price == null).length;

/* ── MEASUREMENT, RUN IN THE PAGE ──────────────────────────────────────────────────────────────
 * One evaluate returning everything, so every number in a comparison came from the same layout.
 * Measuring twice around an await invites a reflow between the two halves. */
const MEASURE = () => {
  const cells = [...document.querySelectorAll('[data-testid="month-cell"]')];
  const weeks = [...document.querySelectorAll(".vms-mweek")];
  const px = (el) => Math.round(el.getBoundingClientRect().height * 100) / 100;
  return {
    matchCount: document.querySelectorAll('[data-testid="month-match"]').length,
    priceCount: document.querySelectorAll('[data-testid="month-price"]').length,
    // A CELL THAT SCROLLS has more content than box. This is the assertion, not the CSS text.
    overflowing: cells.filter((c) => {
      const list = c.querySelector(".vms-mlist");
      return c.scrollHeight > c.clientHeight + 1 || (list && list.scrollHeight > list.clientHeight + 1);
    }).map((c) => c.dataset.iso),
    // Heights per week row, and the distinct heights within each row.
    rows: weeks.map((w) => {
      const cs = [...w.querySelectorAll('[data-testid="month-cell"]')].map(px);
      return { height: px(w), cells: cs, distinct: [...new Set(cs)].length, max: Math.max(...cs) };
    }),
    // Every entry's box, to prove "visible" rather than merely "in the DOM".
    entries: [...document.querySelectorAll('[data-testid="month-match"]')].map((b) => {
      const r = b.getBoundingClientRect();
      const cell = b.closest('[data-testid="month-cell"]').getBoundingClientRect();
      return {
        id: Number(b.dataset.id), h: Math.round(r.height), w: Math.round(r.width),
        // INSIDE ITS CELL, top and bottom. An entry clipped by an overflow:hidden ancestor is in
        // the DOM, has a box, and is not on the screen.
        contained: r.top >= cell.top - 1 && r.bottom <= cell.bottom + 1,
      };
    }),
    prices: [...document.querySelectorAll('[data-testid="month-price"]')].map((e) => ({
      id: Number(e.closest('[data-testid="month-match"]').dataset.id),
      text: e.textContent,
      // TRUNCATION, MEASURED. scrollWidth beyond clientWidth means the text does not fit.
      clipped: e.scrollWidth > e.clientWidth + 1,
      ellipsis: getComputedStyle(e).textOverflow === "ellipsis",
    })),
    fieldsClipped: [...document.querySelectorAll('[data-testid="month-match"] span')]
      .filter((s) => s.scrollWidth > s.clientWidth + 1).length,
    pageHeight: document.documentElement.scrollHeight,
    gridHeight: document.querySelector('[data-testid="month-grid"]')
      ? Math.round(document.querySelector('[data-testid="month-grid"]').getBoundingClientRect().height) : 0,
  };
};

async function boot(browser, storageState, { intercept = true, width = 1600, from = FROM, to = TO, expect = TOTAL } = {}) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 1000 } });
  if (intercept) {
    await ctx.route("**/api/veo/range**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIX) }));
  }
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  /* THE VIEW IS REACHED BY CLICKING THE TAB, not by seeding localStorage. Seeding was tried and
   * does not work: the component's save effect writes the CURRENT view back on mount and wins the
   * race, so the page came up in the week view having quietly discarded the seed. Clicking is also
   * what an operator does. */
  await page.waitForSelector('[data-testid="view-month"]', { timeout: 60000 });
  await page.click('[data-testid="view-month"]');
  await page.waitForSelector('[data-testid="month-bar"]', { timeout: 60000 });
  // The range, through the real date inputs. They are not under test here — they are how you get
  // a month on screen.
  await page.fill('[data-testid="month-from"]', from);
  await page.fill('[data-testid="month-to"]', to);
  /* A PRESENCE WAIT BEFORE ANY MEASUREMENT OR ABSENCE CHECK. A loading screen has no cells that
   * overflow, no rows of unequal height and no truncated prices — it satisfies most of this suite.
   * The range read against real production data takes well over ten seconds on a cold route, which
   * is why this waits on the CONTENT and never on a timer. */
  await page.waitForSelector('[data-testid="month-grid"]', { timeout: 120000 });
  await page.waitForFunction(
    (t) => { const n = document.querySelectorAll('[data-testid="month-match"]').length;
             return t ? n === t : n > 0; },
    expect, { timeout: 120000 });
  await page.waitForTimeout(600); // let fonts settle before measuring boxes
  return { ctx, page };
}

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  // ══ 1. EVERY MATCH PRESENT, VISIBLE, AND NOTHING SCROLLING INSIDE ═══════════════════════════
  {
    const { ctx, page } = await boot(browser, storageState);
    const m = await page.evaluate(MEASURE);

    console.log(`\n-- every match in every day, no cell scrolling (fixture: ${TOTAL} matches) --`);
    is("every fixture match is in the DOM", m.matchCount, TOTAL);
    is("  …including all 21 on the peak day",
      await page.locator(`[data-iso="${PEAK_DAY}"] [data-testid="month-match"]`).count(), 21);
    is("  …and the day's count badge agrees",
      await page.locator(`[data-iso="${PEAK_DAY}"] [data-testid="month-daycount"]`).textContent(), "21");
    is("NO CELL SCROLLS INSIDE ITSELF", m.overflowing, []);
    is("every entry has a real box", nonEmpty(m.entries, "m.entries").filter((e) => e.h > 0 && e.w > 0).length, TOTAL);
    is("every entry is inside its own cell, not clipped by it", nonEmpty(m.entries, "m.entries").filter((e) => !e.contained).map((e) => e.id), []);

    /* CONTROL FOR THE OVERFLOW CHECK. "No cell overflows" is the answer a broken measurement gives
     * too. Force the old fixed height back onto the peak cell IN THE PAGE and prove the same code
     * reports it. Nothing is saved; the next reload is clean. */
    const caught = await page.evaluate((iso) => {
      const cell = document.querySelector(`[data-iso="${iso}"]`);
      const list = cell.querySelector(".vms-mlist");
      cell.style.height = "126px"; list.style.overflowY = "auto"; list.style.flex = "1"; list.style.minHeight = "0";
      const seen = cell.scrollHeight > cell.clientHeight + 1 || list.scrollHeight > list.clientHeight + 1;
      cell.style.height = ""; list.style.overflowY = ""; list.style.flex = ""; list.style.minHeight = "";
      return seen;
    }, PEAK_DAY);
    yes("  CONTROL: restoring height:126px on that cell IS detected as overflow", caught,
      "the overflow probe cannot see a scrolling cell — every 'no overflow' result above is worthless");
    is("  CONTROL: …and removing it again leaves no overflow", (await page.evaluate(MEASURE)).overflowing, []);

    console.log("\n-- cells in a row are equal; rows differ when their busiest day differs --");
    is("the grid is three week rows", m.rows.length, 3);
    for (let i = 0; i < m.rows.length; i++) {
      is(`  row ${i + 1}: all seven cells are the same height (${m.rows[i].max}px)`, m.rows[i].distinct, 1);
    }
    /* THE CONTROL FOR EQUALITY IS INEQUALITY ELSEWHERE. If the measurement returned a constant —
     * or every cell were still a fixed 126px — "all equal within a row" would pass everywhere and
     * mean nothing. These must differ, and in the order the fixture dictates. */
    const [r1, r2, r3] = m.rows.map((r) => r.max);
    yes(`  CONTROL: the 21-match row is taller than the 7-match row (${r2} > ${r3})`, r2 > r3);
    yes(`  CONTROL: the 7-match row is taller than the 3-match row (${r3} > ${r1})`, r3 > r1);
    is("  CONTROL: …so the three rows are three different heights", new Set([r1, r2, r3]).size, 3);
    yes(`  the peak row is several hundred pixels, as expected (${r2}px)`, r2 > 400);

    console.log("\n-- the price --");
    is(`prices render on every match that has one (${TOTAL} − ${NULL_PRICED} null)`, m.priceCount, TOTAL - NULL_PRICED);
    is("1500 cents renders $15.00", m.prices.find((p) => p.id === PRICE_1500_ID)?.text, "$15.00");
    // CONTROL: not a hardcoded string — three more cents values, three more answers.
    is("  CONTROL: 800 renders $8.00", m.prices.find((p) => p.id === PRICE_800_ID)?.text, "$8.00");
    is("  CONTROL: 3900 renders $39.00", m.prices.find((p) => p.id === PRICE_3900_ID)?.text, "$39.00");
    is("  CONTROL: 1200 renders $12.00", m.prices.find((p) => p.text === "$12.00") ? "$12.00" : "missing", "$12.00");
    is("a ZERO price renders $0.00", m.prices.find((p) => p.id === PRICE_ZERO_ID)?.text, "$0.00");
    is("a NULL price renders NOTHING — no price element at all",
      await page.locator(`[data-id="${PRICE_NULL_ID}"] [data-testid="month-price"]`).count(), 0);
    /* CONTROL FOR THE ABSENCE. A missing price element and a missing MATCH look identical to that
     * count. The null-priced entry must be on the page, and its two siblings must have prices. */
    is("  CONTROL: …but the null-priced match IS rendered", await page.locator(`[data-id="${PRICE_NULL_ID}"]`).count(), 1);
    is("  CONTROL: …and its neighbours DO carry prices",
      await page.locator(`[data-id="${PRICE_ZERO_ID}"] [data-testid="month-price"]`).count(), 1);
    yes("  null and zero do not look the same", m.prices.find((p) => p.id === PRICE_ZERO_ID)?.text === "$0.00"
      && (await page.locator(`[data-id="${PRICE_NULL_ID}"] [data-testid="month-price"]`).count()) === 0);

    is("NO price is truncated at 1600px", nonEmpty(m.prices, "m.prices").filter((p) => p.clipped).map((p) => p.text), []);
    is("  …and none carries an ellipsis rule", nonEmpty(m.prices, "m.prices").filter((p) => p.ellipsis).length, 0);
    await closeContext(ctx);
  }

  // ══ 2. THE PRICE STILL DOES NOT TRUNCATE WHERE TRUNCATION ACTUALLY HAPPENS ══════════════════
  {
    /* 1600px proves nothing — nothing truncates at 1600px. The claim is about a NARROW cell, so
     * the browser is narrowed until the field is demonstrably clipped, and only then is the price
     * asked whether it survived. */
    const { ctx, page } = await boot(browser, storageState, { width: 900 });
    const m = await page.evaluate(MEASURE);
    console.log("\n-- the price never truncates, checked where it could (900px viewport) --");
    yes(`  CONTROL: the viewport is narrow enough that FIELD names are clipped (${m.fieldsClipped} of them)`,
      m.fieldsClipped > 0,
      "nothing is truncating at this width, so 'the price is not truncated' is not being tested");
    is("  CONTROL: …by an ellipsis, as designed",
      await page.locator('[data-testid="month-match"] span').first().evaluate((e) => getComputedStyle(e).textOverflow), "ellipsis");
    is("NO price is truncated at 900px either", nonEmpty(m.prices, "m.prices").filter((p) => p.clipped).map((p) => p.text), []);
    is("  …every price still reads in full", nonEmpty(m.prices, "m.prices").filter((p) => /^\$\d+\.\d{2}$/.test(p.text)).length, m.prices.length);
    is("  …and $39.00 in particular is whole", m.prices.find((p) => p.id === PRICE_3900_ID)?.text, "$39.00");
    await closeContext(ctx);
  }

  // ══ 3. CLICKING STILL OPENS THE EDITOR; FILTERING STILL NARROWS ═════════════════════════════
  {
    const { ctx, page } = await boot(browser, storageState);
    console.log("\n-- the editor and the field filter, both untouched by this change --");
    // ABSENCE FIRST, so "the drawer opened" is a transition and not a thing that was always there.
    is("  CONTROL: no drawer before the click", await page.locator('[data-testid="drawer"]').count(), 0);
    await page.click(`[data-id="${PRICE_1500_ID}"]`);
    await page.waitForSelector('[data-testid="drawer"]', { timeout: 30000 });
    is("clicking a match opens the editor", await page.locator('[data-testid="drawer"]').count(), 1);
    await page.click('[data-testid="dr-close"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="drawer"]').length === 0, null, { timeout: 20000 });

    const before = await page.evaluate(MEASURE);
    // Filter to the SHORT field, which the fixture gives only 2 matches.
    await page.click(`[data-testid="month-field"][data-field="${SHORT_FIELD}"]`);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="month-match"]').length < n,
      before.matchCount, { timeout: 20000 });
    const after = await page.evaluate(MEASURE);
    yes(`filtering to one field narrows the grid (${before.matchCount} → ${after.matchCount})`, after.matchCount < before.matchCount);
    is("  CONTROL: …and does not empty it", after.matchCount > 0, true);
    is("  …it leaves exactly that field's matches", after.matchCount, FIX.matches.filter((x) => x.venue === SHORT_FIELD).length);
    const bp = before.rows.map((r) => r.max), ap = after.rows.map((r) => r.max);
    yes(`the peak row SHRINKS when its matches are filtered out (${bp[1]} → ${ap[1]})`, ap[1] < bp[1]);
    yes("  …and every row is no taller than before", ap.every((h, i) => h <= bp[i] + 1));
    is("  CONTROL: the rows had different heights to shrink FROM", new Set(bp).size > 1, true);
    await closeContext(ctx);
  }

  // ══ 4. THE REAL SEPTEMBER PAGE, UNFILTERED — HOW TALL IT ACTUALLY IS ════════════════════════
  {
    /* NO INTERCEPT. This reads the live range endpoint (a GET) so the number reported is the page
     * the operator will actually get, not the page the fixture describes. */
    const { ctx, page } = await boot(browser, storageState,
      { intercept: false, from: "2026-09-01", to: "2026-09-30", expect: null });
    /* THE COUNT MUST STOP MOVING before anything is measured. `expect: null` only waited for the
     * first match to appear; a height read mid-render is a height of a page that does not exist. */
    await page.waitForFunction(() => {
      const n = document.querySelectorAll('[data-testid="month-match"]').length;
      const prev = window.__mcPrev; window.__mcPrev = n;
      return prev != null && prev === n && n > 0;
    }, null, { timeout: 120000, polling: 1000 });
    await page.waitForTimeout(1200);
    const m = await page.evaluate(MEASURE);
    console.log("\n== REAL SEPTEMBER 2026, UNFILTERED ==");
    console.log(`   matches rendered          ${m.matchCount}`);
    console.log(`   prices rendered           ${m.priceCount}   (null-priced: ${m.matchCount - m.priceCount})`);
    console.log(`   week rows                 ${m.rows.length}`);
    console.log(`   row heights (px)          ${m.rows.map((r) => r.max).join(", ")}`);
    const busiest = await page.evaluate(() => [...document.querySelectorAll(".vms-mweek")].map((w) =>
      Math.max(0, ...[...w.querySelectorAll('[data-testid="month-daycount"]')].map((s) => Number(s.textContent)))));
    console.log(`   busiest day per row       ${busiest.join(", ")}`);
    console.log(`   MONTH GRID HEIGHT         ${m.gridHeight} px`);
    console.log(`   FULL PAGE HEIGHT          ${m.pageHeight} px   (${(m.pageHeight / 1000).toFixed(1)} screens at 1000px)`);
    is("  the real page has no scrolling cell either", m.overflowing, []);
    is("  every row is internally equal on real data", nonEmpty(m.rows, "m.rows").filter((r) => r.distinct !== 1).length, 0);
    is("  no price truncates on real data", nonEmpty(m.prices, "m.prices").filter((p) => p.clipped).length, 0);
    yes("  CONTROL: this really is a month of real matches, not the fixture", m.matchCount > 100 && m.matchCount !== TOTAL);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\nmonth-cells: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((e) => fatal(e));
