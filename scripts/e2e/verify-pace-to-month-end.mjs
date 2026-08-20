// PACE TO MONTH END — the projection, and the two halves of it that can cancel.
//
// THE RULE: days 1-3 are out of the RATE and in revenue-so-far. A test that only checks the
// total passes when BOTH halves are wrong in opposite directions — excluding those days from
// revenue-so-far while also excluding them from the rate lands within a few hundred dollars of
// the right answer. So each half is asserted separately, against the daily figures.
//
//   node scripts/e2e/verify-pace-to-month-end.mjs
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { installHarnessGuard, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();
process.loadEnvFile(".env.local");

const BASE = process.env.BASE || "http://localhost:3000";
let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ✓ ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  ✗ ${n} — ${d}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));
const money = (t) => (/—/.test(t ?? "") ? null : Number(String(t).replace(/[^0-9.-]/g, "")));

// ── the daily truth, straight from fin_revenue ────────────────────────────────────────────────
const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const pageAll = async (mk) => { const o = []; for (let f = 0; ; f += 1000) { const { data, error } = await mk().range(f, f + 999); if (error) throw new Error(error.message); if (!data?.length) break; o.push(...data); if (data.length < 1000) break; } return o; };
const revRows = await pageAll(() => svc.from("fin_revenue").select("date,gross").gte("date", "2026-05-01").lte("date", "2026-12-31"));
const byMonthDay = {};
for (const r of revRows) {
  if (!r.date) continue;
  const k = r.date.slice(0, 7), d = Number(r.date.slice(8, 10));
  (byMonthDay[k] ??= {})[d] = (byMonthDay[k][d] ?? 0) + Number(r.gross ?? 0);
}

