// PLAYER BEHAVIOR, WEEKLY — the table, the axis and the partial week, MEASURED.
//
// Every assertion here is about something a unit test cannot reach: whether two rendered labels
// overlap, whether a sticky cell is still on screen after scrolling, whether the badge in the DOM
// equals the arithmetic on the cells beside it.
//
// THE DEFECT THIS EXISTS FOR. The final bucket is the week containing today and had one day of
// data in it. It was rendered unmarked and it was what "Latest WoW" compared against, so the panel
// reported -68.4%, -58.6%, -46.6%, -56.0% and -44.4% — one day against seven, on every row.
//
// READ ONLY. Every request is a GET.
//
//   node scripts/e2e/verify-behavior-weekly.mjs
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
const near = (n, got, exp, tol = 0.1) =>
  (Math.abs(got - exp) <= tol ? ok(`${n} (${got})`) : bad(n, `got ${got} want ~${exp}`));

/* THE SCRAPE. One evaluate per measurement, so every number in a comparison came from one layout. */
const READ = () => {
  const heads = [...document.querySelectorAll('[data-testid="behavior-col-head"]')];
  const rows = [...document.querySelectorAll("#growthSummaryBody tr")];
  const bbox = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  const axis = [...document.querySelectorAll('[data-testid="behavior-axis-tick"]')]
    .map((t) => ({ text: t.textContent, ...bbox(t) })).sort((a, b) => a.l - b.l);
  const legend = [...document.querySelectorAll('[data-testid="behavior-legend-item"]')]
    .map((e) => ({ text: e.textContent.trim(), ...bbox(e) }));
  // Two boxes overlap when they intersect on BOTH axes. Legend items wrap, so a pair on different
  // lines shares an x range and is not an overlap — the y test is what makes this correct.
  const overlaps = (list) => {
    const hits = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) hits.push([a.text, b.text]);
    }
    return hits;
  };
  // Adjacent axis labels that are touching, even without strictly intersecting.
  const tight = [];
  for (let i = 1; i < axis.length; i++) if (axis[i].l - axis[i - 1].r < 4) tight.push([axis[i - 1].text, axis[i].text]);
  return {
    caption: document.querySelector("#growthMetricPeriod")?.textContent ?? "",
    heads: heads.map((h) => ({ text: h.childNodes[0]?.textContent?.trim() ?? h.textContent.trim(), partial: h.dataset.partial === "1" })),
    rowNames: rows.map((tr) => tr.querySelector("td")?.textContent.trim() ?? ""),
    // Cell values per row, as numbers, in column order — for computing the change by hand.
    rowCells: rows.map((tr) => [...tr.querySelectorAll("td")].slice(1, -2)
      .map((td) => Number(td.textContent.replace(/[,%]/g, "")))),
    rowChange: rows.map((tr) => [...tr.querySelectorAll("td")].pop().textContent.trim()),
    changeSub: document.querySelector('[data-testid="behavior-change-sub"]')?.textContent ?? "",
    changeTitle: document.querySelector('[data-testid="behavior-change-head"]')?.getAttribute("title") ?? "",
    axis, axisOverlaps: overlaps(axis), axisTight: tight,
    legend, legendOverlaps: overlaps(legend),
    partialSegs: document.querySelectorAll('[data-testid="behavior-partial-seg"]').length,
    partialNote: document.querySelector('[data-testid="behavior-partial-note"]')?.textContent ?? "",
    seriesCount: document.querySelectorAll('[data-testid="behavior-legend-item"]').length,
    gridlines: document.querySelectorAll("#playerBehaviorChart line").length,
  };
};

async function boot(browser, storageState, width = 1500) {
  const ctx = await browser.newContext({ storageState, viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="behavior-gran-weekly"]', { timeout: 120000 });
  await page.click('[data-testid="behavior-gran-weekly"]');
  /* A PRESENCE WAIT ON THE CONTENT, never a sleep. Every overlap and absence check below is
   * satisfied by a chart that has not rendered — no labels cannot collide. */
  await page.waitForSelector('[data-testid="behavior-col-head"]', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="behavior-axis-tick"]').length > 2,
    null, { timeout: 120000 });
  await page.waitForTimeout(700);
  return { ctx, page };
}

