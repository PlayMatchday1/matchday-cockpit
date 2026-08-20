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
const elapsed = Number((aug.avg?.sub ?? "").match(/over (\d+) day/)?.[1] ?? 0);
eq("  control — the elapsed-day count was readable", elapsed > 3, true);
let soFar = 0, first3 = 0;
for (let d = 1; d <= elapsed; d++) { soFar += days[d] ?? 0; if (d <= 3) first3 += days[d] ?? 0; }
const rateDays = elapsed - 3;
const rate = (soFar - first3) / rateDays;
const totalDays = new Date(2026, 8, 0).getDate();
const remaining = totalDays - elapsed;
const expect = soFar + remaining * rate;

// ── 2. BOTH HALVES, SEPARATELY ────────────────────────────────────────────────────────────────
console.log("\n── the two halves that can cancel ──");
{
  // (a) revenue-so-far INCLUDES days 1-3.
  const shown = money(aug.revenue?.value);
  eq("revenue so far includes days 1–3 (it equals the full elapsed total)", Math.abs(shown - soFar) < 1, true);
  eq(`  …and is NOT the days-4-onward figure`, Math.abs(shown - (soFar - first3)) < 1, false);
  console.log(`     so far ${shown} · days 1–3 are ${Math.round(first3)} of it`);

  // (b) the RATE excludes them.
  const subRate = money((aug.pace?.sub ?? "").match(/×\s*(\$[\d,]+)/)?.[1]);
  eq("the rate is the days-4-onward rate", Math.abs(subRate - rate) < 1, true);
  const naiveRate = soFar / elapsed;
  eq(`  …and NOT the plain mean (${Math.round(naiveRate)})`, Math.abs(subRate - naiveRate) < 1, false);
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
  eq("the subtitle states the exclusion", /days 1–3 excluded/.test(aug.pace?.sub ?? ""), true);
}

// ── 4. AVG DAILY IS UNTOUCHED ─────────────────────────────────────────────────────────────────
console.log("\n── avg daily revenue is still the true mean ──");
{
  const shownAvg = money(aug.avg?.value);
  eq("avg daily is revenue so far ÷ elapsed days, days 1–3 included", Math.abs(shownAvg - soFar / elapsed) < 1, true);
  eq("  …so the two cards deliberately disagree", Math.abs(shownAvg - rate) > 100, true);
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
  console.log(`     July actual ${Math.round(actual)} · pace ${shown}`);
}

// ── 6. QUARTER AND YEAR ARE UNCHANGED ─────────────────────────────────────────────────────────
console.log("\n── the rule is month-only ──");
{
  const q = await goto("2026Q3");
  eq("the quarter period still renders a pace figure", money(q.pace?.value) > 0, true);
  eq("  …and does NOT use the days 1–3 wording", /days 1–3 excluded/.test(q.pace?.sub ?? ""), false);
  eq("  …it keeps the mean × total-days subtitle", /\/day ×/.test(q.pace?.sub ?? ""), true);
  console.log(`     Q3: ${q.pace?.value} — ${q.pace?.sub}`);
  const y = await goto("2026");
  eq("the year period still renders a pace figure", money(y.pace?.value) > 0, true);
  eq("  …and does NOT use the days 1–3 wording", /days 1–3 excluded/.test(y.pace?.sub ?? ""), false);
  console.log(`     2026: ${y.pace?.value} — ${y.pace?.sub}`);
}

await closeContext(ctx);
await closeBrowser(browser);
console.log(`\n${PASS} passed, ${FAIL} failed`);
if (fails.length) { console.log("\nFAILURES:"); for (const f of fails) console.log("  " + f); }
process.exit(FAIL === 0 ? 0 : 1);