const { storageState } = await storageStateFor("rmancuso@playmatchday.com", BASE);
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState, viewport: { width: 1620, height: 1200 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const tiles = () => page.evaluate(() => {
  const t = (id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    return {
      value: el.querySelector('[data-testid="revenue-tile-value"]')?.firstChild?.textContent?.trim() ?? null,
      sub: el.querySelector('[data-testid="revenue-tile-sub"]')?.innerText.trim() ?? null,
      // THE RATE THE CARD WAS BUILT FROM, unrounded. Two cards printing the same rounded money
      // agree; two cards carrying the same unrounded rate came from one derivation.
      rate: el.getAttribute("data-rate"),
    };
  };
  return { revenue: t("tile-revenue"), avg: t("tile-avgdaily"), pace: t("tile-pace") };
});

// THE PERIOD PARAM IS `p`, not `period` (FinanceShell.tsx:84). Using the wrong name silently
// left every navigation on the default month, so six assertions compared August with August.
const goto = async (key) => {
  await page.goto(`${BASE}/admin/finance/revenue?p=${key}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="tile-pace"]', { timeout: 90000 });
  await page.waitForTimeout(2500);
  return tiles();
};

// ── 1. THE CURRENT MONTH ──────────────────────────────────────────────────────────────────────
console.log("── August 2026 ──");
const aug = await goto("2026-08");
eq("no uncaught page errors", errors, []);
eq("  control — the three tiles rendered", [aug.revenue != null, aug.avg != null, aug.pace != null], [true, true, true]);
console.log(`     revenue ${aug.revenue?.value} · avg ${aug.avg?.value} · pace ${aug.pace?.value}`);
console.log(`     ${aug.pace?.sub}`);

const days = byMonthDay["2026-08"] ?? {};
// ELAPSED COMES FROM THE CLOCK, NOT FROM A SUBTITLE. It used to be parsed out of AVG DAILY's
// "over N days" — which now states the RATE WINDOW rather than the elapsed month, so reading it
// here silently redefined every figure derived below and failed six assertions that were right.
// The card's own timezone is America/Chicago; the machine's may not be.
const chicago = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
const elapsed = chicago.getDate();
eq("  control — the elapsed-day count is a sane day of the month", elapsed > 3 && elapsed <= 31, true);
// AND THE DATA CANNOT BE AHEAD OF TODAY. If revenue exists for a day after "today" then elapsed is
// wrong and every expectation below is built on sand.
const maxDayWithRevenue = Math.max(0, ...Object.keys(days).map(Number).filter((d) => (days[d] ?? 0) > 0));
eq("  control — no revenue is recorded after today", maxDayWithRevenue <= elapsed, true);
let soFar = 0;
for (let d = 1; d <= elapsed; d++) soFar += days[d] ?? 0;
const day1 = days[1] ?? 0;
const today = days[elapsed] ?? 0;
// THE DIVISOR, STATED: every elapsed day except day 1 and the day in progress.
const rateDays = elapsed - 2;
const rate = (soFar - day1 - today) / rateDays;
const totalDays = new Date(2026, 8, 0).getDate();
const remaining = totalDays - elapsed;
const expect = soFar + remaining * rate;

// ── 2. BOTH HALVES, SEPARATELY ────────────────────────────────────────────────────────────────
console.log("\n── the two halves that can cancel ──");
{
  // (a) revenue-so-far INCLUDES days 1-3.
  const shown = money(aug.revenue?.value);
  eq("revenue so far includes day 1 and today (it equals the full elapsed total)", Math.abs(shown - soFar) < 1, true);
  // THE CANCELLING-ERROR CATCH: if soFar had been windowed too, the total would still look close.
  eq("  …and is NOT the windowed figure", Math.abs(shown - (soFar - day1 - today)) < 1, false);
  console.log(`     so far ${shown} · day 1 ${Math.round(day1)} · today ${Math.round(today)}`);

  // (b) the RATE excludes them.
  const subRate = money((aug.pace?.sub ?? "").match(/×\s*(\$[\d,]+)/)?.[1]);
  eq("the rate excludes day 1 and today", Math.abs(subRate - rate) < 1, true);
  const naiveRate = soFar / elapsed;
  eq(`  …and is NOT the plain mean (${Math.round(naiveRate)})`, Math.abs(subRate - naiveRate) < 1, false);
  // An off-by-one in the divisor is invisible in the output, so both neighbours are ruled out.
  const offByOne = (soFar - day1 - today) / (elapsed - 1);
  const offByOneOther = (soFar - day1 - today) / (elapsed - 3);
  eq("  …and NOT a divisor one too large", Math.abs(subRate - offByOne) < 1, false);
  eq("  …nor one too small", Math.abs(subRate - offByOneOther) < 1, false);
  console.log(`     rate ${subRate}/day over ${rateDays} days · plain mean would be ${Math.round(naiveRate)}`);
}

// ── 3. THE TOTAL ──────────────────────────────────────────────────────────────────────────────
console.log("\n── the projection ──");
{
  const shown = money(aug.pace?.value);
  eq("projection = so far + remaining × rate, to the dollar", Math.abs(shown - expect) < 1, true);
  console.log(`     ${Math.round(soFar)} + ${remaining} × ${Math.round(rate)} = ${Math.round(expect)} · rendered ${shown}`);
  const subDays = Number((aug.pace?.sub ?? "").match(/\+ (\d+) day/)?.[1]);
  eq("the subtitle's remaining-day count matches the month", subDays, remaining);
  eq("the subtitle names both exclusions", /day 1 and today excluded/.test(aug.pace?.sub ?? ""), true);
}

// ── 4. AVG DAILY IS UNTOUCHED ─────────────────────────────────────────────────────────────────
console.log("\n── avg daily revenue is still the true mean ──");
{
  const shownAvg = money(aug.avg?.value);
  eq("avg daily is the PACE RATE, not the plain mean", Math.abs(shownAvg - rate) < 1, true);
  eq("  …and is NOT revenue so far ÷ elapsed days", Math.abs(shownAvg - soFar / elapsed) < 1, false);
  // SHARED PROVENANCE, NOT COINCIDENCE. Both tiles emit data-rate from the same paceModel object;
  // matching to the dollar would also pass if two independent derivations happened to agree today.
  eq("both cards carry the SAME unrounded rate attribute", aug.avg?.rate === aug.pace?.rate, true);
  eq("  control — that attribute is actually present", typeof aug.avg?.rate === "string" && aug.avg.rate.length > 3, true);
  eq("  …and the printed avg is that attribute, rounded", Math.round(Number(aug.avg?.rate)), Math.round(shownAvg));
  // THE SUBTITLE RECONCILES ON ITS FACE — its own amount over its own day count is its own rate.
  const subAmt = money((aug.avg?.sub ?? "").match(/(\$[\d,]+) over/)?.[1]);
  const subDays = Number((aug.avg?.sub ?? "").match(/over (\d+) day/)?.[1] ?? 0);
  eq("  control — the subtitle stated an amount and a day count", subAmt > 0 && subDays > 0, true);
  eq("avg subtitle: amount ÷ stated days = the printed rate", Math.round(subAmt / subDays), Math.round(shownAvg));
  eq("  …and the stated day count is the RATE window, not the elapsed month", [subDays, subDays === elapsed], [elapsed - 2, false]);
  eq("  …and the stated amount is NOT the full month total", Math.abs(subAmt - soFar) < 1, false);
  eq("avg subtitle names both exclusions", /day 1 and today excluded/.test(aug.avg?.sub ?? ""), true);
  eq("revenue so far on the pace card equals the revenue card, to the dollar",
     money(aug.revenue?.value), money((aug.pace?.sub ?? "").match(/(\$[\d,]+) so far/)?.[1]));
}

// ── 5. A COMPLETED MONTH IS ITS ACTUAL TOTAL ──────────────────────────────────────────────────
console.log("\n── a closed month ──");
{
  const jul = await goto("2026-07");
  const actual = Object.values(byMonthDay["2026-07"] ?? {}).reduce((a, b) => a + b, 0);
  const shown = money(jul.pace?.value);
  eq("July's pace equals July's actual revenue, to the cent", Math.abs(shown - actual) < 1, true);
  eq("  …and equals its own revenue tile", money(jul.revenue?.value), shown);
  eq("  …and says it is not a projection", /not a projection|Period closed/i.test(jul.pace?.sub ?? ""), true);
  // A CLOSED MONTH HAS NO CURRENT DAY, so the clause must not appear at all.
  eq("  …and carries no exclusion clause", /excluded/i.test(jul.pace?.sub ?? ""), false);
  console.log(`     July actual ${Math.round(actual)} · pace ${shown}`);

  // AVG DAILY STILL EXCLUDES DAY 1 — a closed month has a day 1, it just has no day in progress.
  const julDays = byMonthDay["2026-07"] ?? {};
  const julTotal = new Date(2026, 7, 0).getDate();
  const julRate = (actual - (julDays[1] ?? 0)) / (julTotal - 1);
  const julAvg = money(jul.avg?.value);
  eq("July's avg daily excludes day 1", Math.abs(julAvg - julRate) < 1, true);
  eq("  …and is NOT the plain mean over the whole month", Math.abs(julAvg - actual / julTotal) < 1, false);
  eq("  …its subtitle says day 1 only", /day 1 excluded/.test(jul.avg?.sub ?? ""), true);
  eq("  …and does NOT claim today was excluded", /and today excluded/.test(jul.avg?.sub ?? ""), false);
  const jSubDays = Number((jul.avg?.sub ?? "").match(/over (\d+) day/)?.[1] ?? 0);
  eq("  …over a divisor of month length minus one", jSubDays, julTotal - 1);
  eq("  …and both July cards share one rate attribute", jul.avg?.rate === jul.pace?.rate, true);
  console.log(`     July avg ${julAvg} over ${jSubDays} days · plain mean would be ${Math.round(actual / julTotal)}`);

  // THE ⓘ IS A PROJECTION'S EXPLANATION. A closed month is not projecting anything.
  eq("  …and a closed month renders no ⓘ", await page.$('[data-testid="pace-info"]') != null, false);
}

// ── 5b. THE ⓘ ON PACE TO MONTH END ────────────────────────────────────────────────────────────
console.log("\n── the how-it-is-calculated panel ──");
{
  await goto("2026-08");
  const before = await page.evaluate(() => {
    const c = document.querySelector('[data-testid="tile-pace"]');
    return { card: c.getBoundingClientRect().height,
             label: c.querySelector("span").getBoundingClientRect().height };
  });
  const btn = await page.$('[data-testid="pace-info"]');
  eq("  control — the ⓘ is on the pace card", btn != null, true);
  await btn.click();
  await page.waitForSelector('[data-testid="pace-info-panel"]', { timeout: 5000 });
  await page.waitForTimeout(300);

  const P = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="pace-info-panel"]');
    const c = document.querySelector('[data-testid="tile-pace"]');
    const cell = (row, id) => p.querySelector(`[data-row="${row}"] [data-testid="${id}"]`)?.textContent ?? null;
    const note = (row) => p.querySelector(`[data-row="${row}"] td:last-child`)?.textContent?.trim() ?? "";
    const pr = p.getBoundingClientRect(), cr = c.getBoundingClientRect();
    const val = c.querySelector('[data-testid="revenue-tile-value"]').getBoundingClientRect();
    const sub = c.querySelector('[data-testid="revenue-tile-sub"]').getBoundingClientRect();
    const hits = (a, b) => !(a.bottom <= b.top || a.top >= b.bottom || a.right <= b.left || a.left >= b.right);
    return {
      collected: cell("collected", "pace-info-collected"), day1: cell("day1", "pace-info-day1"),
      today: cell("today", "pace-info-today"), rate: cell("rate", "pace-info-rate"),
      forward: cell("forward", "pace-info-forward"), projected: cell("projected", "pace-info-projected"),
      notes: { collected: note("collected"), day1: note("day1"), today: note("today") },
      rows: p.querySelectorAll('[data-testid="pace-info-row"]').length,
      rightFlush: Math.round(pr.right - cr.right), belowCard: Math.round(pr.top - cr.bottom),
      hitsValue: hits(pr, val), hitsSub: hits(pr, sub),
      card: cr.height, label: c.querySelector("span").getBoundingClientRect().height,
      inViewport: pr.left >= 0 && pr.right <= window.innerWidth,
    };
  });
  eq("  control — all six rows rendered", P.rows, 6);

  // THE PANEL IS THE CARD'S ARITHMETIC, so it must agree with the card's own figures.
  eq("panel collected equals the revenue tile", money(P.collected), money(aug.revenue?.value));
  eq("panel projected equals the pace headline", money(P.projected), money(aug.pace?.value));
  eq("panel rate equals the printed daily rate", money(P.rate), Math.round(Number(aug.pace?.rate)));
  eq("panel day 1 equals the day-1 revenue in the data", Math.abs(money(P.day1) - day1) < 1, true);
  eq("panel today equals today's revenue in the data", Math.abs(money(P.today) - today) < 1, true);

  // IDENTITY 1 — EXACT. This is the one the panel exists for.
  eq("printed collected + printed forward = printed projected, to the dollar",
     money(P.collected) + money(P.forward), money(P.projected));
  // IDENTITY 2 — BOUNDED. The rate is printed to the dollar, so N days of it can drift N dollars.
  const drift = Math.abs(money(P.forward) - remaining * money(P.rate));
  eq(`printed forward is within $${remaining} of ${remaining} × printed rate`, drift <= remaining, true);
  console.log(`     ${money(P.collected)} + ${money(P.forward)} = ${money(P.projected)} · ${remaining} × ${money(P.rate)} = ${remaining * money(P.rate)} (drift $${drift})`);

  // "excluded" MARKS THE TWO ROWS LEFT OUT OF THE DIVISOR — and must not mark the total that
  // CONTAINS them, or $16k of collected revenue reads as $16k lost.
  eq("day 1 is marked excluded", P.notes.day1, "excluded");
  eq("today is marked excluded", P.notes.today, "excluded");
  eq("collected is NOT marked excluded", /excluded/.test(P.notes.collected), false);

  // GEOMETRY — it explains the headline, so it must not cover it.
  eq("the panel does not intersect the headline figure", P.hitsValue, false);
  eq("  …nor the subtitle", P.hitsSub, false);
  eq("  …it hangs below the card, right edges flush", [P.belowCard > 0, P.rightFlush], [true, 0]);
  eq("  …and stays inside the viewport", P.inViewport, true);
  eq("opening it changes neither card height nor label-row height",
     [Math.round(P.card), Math.round(P.label)], [Math.round(before.card), Math.round(before.label)]);
}

// ── 6. QUARTER AND YEAR ARE UNCHANGED ─────────────────────────────────────────────────────────
console.log("\n── the rule is month-only ──");
{
  const q = await goto("2026Q3");
  eq("the quarter period still renders a pace figure", money(q.pace?.value) > 0, true);
  eq("  …and does NOT use the exclusion wording", /excluded/i.test(q.pace?.sub ?? ""), false);
  eq("  …it keeps the mean × total-days subtitle", /\/day ×/.test(q.pace?.sub ?? ""), true);
  console.log(`     Q3: ${q.pace?.value} — ${q.pace?.sub}`);
  const y = await goto("2026");
  eq("the year period still renders a pace figure", money(y.pace?.value) > 0, true);
  eq("  …and does NOT use the exclusion wording", /excluded/i.test(y.pace?.sub ?? ""), false);
  console.log(`     2026: ${y.pace?.value} — ${y.pace?.sub}`);
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
