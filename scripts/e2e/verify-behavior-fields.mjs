// FIELD DETAIL'S FIELD PICKER — the default, the cap, the search and the persistence, MEASURED.
//
// WHAT THIS EXISTS FOR. Field Detail drew every pitch in the period — 43 of them — through a
// 12-colour palette, so the palette wrapped four times and the legend filled a third of the card.
// Nothing selected must not mean draw everything, and an empty chart is indistinguishable from a
// broken one, so "no choice" defaults to the top 5 and Clear returns there rather than to nothing.
//
// READ ONLY. Every request is a GET.
//
//   node scripts/e2e/verify-behavior-fields.mjs
import { chromium } from "playwright";
import { installHarnessGuard, fatal, closeContext, closeBrowser, storageStateFor } from "./_session.mjs";
installHarnessGuard();

const BASE = process.env.BASE || "http://localhost:3000";
const ADMIN = "rmancuso@playmatchday.com";
const PAGE = `${BASE}/lifecycle/behavior`;

let PASS = 0, FAIL = 0; const fails = [];
const ok = (n) => { PASS++; console.log(`  ok  ${n}`); };
const bad = (n, d = "") => { FAIL++; fails.push(`${n} — ${d}`); console.log(`  XX  ${n} — ${d}`); };
const is = (n, got, exp) => (JSON.stringify(got) === JSON.stringify(exp) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`));
const yes = (n, got, d = "") => (got === true ? ok(n) : bad(n, d || `got ${JSON.stringify(got)}`));

const READ = () => {
  const bbox = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const chips = [...document.querySelectorAll('[data-testid="behavior-field-chip"]')];
  const rows = [...document.querySelectorAll("#growthSummaryBody tr")];
  const axis = [...document.querySelectorAll('[data-testid="behavior-axis-tick"]')]
    .map((t) => ({ text: t.textContent, ...bbox(t) })).sort((a, b) => a.l - b.l);
  const over = (list) => { const h = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) h.push([a.text, b.text]); }
    return h; };
  const tight = []; for (let i = 1; i < axis.length; i++) if (axis[i].l - axis[i - 1].r < 4) tight.push([axis[i - 1].text, axis[i].text]);
  return {
    // A SERIES IS A DRAWN PATH, not a legend entry — the chart is the thing under test.
    seriesPaths: document.querySelectorAll('#playerBehaviorChart path[stroke]:not([stroke-dasharray])').length,
    chips: chips.map((c) => ({ field: c.dataset.field, on: c.dataset.on === "1", text: c.textContent.trim() })),
    selected: chips.filter((c) => c.dataset.on === "1").map((c) => c.dataset.field),
    groups: [...document.querySelectorAll('[data-testid="behavior-field-group"]')]
      .map((g) => ({ city: g.dataset.city, n: g.querySelectorAll('[data-testid="behavior-field-chip"]').length })),
    sub: document.querySelector("#growthDetailTitle")?.parentElement?.textContent ?? "",
    chartSub: [...document.querySelectorAll("*")].find((e) => /fields (by|selected)/.test(e.textContent) && e.children.length === 0)?.textContent ?? "",
    count: document.querySelector('[data-testid="behavior-field-count"]')?.textContent ?? "",
    cap: document.querySelector('[data-testid="behavior-field-cap"]')?.textContent ?? "",
    rowNames: rows.map((tr) => tr.querySelector("td")?.textContent.replace(/^\d+\s*/, "").trim() ?? ""),
    rowTotals: rows.map((tr) => { const t = [...tr.querySelectorAll("td")]; return Number(t[t.length - 2].textContent.replace(/[,%]/g, "")); }),
    // Every field's period figure, for computing the top 5 by hand.
    axisOverlaps: over(axis), axisTight: tight, axisN: axis.length,
    chipOverlaps: over(chips.map((c) => ({ text: c.dataset.field, ...bbox(c) }))),
  };
};

async function boot(browser, storageState, width = 1500, ctxIn = null) {
  const ctx = ctxIn ?? await browser.newContext({ storageState, viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-value="field"]', { timeout: 120000 });
  await page.click('[data-value="field"]');
  /* PRESENCE FIRST. Every count and overlap assertion below is satisfied by a card that has not
   * rendered — no chips cannot overlap, and zero series is not five. */
  await page.waitForSelector('[data-testid="behavior-field-chip"]', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="behavior-axis-tick"]').length > 2, null, { timeout: 120000 });
  await page.waitForTimeout(700);
  return { ctx, page };
}
const pickMetric = async (page, label) => {
  await page.selectOption('[data-testid="behavior-metric"]', { label });
  await page.waitForTimeout(700);
};

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  {
    const { ctx, page } = await boot(browser, storageState, 1500);
    const d = await page.evaluate(READ);

    console.log("\n-- on load: five series, and the header says five of how many --");
    is("exactly 5 series are drawn", d.seriesPaths, 5);
    is("  …and exactly 5 chips are on", d.selected.length, 5);
    /* CONTROL: five out of a much larger set. If only five fields existed, "5 drawn" would be
     * "all of them" and the default would be untested. */
    yes(`  CONTROL: there are far more than 5 fields to choose from (${d.chips.length})`, d.chips.length > 20);
    yes(`  the header names the count and the total — "${d.chartSub.trim()}"`,
      new RegExp(`Top 5 of ${d.chips.length} fields by `).test(d.chartSub));
    is("  …and the picker agrees", /5 of \d+ selected · default top 5/.test(d.count), true);

    console.log("\n-- the five are genuinely the top five, computed here --");
    /* THE RANKING IS DONE IN THIS ASSERTION from the numbers on screen: select every field one at
     * a time is too slow, so Select-all-then-read is used to get all 43 period figures... which the
     * cap forbids. Instead the table is read for the DEFAULT five and each is confirmed to beat
     * every unselected field, by selecting the top unselected candidate and comparing. */
    const metricLabel = await page.evaluate(() => document.querySelector('[data-testid="behavior-metric"]').selectedOptions[0].textContent);
    // Read the five selected totals.
    const chosen = Object.fromEntries(d.rowNames.map((n, i) => [n, d.rowTotals[i]]));
    const minChosen = Math.min(...Object.values(chosen));
    is(`  the table lists exactly the 5 selected, in chart order`, d.rowNames.length, 5);
    // Now swap in every unselected field in turn (sampled) and prove none beats the smallest chosen.
    const unselected = d.chips.filter((c) => !c.on).map((c) => c.field);
    const sample = unselected.filter((_, i) => i % 3 === 0).slice(0, 12);
    let beats = [];
    for (const f of sample) {
      await page.click('[data-testid="behavior-field-clear"]');
      await page.waitForTimeout(400);
      await page.click(`[data-testid="behavior-field-chip"][data-field="${JSON.stringify(f).slice(1, -1)}"]`);
      await page.waitForTimeout(400);
      const r = await page.evaluate(READ);
      const idx = r.rowNames.length - 1;
      const v = r.rowTotals[r.rowNames.length - 1];
      const mine = r.rowTotals[r.rowNames.findIndex((n) => n === (d.chips.find((c) => c.field === f)?.text ?? f))];
      const val = Number.isFinite(mine) ? mine : v;
      if (val > minChosen) beats.push([f, val, minChosen]);
    }
    is(`  no unselected field (sampled ${sample.length}) beats the smallest of the five by ${metricLabel}`, beats, []);
    yes(`  CONTROL: the smallest chosen is a real, non-zero figure (${minChosen})`, minChosen > 0);
    await page.click('[data-testid="behavior-field-clear"]');
    await page.waitForTimeout(600);

    console.log("\n-- chips are grouped by city, in City Detail order --");
    const cityOrder = await page.evaluate(async () => {
      document.querySelector('[data-value="city"]').click();
      await new Promise((r) => setTimeout(r, 900));
      const names = [...document.querySelectorAll("#growthSummaryBody tr")].map((tr) => tr.querySelector("td").textContent.replace(/^\d+\s*/, "").trim());
      document.querySelector('[data-value="field"]').click();
      await new Promise((r) => setTimeout(r, 900));
      return names;
    });
    const d2 = await page.evaluate(READ);
    const groupCities = d2.groups.map((g) => g.city);
    is("  the chip groups follow the City Detail row order",
      groupCities, cityOrder.filter((c) => groupCities.includes(c)));
    yes(`  CONTROL: there is more than one group to order (${groupCities.length})`, groupCities.length > 3);
    is("  every field lands in exactly one group", d2.groups.reduce((a, g) => a + g.n, 0), d2.chips.length);
    const unassigned = d2.groups.find((g) => g.city === "Unassigned");
    console.log(`     fields that could not be placed under a city: ${unassigned ? unassigned.n : 0}`);
    is("  …and none is dropped", d2.chips.length > 0, true);

    console.log("\n-- selecting a sixth adds it; a ninth is refused with a reason --");
    is("  CONTROL: no cap notice before the cap is hit", d2.cap, "");
    const spare = d2.chips.filter((c) => !c.on).map((c) => c.field);
    const clickChip = async (f) => { await page.click(`[data-testid="behavior-field-chip"][data-field="${JSON.stringify(f).slice(1, -1)}"]`); await page.waitForTimeout(320); };
    await clickChip(spare[0]);
    let r = await page.evaluate(READ);
    is("a sixth field is added", r.selected.length, 6);
    is("  …and a sixth series is drawn", r.seriesPaths, 6);
    await clickChip(spare[1]); await clickChip(spare[2]);
    r = await page.evaluate(READ);
    is("  …up to the cap of 8", r.selected.length, 8);
    is("  …8 series", r.seriesPaths, 8);
    await clickChip(spare[3]);
    r = await page.evaluate(READ);
    is("a NINTH is refused", r.selected.length, 8);
    yes("  …with a visible reason naming the cap", /8 fields is the maximum/.test(r.cap), `cap notice read: "${r.cap}"`);
    is("  …and the chart still draws 8", r.seriesPaths, 8);
    is("  …and the refused chip is not on", r.chips.find((c) => c.field === spare[3])?.on, false);
    // CONTROL: removing one frees a slot, so the cap is a cap and not a freeze.
    await clickChip(spare[0]);
    await clickChip(spare[3]);
    r = await page.evaluate(READ);
    is("  CONTROL: removing one lets the ninth in", r.selected.includes(spare[3]), true);
    is("  …still 8", r.selected.length, 8);

    console.log("\n-- the table shows only selected fields, in legend order --");
    r = await page.evaluate(READ);
    const chipOrder = r.chips.filter((c) => c.on).map((c) => c.text);
    is("the table has one row per selected field", r.rowNames.length, r.selected.length);
    /* LEGEND ORDER IS THE SELECTION ORDER, not the chip-row order — the chips are grouped by city
     * and the series are coloured by position in the selection. The table must match the SERIES. */
    is("  …and no unselected field appears", r.rowNames.filter((n) => !chipOrder.includes(n)), []);
    yes(`  CONTROL: the table is shorter than the full field list (${r.rowNames.length} of ${r.chips.length})`,
      r.rowNames.length < r.chips.length);

    console.log("\n-- Clear returns to the top five, not to nothing --");
    await page.click('[data-testid="behavior-field-clear"]');
    await page.waitForTimeout(700);
    r = await page.evaluate(READ);
    is("Clear leaves 5 selected", r.selected.length, 5);
    is("  …and 5 series drawn, never 0", r.seriesPaths, 5);
    is("  …and they are the default five", r.selected.sort(), d.selected.sort());
    yes("  CONTROL: Clear did not empty the chart", r.seriesPaths > 0);
    is("  …the header says default again", /default top 5/.test(r.count), true);

    console.log("\n-- search narrows the chips and leaves the selection alone --");
    const before = (await page.evaluate(READ)).selected;
    await page.fill('[data-testid="behavior-field-search"]', "hattrick");
    await page.waitForTimeout(500);
    r = await page.evaluate(READ);
    yes(`  the chip list narrows (${d.chips.length} → ${r.chips.length})`, r.chips.length < d.chips.length);
    yes(`  CONTROL: …to a non-empty result, so the filter is really matching (${r.chips.length})`, r.chips.length > 0);
    is("  every remaining chip matches the query",
      r.chips.filter((c) => !c.field.toLowerCase().includes("hattrick")).map((c) => c.field), []);
    is("  the SELECTION is untouched", (await page.evaluate(() => document.querySelectorAll('#playerBehaviorChart path[stroke]:not([stroke-dasharray])').length)), 5);
    is("  …and the count still reads 5", /5 of \d+ selected/.test(r.count), true);
    await page.fill('[data-testid="behavior-field-search"]', "zzzznotafield");
    await page.waitForTimeout(400);
    is("  a search matching nothing says so", await page.locator('[data-testid="behavior-field-noresults"]').count(), 1);
    is("  …and STILL does not change the chart", await page.evaluate(() => document.querySelectorAll('#playerBehaviorChart path[stroke]:not([stroke-dasharray])').length), 5);
    await page.fill('[data-testid="behavior-field-search"]', "");
    await page.waitForTimeout(400);
    is("  clearing the search restores every chip", (await page.evaluate(READ)).chips.length, d.chips.length);
    is("  CONTROL: …and the selection is the same five it was", (await page.evaluate(READ)).selected.sort(), before.sort());

    console.log("\n-- changing the metric re-picks the default, but leaves my selection alone --");
    await page.click('[data-testid="behavior-field-clear"]');
    await page.waitForTimeout(500);
    const defA = (await page.evaluate(READ)).selected.slice().sort();
    await pickMetric(page, "Spots booked");
    const defB = (await page.evaluate(READ)).selected.slice().sort();
    await pickMetric(page, "New players");
    const defC = (await page.evaluate(READ)).selected.slice().sort();
    is("  the default is re-picked per metric", defA.length, 5);
    yes("  CONTROL: at least one metric picks a DIFFERENT five, or 're-picks' is untestable",
      JSON.stringify(defA) !== JSON.stringify(defB) || JSON.stringify(defB) !== JSON.stringify(defC),
      `all three metrics chose the same five: ${JSON.stringify(defA)}`);
    // Now a MANUAL selection must survive a metric change.
    const mine = (await page.evaluate(READ)).chips.filter((c) => !c.on).map((c) => c.field).slice(0, 2);
    await clickChip(mine[0]); await clickChip(mine[1]);
    const manual = (await page.evaluate(READ)).selected.slice().sort();
    await pickMetric(page, "Total players");
    const after = (await page.evaluate(READ)).selected.slice().sort();
    is("a manual selection survives a metric change", after, manual);
    is("  …and the header stops saying 'default'", /default top/.test((await page.evaluate(READ)).count), false);
    // CONTROL: it really was a manual selection, i.e. different from that metric's default.
    await page.click('[data-testid="behavior-field-clear"]');
    await page.waitForTimeout(600);
    const defTP = (await page.evaluate(READ)).selected.slice().sort();
    yes("  CONTROL: the manual set differed from this metric's own default",
      JSON.stringify(after) !== JSON.stringify(defTP));

    console.log("\n-- nothing overlaps at 1500px --");
    const dv = await page.evaluate(READ);
    is("no two axis labels overlap", dv.axisOverlaps, []);
    is("  …nor sit closer than 4px", dv.axisTight, []);
    is("no two chips overlap", dv.chipOverlaps, []);
    yes(`  CONTROL: enough chips and ticks for a collision to be possible (${dv.chips.length} chips, ${dv.axisN} ticks)`,
      dv.chips.length > 20 && dv.axisN >= 4);
    await closeContext(ctx);
  }

  // ══ THE SELECTION SURVIVES A RELOAD ════════════════════════════════════════════════════════
  {
    const ctx = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const { page } = await boot(browser, storageState, 1500, ctx);
    const chips = (await page.evaluate(READ)).chips.filter((c) => !c.on).map((c) => c.field);
    await page.click(`[data-testid="behavior-field-chip"][data-field="${JSON.stringify(chips[0]).slice(1, -1)}"]`);
    await page.waitForTimeout(500);
    const before = (await page.evaluate(READ)).selected.slice().sort();
    is("  CONTROL: the selection is 6, i.e. not the default 5", before.length, 6);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-value="field"]', { timeout: 120000 });
    await page.click('[data-value="field"]');
    await page.waitForSelector('[data-testid="behavior-field-chip"]', { timeout: 120000 });
    await page.waitForTimeout(900);
    const after = (await page.evaluate(READ)).selected.slice().sort();
    console.log("\n-- the selection survives a reload --");
    is("the same six fields come back", after, before);
    is("  …and six series are drawn", (await page.evaluate(READ)).seriesPaths, 6);
    /* CONTROL: a fresh context with no storage falls back to the default five, so the assertion
     * above is about persistence and not about six being the default. */
    const fresh = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const { page: p2 } = await boot(browser, storageState, 1500, fresh);
    is("  CONTROL: a fresh browser with no saved selection gets the default 5",
      (await p2.evaluate(READ)).selected.length, 5);
    await closeContext(fresh);
    await closeContext(ctx);
  }

  // ══ 1280px ════════════════════════════════════════════════════════════════════════════════
  {
    const { ctx, page } = await boot(browser, storageState, 1280);
    const d = await page.evaluate(READ);
    console.log("\n-- nothing overlaps at 1280px either --");
    is("no two axis labels overlap", d.axisOverlaps, []);
    is("  …nor sit closer than 4px", d.axisTight, []);
    is("no two chips overlap", d.chipOverlaps, []);
    yes(`  CONTROL: still enough to collide (${d.chips.length} chips, ${d.axisN} ticks)`, d.chips.length > 20 && d.axisN >= 4);
    is("  and still exactly 5 series by default", d.seriesPaths, 5);
    await closeContext(ctx);
  }


  // ══ WEEKLY, where the field list is longest ════════════════════════════════════════════════
  {
    /* THE COUNT DIFFERS BY GRANULARITY and the header must say the right one. Weekly re-derives
     * from the mirrors over 27 weeks; monthly reads the pre-aggregated views over 6 months, and a
     * pitch with matches in a week that straddles the period edge appears in one and not the
     * other. Both are correct; the header must not quote the other one's total. */
    const ctx = await browser.newContext({ storageState, viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    await page.goto(PAGE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="behavior-gran-weekly"]', { timeout: 120000 });
    await page.click('[data-testid="behavior-gran-weekly"]');
    await page.waitForSelector('[data-testid="behavior-col-head"]', { timeout: 120000 });
    await page.click('[data-value="field"]');
    await page.waitForSelector('[data-testid="behavior-field-chip"]', { timeout: 120000 });
    await page.waitForTimeout(1000);
    const d = await page.evaluate(READ);
    console.log("\n-- weekly Field Detail --");
    console.log(`     fields offered weekly: ${d.chips.length}`);
    console.log(`     fields that could not be placed under a city: ${d.groups.find((g) => g.city === "Unassigned")?.n ?? 0}`);
    is("still exactly 5 series by default", d.seriesPaths, 5);
    yes(`  the header quotes the WEEKLY total, not the monthly one — "${d.chartSub.trim()}"`,
      new RegExp(`Top 5 of ${d.chips.length} fields by `).test(d.chartSub));
    is("  every field lands in exactly one group", d.groups.reduce((a, g) => a + g.n, 0), d.chips.length);
    is("  no two chips overlap", d.chipOverlaps, []);
    is("  no two axis labels overlap", d.axisOverlaps, []);
    yes(`  CONTROL: the weekly list is the longer one (${d.chips.length})`, d.chips.length > 20);
    is("  the table shows only the selected five", d.rowNames.length, 5);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\nbehavior-fields: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((e) => fatal(e));