async function main() {
  process.loadEnvFile(".env.local");
  const { storageState } = await storageStateFor(ADMIN, BASE);
  const browser = await chromium.launch();

  {
    const { ctx, page } = await boot(browser, storageState, 1500);
    const d = await page.evaluate(READ);

    console.log("\n-- the caption and the columns agree (neither was lying) --");
    const capN = Number(d.caption.match(/^(\d+)/)?.[1]);
    is("the caption's week count equals the columns rendered", d.heads.length, capN);
    yes(`  CONTROL: and that count is a real one, not zero or one (${capN})`, capN > 5);
    /* CONTROL FOR THE WHOLE COMPARISON: the table is WIDER than its window, which is the thing
     * that made this look like truncation. If it were not, the caption/table question could not
     * have arisen and this assertion would be testing nothing. */
    const scroll = await page.evaluate(() => {
      const w = document.querySelector("#growthSummaryHead").closest("div");
      return { sw: w.scrollWidth, cw: w.clientWidth };
    });
    yes(`  CONTROL: the table really does overflow its window (${scroll.sw} > ${scroll.cw})`, scroll.sw > scroll.cw);

    console.log("\n-- no two column headers are the same --");
    const texts = d.heads.map((h) => h.text);
    is("every column header is distinct", texts.length - new Set(texts).size, 0);
    is("  …and none of them is a bare month", texts.filter((t) => /^[A-Z][a-z]{2} \d{4}$/.test(t)), []);
    is("  …they are week ranges", /^[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+$/.test(texts[0]), true);
    /* CONTROL: the duplicate detector is proven to FIRE. The same check run over the same headers
     * truncated to their month — which is exactly what the code used to render — must report
     * duplicates. Without this, "0 duplicates" is also what a broken comparison returns. */
    const asMonths = texts.map((t) => t.slice(0, 3));
    yes(`  CONTROL: the same check finds duplicates in the OLD month-only form (${asMonths.length - new Set(asMonths).size})`,
      asMonths.length - new Set(asMonths).size > 0);

    console.log("\n-- the header matches the chart axis for the same bucket --");
    /* The axis carries the short form of the header: header "Mar 2 – Mar 8", tick "Mar 2". Every
     * printed tick must be the opening of some header, and in the same order. */
    const opens = texts.map((t) => t.split(" – ")[0]);
    const ticks = d.axis.map((a) => a.text);
    is("every axis tick is the start of a rendered column header", ticks.filter((t) => !opens.includes(t)), []);
    is("  …in the same order", ticks.join("|"), opens.filter((o) => ticks.includes(o)).join("|"));
    is("  …and the newest bucket is always labelled", ticks[ticks.length - 1], opens[opens.length - 1]);
    // CONTROL: the tick list is a real subset, not everything and not nothing.
    yes(`  CONTROL: ticks are thinned, not all printed (${ticks.length} of ${opens.length})`,
      ticks.length > 1 && ticks.length < opens.length);

    console.log("\n-- every metric row has a name, and keeps it when the table scrolls --");
    is("no row name is blank", d.rowNames.filter((n) => !n), []);
    is("  …and they are the metric names", d.rowNames.slice(0, 4),
      ["Registrations", "New players", "Total players", "Spots booked"]);
    /* THE ACTUAL BUG. The names were always in the DOM; scrolling right took them off screen.
     * Scroll to the far right and assert the first cell is still within the viewport. */
    const stuck = await page.evaluate(() => {
      const w = document.querySelector("#growthSummaryHead").closest("div");
      w.scrollLeft = w.scrollWidth;
      const cell = document.querySelector("#growthSummaryBody td");
      const r = cell.getBoundingClientRect(), wr = w.getBoundingClientRect();
      return { text: cell.textContent.trim(), visible: r.left >= wr.left - 1 && r.right <= wr.right + 1, pos: getComputedStyle(cell).position };
    });
    is("  the name column is sticky", stuck.pos, "sticky");
    yes("  …so after scrolling to the last week the name is STILL on screen", stuck.visible);
    is("  …and still reads the metric", stuck.text, "Registrations");
    await page.evaluate(() => { document.querySelector("#growthSummaryHead").closest("div").scrollLeft = 0; });

    console.log("\n-- the partial week is marked, and excluded from the change --");
    const partialCols = d.heads.filter((h) => h.partial);
    is("exactly one column is flagged partial", partialCols.length, 1);
    is("  …and it is the LAST one", d.heads[d.heads.length - 1].partial, true);
    is("  the chart draws a dashed tail, one per series", d.partialSegs, d.seriesCount);
    is("  …and names it on the axis", d.partialNote, "partial week");
    is("  the legend says which week is running",
      await page.locator('[data-testid="behavior-legend-partial"]').count(), 1);

    /* THE ARITHMETIC, DONE HERE RATHER THAN TRUSTED. The last two COMPLETE columns are the last
     * two not flagged partial; the badge must equal the percentage change between those cells. */
    const iLast = d.heads.length - 1 - [...d.heads].reverse().findIndex((h) => !h.partial);
    const iPrev = iLast - 1 - [...d.heads.slice(0, iLast)].reverse().findIndex((h) => !h.partial);
    is(`  the two complete columns are ${d.heads[iPrev].text} and ${d.heads[iLast].text}`,
      [d.heads[iPrev].partial, d.heads[iLast].partial], [false, false]);
    for (let r = 0; r < 4; r++) {
      const cells = d.rowCells[r];
      const want = ((cells[iLast] - cells[iPrev]) / cells[iPrev]) * 100;
      const got = Number(d.rowChange[r].replace(/[+%]/g, ""));
      near(`  ${d.rowNames[r]}: badge equals (${cells[iLast]} − ${cells[iPrev]}) / ${cells[iPrev]}`, got, want, 0.15);
    }
    /* CONTROL: the badge must NOT equal the comparison against the partial week. If it did, the
     * assertions above could be passing on a coincidence and the defect would be untouched. */
    const partialCmp = ((d.rowCells[0][d.heads.length - 1] - d.rowCells[0][iLast]) / d.rowCells[0][iLast]) * 100;
    const shown = Number(d.rowChange[0].replace(/[+%]/g, ""));
    yes(`  CONTROL: the badge is NOT the partial comparison (${shown.toFixed(1)}% vs ${partialCmp.toFixed(1)}%)`,
      Math.abs(shown - partialCmp) > 1);
    yes("  CONTROL: …and the partial comparison really is a large negative, as it was in production",
      partialCmp < -20, `partial comparison came out ${partialCmp.toFixed(1)}% — the fixture is not reproducing the defect`);

    console.log("\n-- the change column says which two weeks it compared --");
    yes("the column carries a sub-label naming the pair", /→/.test(d.changeSub));
    yes("  …and the tooltip names both in full", /against/.test(d.changeTitle) && /COMPLETE/.test(d.changeTitle));
    is("  …the pair it names is the pair it used",
      d.changeSub, `${d.heads[iPrev].text.split(" – ")[0]} → ${d.heads[iLast].text.split(" – ")[0]}`);

    console.log("\n-- hover --");
    const box = await page.locator("#playerBehaviorChart").boundingBox();
    is("  CONTROL: nothing is hovered before the pointer moves in",
      await page.locator('[data-testid="behavior-tooltip"]').count(), 0);
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.waitForSelector('[data-testid="behavior-tooltip"]', { timeout: 15000 });
    const hov = await page.evaluate(() => ({
      dots: document.querySelectorAll('[data-testid="behavior-hover-dot"]').length,
      bucket: document.querySelector('[data-testid="behavior-tooltip-bucket"]')?.textContent.trim(),
      text: document.querySelector('[data-testid="behavior-tooltip"]')?.innerText ?? "",
    }));
    is("hovering puts a marker on every series", hov.dots, d.seriesCount);
    yes(`  the tooltip names the WEEK RANGE (${hov.bucket})`, /^[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+/.test(hov.bucket));
    is("  …and it is one of the real buckets", texts.includes(hov.bucket), true);
    for (const s of ["Registrations", "New players", "Total players", "Spots booked"]) {
      is(`  …and gives ${s} a value`, new RegExp(`${s}\\s*\\n?\\s*[\\d,]+`).test(hov.text), true);
    }
    // CONTROL: moving to a different x names a DIFFERENT week — the tooltip tracks the pointer.
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await page.waitForTimeout(300);
    const b2 = await page.evaluate(() => document.querySelector('[data-testid="behavior-tooltip-bucket"]')?.textContent.trim());
    yes(`  CONTROL: a different x names a different week (${hov.bucket} → ${b2})`, b2 !== hov.bucket);
    await page.mouse.move(box.x + box.width / 2, box.y - 200);
    await page.waitForTimeout(300);
    is("  …and leaving the chart clears it", await page.locator('[data-testid="behavior-tooltip"]').count(), 0);

    console.log("\n-- nothing overlaps at 1500px --");
    is("no two axis labels overlap", d.axisOverlaps, []);
    is("  …and none is closer than 4px to its neighbour", d.axisTight, []);
    is("no two series labels overlap", d.legendOverlaps, []);
    yes(`  CONTROL: there are enough labels for a collision to be possible (${d.axis.length} axis, ${d.legend.length} legend)`,
      d.axis.length >= 4 && d.legend.length >= 4);
    /* CONTROL FOR THE OVERLAP DETECTOR ITSELF. Squeeze two legend items onto the same spot in the
     * page and prove the same routine reports them. */
    const detects = await page.evaluate(() => {
      const items = [...document.querySelectorAll('[data-testid="behavior-legend-item"]')];
      const [a, b] = items;
      const prev = b.style.cssText;
      b.style.position = "fixed"; b.style.left = `${a.getBoundingClientRect().left}px`;
      b.style.top = `${a.getBoundingClientRect().top}px`;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const hit = ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom;
      b.style.cssText = prev;
      return hit;
    });
    yes("  CONTROL: the overlap test DOES fire when two labels are stacked", detects,
      "the overlap routine cannot see a collision — every 'no overlap' above is worthless");

    console.log("\n-- gridlines and the baseline --");
    yes(`  the plot has horizontal gridlines (${d.gridlines} lines)`, d.gridlines >= 5);
    const gl = await page.evaluate(() => {
      const l = document.querySelector("#playerBehaviorChart line");
      const cs = getComputedStyle(l);
      return { stroke: cs.stroke, op: cs.strokeOpacity };
    });
    is("  …matched to MembershipActiveChart's ink", gl.stroke, "rgb(0, 51, 38)");
    is("  …and its opacity", gl.op, "0.08");
    await closeContext(ctx);
  }

  // ══ THE NARROW WIDTH, where labels collide if they are going to ════════════════════════════
  {
    const { ctx, page } = await boot(browser, storageState, 1280);
    const d = await page.evaluate(READ);
    console.log("\n-- nothing overlaps at 1280px either --");
    is("no two axis labels overlap", d.axisOverlaps, []);
    is("  …and none is closer than 4px", d.axisTight, []);
    is("no two series labels overlap", d.legendOverlaps, []);
    yes(`  CONTROL: still enough labels to collide (${d.axis.length} axis)`, d.axis.length >= 4);
    is("  the columns are still all distinct here", d.heads.length - new Set(d.heads.map((h) => h.text)).size, 0);
    await closeContext(ctx);
  }

  await closeBrowser(browser);
  console.log(`\nbehavior-weekly: ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
}

main().catch((e) => fatal(e));
