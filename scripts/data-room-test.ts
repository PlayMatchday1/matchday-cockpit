import "server-only"; // no-op under --conditions=react-server
// PLAYER DATA ROOM — the total's window, the heat ceiling, the swap, and what is NOT on screen.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/data-room-test.ts
//
// THE DEFECT THIS EXISTS FOR: a Total column that summed a different window than the columns beside
// it. Austin's visible cells added to 6,712 and the Total said 7,450 — the THIRD total in this app
// to disagree with what is on screen, after the Expenses chip/column/footer and the Membership KPI.
// The fix is not arithmetic, it is that the header now NAMES the window it covers, so the two
// cannot drift without the label being visibly wrong.
//
// ── ONE THING THE BRIEF ASKED FOR THAT IS NOT TRUE, AND IS ASSERTED THE OTHER WAY ────────────
// "assert that a row's total equals the sum of that row's visible cells" holds for the ADDITIVE
// measures and CANNOT hold for the DISTINCT ones. Measured on production, window Feb–Sep 2026,
// row Austin:
//     Spots booked  cells sum 23,577 · total 23,577   equal
//     Players       cells sum  6,712 · total  2,927   NOT equal, and 2,927 is the right answer
// 6,712 counts appearances; 2,927 counts people. A player active in five months is one player and
// five cells. So the equality is asserted for additive measures and the correct BOUNDS are asserted
// for distinct ones — with a positive control that a real case is strictly inside them, because
// "<=" passes trivially on a table where every player appears once.

import {
  pivot, pivotCached, clearCubeCache, cubeCacheSize, configKey,
  windowLabel, totalHeader, isAdditive, ADDITIVE_METRICS, DISTINCT_METRICS,
  swapAxes, canSwap, tableTitle,
  heatRange, heatStep, heatColour, contrastRatio, luminance, hexToRgb,
  planBands, factCacheStats, FACT_FETCH_CONCURRENCY,
  HEAT_STEPS, HEAT_INK, HEAT_MIN_ALPHA,
  type Fact, type PivotConfig, type Metric,
} from "../src/lib/dataRoom";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

console.log("PLAYER DATA ROOM\n");

/* THE FIXTURE. Shaped so the distinct/additive difference is REAL: player 1 plays Austin in four
 * of the eight months, so Austin's distinct count is genuinely smaller than the sum of its cells.
 * Without that, every "<=" below would pass on a table where it could not fail. */
const MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const facts: Fact[] = [];
let fid = 0;
const put = (id: number, city: string, month: string, n = 1) => {
  for (let i = 0; i < n; i++) facts.push({ id, city, field: `${city} Field`, month, cohortIdx: 24290, spots: 1, matches: 1, revenue: 12.5, isNew: month === "2026-02" });
  fid++;
};
// Austin: a regular across four months, plus a distinct newcomer each month.
for (const m of MONTHS.slice(0, 4)) put(1, "Austin", m, 2);
MONTHS.forEach((m, i) => put(100 + i, "Austin", m, 3));
// Houston: everybody plays exactly one month, so distinct === appearances there.
MONTHS.forEach((m, i) => put(200 + i, "Houston", m, 1));
/* A NEW PLAYER WHOSE FIRST MONTH IS LATE IN THE WINDOW. Without one, every fact's isNew fell in
 * Feb, narrowing Feb–Sep to Feb–May removed no new players at all, and the "narrowing lowers it"
 * assertion had nothing to bite on — it read 2 → 2 and failed, correctly. */
facts.push({ id: 300, city: "Austin", field: "Austin Field", month: "2026-07", cohortIdx: 24295, spots: 1, matches: 1, revenue: 12.5, isNew: true });
facts.push({ id: 301, city: "Austin", field: "Austin Field", month: "2026-08", cohortIdx: 24296, spots: 1, matches: 1, revenue: 12.5, isNew: true });
// A row that exists only outside the narrow window, to prove the window actually filters.
put(999, "Warsaw", "2023-05", 4);
void fid;

const CFG = (from: string, to: string, metric: Metric = "Players"): PivotConfig => ({
  rows: ["City"], cols: ["Month"],
  vals: [{ metric, agg: metric === "Players" || metric === "New players" ? "Count" : "Sum" }],
  filters: { from, to, city: "all", field: "all" },
});
const NARROW = ["2026-02", "2026-09"] as const;
const NARROWER = ["2026-02", "2026-05"] as const;

const cellsOf = (t: ReturnType<typeof pivot>, r: string) => t.colKeys.map((c) => t.cells[r]?.[c]?.[0] ?? null);
const sumOf = (t: ReturnType<typeof pivot>, r: string) => cellsOf(t, r).reduce((a: number, b) => a + (b ?? 0), 0);

// ── 1. A ROW'S TOTAL AGAINST ITS VISIBLE CELLS ───────────────────────────────────────────────
console.log("the total column: what it covers, and what it is");
{
  for (const m of ADDITIVE_METRICS) {
    const t = pivot(facts, CFG(NARROW[0], NARROW[1], m));
    for (const r of t.rowKeys) {
      const got = Math.round((t.rowTotals[r]?.[0] ?? 0) * 100) / 100;
      const want = Math.round(sumOf(t, r) * 100) / 100;
      if (got === want) ok(`${m}: ${r} total ${got} === the sum of its visible cells`);
      else bad(`${m}: ${r} total equals the sum of its visible cells`, `total ${got} vs cells ${want}`);
    }
  }
  for (const m of DISTINCT_METRICS) {
    const t = pivot(facts, CFG(NARROW[0], NARROW[1], m));
    for (const r of t.rowKeys) {
      const total = t.rowTotals[r]?.[0] ?? 0;
      const cells = cellsOf(t, r).map((v) => v ?? 0);
      const sum = cells.reduce((a, b) => a + b, 0), max = Math.max(0, ...cells);
      if (total <= sum && total >= max) ok(`${m}: ${r} total ${total} is a distinct count — between its largest cell ${max} and their sum ${sum}`);
      else bad(`${m}: ${r} distinct total is within bounds`, `total ${total}, max ${max}, sum ${sum}`);
    }
  }
  /* POSITIVE CONTROL for those bounds: at least one row must be STRICTLY inside them, or "<=" is
   * passing on a table where a distinct count and a sum happen to be identical. */
  {
    const t = pivot(facts, CFG(NARROW[0], NARROW[1], "Players"));
    const strict = t.rowKeys.filter((r) => (t.rowTotals[r]?.[0] ?? 0) < sumOf(t, r));
    is("control — a row where the distinct total is STRICTLY below the sum of its cells", strict.length > 0, true);
    is("…and it is Austin, the row with a player active in several months", strict.includes("Austin"), true);
    const t2 = pivot(facts, CFG(NARROW[0], NARROW[1], "Players"));
    is("control — and a row where they DO coincide, so the bound is not vacuous",
       (t2.rowTotals["Houston"]?.[0] ?? 0) === sumOf(t2, "Houston"), true);
  }

  /* ── NARROWING THE WINDOW ─────────────────────────────────────────────────────────────────
   * The rule that is always true is that narrowing can NEVER RAISE the total. "Lowers it" is only
   * true when the months removed actually contributed — a window narrowed past nothing leaves the
   * figure alone, and asserting otherwise is asserting a property of the fixture rather than of the
   * code. The first version of this block read 2 → 2 for New players and failed, correctly: every
   * new player in the fixture had joined in February. So: the invariant is asserted for every
   * measure, and a POSITIVE CONTROL asserts it strictly drops for each one, on a fixture built to
   * make that possible. */
  for (const m of [...ADDITIVE_METRICS, ...DISTINCT_METRICS]) {
    const wide = pivot(facts, CFG(NARROW[0], NARROW[1], m));
    const tight = pivot(facts, CFG(NARROWER[0], NARROWER[1], m));
    const w = wide.rowTotals["Austin"]?.[0] ?? 0, n = tight.rowTotals["Austin"]?.[0] ?? 0;
    if (n <= w) ok(`${m}: narrowing Feb–Sep to Feb–May cannot raise Austin's total, ${w} → ${n}`);
    else bad(`${m}: narrowing cannot raise the total`, `${w} → ${n} WENT UP`);
    if (n < w) ok(`  control — and here it strictly drops, so the bound is not vacuous`);
    else bad(`  control — ${m} strictly drops`, `${w} → ${n}; the fixture cannot exercise this`);
  }
  // …and the columns narrow with it, which is the half that was out of step.
  is("the visible columns narrow too", pivot(facts, CFG(NARROWER[0], NARROWER[1])).colKeys.length, 4);
  is("…from eight", pivot(facts, CFG(NARROW[0], NARROW[1])).colKeys.length, 8);
  // A row entirely outside the window is not in the table at all.
  is("a row outside the window is gone", pivot(facts, CFG(NARROW[0], NARROW[1])).rowKeys.includes("Warsaw"), false);
  is("control — it IS there on the wide window", pivot(facts, CFG("2023-01", "2026-09")).rowKeys.includes("Warsaw"), true);
}

// ── 2. THE TOTAL HEADER NAMES ITS WINDOW AND FOLLOWS THE FILTER ──────────────────────────────
console.log("\nthe total header: it names the window, and the window follows the filter");
{
  is("the header is the window, not the word Total", windowLabel("2026-02", "2026-09"), "Feb 2026 – Sep 2026");
  is("a one-month window says one month", windowLabel("2026-07", "2026-07"), "Jul 2026");
  is("a window spanning years says both", windowLabel("2023-04", "2026-09"), "Apr 2023 – Sep 2026");
  is("changing the filter changes the header", totalHeader("2026-02", "2026-05", "Players").window, "Feb 2026 – May 2026");
  is("…and it is a different string from the wider one",
     totalHeader("2026-02", "2026-05", "Players").window !== totalHeader("2026-02", "2026-09", "Players").window, true);
  /* THE HEADER ALSO SAYS WHICH KIND OF TOTAL IT IS. Labelling a distinct count "total" invites
   * exactly the arithmetic that produced 7,450 — adding the cells up and expecting a match. */
  is("an additive measure is headed as a total", totalHeader("2026-02", "2026-09", "Revenue").kind, "sum");
  is("a distinct measure is headed as distinct", totalHeader("2026-02", "2026-09", "Players").kind, "distinct");
  is("New players too", totalHeader("2026-02", "2026-09", "New players").kind, "distinct");
  for (const m of ADDITIVE_METRICS) is(`${m} is additive`, isAdditive(m), true);
  for (const m of DISTINCT_METRICS) is(`${m} is not`, isAdditive(m), false);
  const route = readFileSync("src/app/api/lifecycle/dataroom/route.ts", "utf8");
  if (/totalCol: totalHeader\(cfg\.filters\.from, cfg\.filters\.to/.test(route))
    ok("the header is built from the SAME filters the table is — they cannot drift");
  else bad("the header is built from the same filters", "THE 7,450 BUG CAN COME BACK");
}

// ── 3. SWAP ──────────────────────────────────────────────────────────────────────────────────
console.log("\nswap: the axes exchange and the table retitles itself");
{
  const cfg = CFG(NARROW[0], NARROW[1]);
  const s = swapAxes(cfg)!;
  is("rows become columns", s.cols, ["City"]);
  is("columns become rows", s.rows, ["Month"]);
  is("the measures are untouched", s.vals, cfg.vals);
  is("the filters are untouched", s.filters, cfg.filters);
  is("swapping twice is the identity", swapAxes(s), cfg);
  const before = pivot(facts, cfg), after = pivot(facts, s);
  is("the axes really exchange in the built table", [after.rowKeys.length, after.colKeys.length], [before.colKeys.length, before.rowKeys.length]);
  is("and a cell survives the swap", after.cells["Feb 2026"]?.["Austin"]?.[0], before.cells["Austin"]?.["Feb 2026"]?.[0]);
  // THE TITLE FOLLOWS. A table that keeps its old title after a swap describes a shape it no longer has.
  is("the title names rows by columns", tableTitle(cfg), "Players — City by Month");
  is("…and retitles on swap", tableTitle(s), "Players — Month by City");
  is("the two titles differ", tableTitle(cfg) !== tableTitle(s), true);
  is("no column dim drops the 'by'", tableTitle({ ...cfg, cols: [] }), "Players — City");
  is("a non-count agg is named", tableTitle({ ...cfg, vals: [{ metric: "Revenue", agg: "Average" }] }), "Revenue · Average — City by Month");
  /* SWAP REFUSES RATHER THAN DROPPING A FIELD. Columns holds one; stacked rows hold two. Silently
   * discarding the operator's second field would be worse than a disabled button. */
  is("two-deep rows cannot swap", canSwap({ ...cfg, rows: ["City", "Field"] }), false);
  is("…and swapAxes returns null rather than losing one", swapAxes({ ...cfg, rows: ["City", "Field"] }), null);
  is("one-deep rows can", canSwap(cfg), true);
  const panel = readFileSync("src/components/growth/DataRoomPanel.tsx", "utf8");
  if (/data-testid="dr-swap"/.test(panel)) ok("the Swap button is on the page"); else bad("the Swap button is on the page");
  if (/disabled=\{!swappable\}/.test(panel)) ok("…and disables itself instead of dropping a field"); else bad("…and disables itself");
}

// ── 4. NO SHADE FIGHTS THE TEXT ──────────────────────────────────────────────────────────────
console.log("\nheat: one hue, and the darkest step still reads");
{
  const t = pivot(facts, CFG(NARROW[0], NARROW[1]));
  const { min, max } = heatRange(t);
  is("the scale spans the whole grid, not one row", max > min, true);
  is("…and min is a real cell, not zero-by-default", min > 0, true);
  is("an empty cell is unshaded", heatStep(null, min, max), 0);
  is("the minimum sits on the lightest step", heatStep(min, min, max), 0);
  is("the maximum sits on the darkest", heatStep(max, min, max), HEAT_STEPS - 1);
  is("the lightest step is plain white — an unshaded cell must not look shaded", heatColour(0), "#ffffff");
  is("the alpha ramp starts at zero", HEAT_MIN_ALPHA, 0);
  /* THE CEILING, AS A NUMBER. WCAG AA wants 4.5:1 for body text. Eyeballing a ramp is how a step
   * ends up dark enough to fight the ink on somebody else's monitor. */
  for (let s = 0; s < HEAT_STEPS; s++) {
    const c = contrastRatio(HEAT_INK, heatColour(s));
    if (c >= 4.5) ok(`step ${s} (${heatColour(s)}) reads at ${c}:1`);
    else bad(`step ${s} reads against the ink`, `${c}:1 is below AA's 4.5`);
  }
  const darkest = contrastRatio(HEAT_INK, heatColour(HEAT_STEPS - 1));
  if (darkest >= 7) ok(`the darkest step clears AAA too, at ${darkest}:1`);
  else bad("the darkest step clears AAA", `${darkest}:1`);
  // The ramp must actually get darker — a flat ramp would pass the contrast test and shade nothing.
  const lums = Array.from({ length: HEAT_STEPS }, (_, s) => luminance(...hexToRgb(heatColour(s))));
  is("control — the ramp genuinely darkens", lums.every((v, i) => i === 0 || v < lums[i - 1]), true);
  is("…and the ends are clearly different", lums[0] - lums[HEAT_STEPS - 1] > 0.15, true);
  is("a degenerate grid does not divide by zero", heatStep(5, 5, 5), 0);
}

// ── 5. THE DRAWER, AND 6. NOTHING BELOW THE TOTALS ROW ───────────────────────────────────────
console.log("\nthe drawer is the explanation, and the table ends at the totals row");
{
  const panel = readFileSync("src/components/growth/DataRoomPanel.tsx", "utf8");
  const jsx = panel.slice(panel.indexOf("return ("), panel.indexOf("<style jsx>"));
  for (const t of ["dr-drawer", "dr-drawer-title", "dr-drawer-close", "dr-drawer-export", "dr-drawer-copy", "dr-cell", "dr-total-head", "dr-row-total"])
    if (panel.includes(`data-testid="${t}"`)) ok(`${t} is on the page`); else bad(`${t} is on the page`);
  if (/onClick=\{\(\) => setOpenCell\(\{ r, c: /.test(jsx)) ok("clicking a cell opens the drawer");
  else bad("clicking a cell opens the drawer");
  if (/openCell\?\.r === r && openCell\?\.c === c/.test(jsx)) ok("…and the clicked cell is marked while it is open");
  else bad("…and the clicked cell is marked");
  if (/drSel/.test(jsx)) ok("…with a visible outline, not just state"); else bad("…with a visible outline");
  if (/onClick=\{\(\) => setOpenCell\(null\)\}/.test(jsx)) ok("closing clears it, so no cell stays marked");
  else bad("closing clears it");
  if (/\{openCell && \(/.test(jsx)) ok("the drawer does not exist when no cell is open"); else bad("the drawer is conditional");
  is("the drawer names the cell from the row AND column it came from", /\{openCell\.r\}\{openCell\.c/.test(jsx), true);

  /* NOTHING BELOW THE TOTALS ROW. The drill-down used to be explained by a sentence under the
   * table and the shading by a legend beside it. Both are gone: the drawer opening is the
   * explanation. Asserted on the JSX between the grid and the drawer — the only thing allowed
   * there is a comment. */
  const between = jsx.slice(jsx.indexOf('data-testid="dr-grid"'), jsx.indexOf('data-testid="dr-drawer"'));
  const after = between.slice(between.indexOf("</div>"));
  const stray = after.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ").replace(/\{openCell && \([\s\S]*$/, " ");
  if (!/<p\b|<span\b|<small\b|<footer\b/.test(stray)) ok("no paragraph, note or legend renders below the grid");
  else bad("no note renders below the grid", stray.replace(/\s+/g, " ").slice(0, 160));
  // POSITIVE CONTROL: the pattern DOES fire on markup that has one.
  is("control — the stray-text pattern finds a <p> when there is one", /<p\b/.test('<div/><p>note</p>'), true);
  for (const gone of ["drNote", "drLegend", "heat legend", "Click any", "Rows don't sum", "don’t sum"])
    if (!panel.includes(gone)) ok(`"${gone}" is gone from the panel`); else bad(`"${gone}" is gone`, "it is still rendered");
}

// ── 7. THE MEMO ──────────────────────────────────────────────────────────────────────────────
console.log("\nspeed: the cube is memoised per configuration");
{
  clearCubeCache();
  const cfg = CFG(NARROW[0], NARROW[1]);
  const a = pivotCached(facts, cfg, "k1");
  const b = pivotCached(facts, cfg, "k1");
  is("the first build is a miss", a.hit, false);
  is("the second is a hit", b.hit, true);
  is("…and it is the SAME table object, not an equal one", b.table === a.table, true);
  const s = swapAxes(cfg)!;
  is("a swap is its own cube", pivotCached(facts, s, "k1").hit, false);
  is("…and is cached after the first pass", pivotCached(facts, s, "k1").hit, true);
  is("swapping back costs nothing", pivotCached(facts, cfg, "k1").hit, true);
  /* KEYED ON THE FACT TABLE TOO. The facts are cached per warm instance and rebuilt when a new
   * participation month lands; without this key a stale cube would outlive the data it came from. */
  is("a new fact table invalidates every cube", pivotCached(facts, cfg, "k2").hit, false);
  is("a different window is a different cube", pivotCached(facts, CFG(NARROWER[0], NARROWER[1]), "k1").hit, false);
  is("a different measure is a different cube", pivotCached(facts, CFG(NARROW[0], NARROW[1], "Revenue"), "k1").hit, false);
  is("the config key is order-sensitive where it must be", configKey(cfg) === configKey(s), false);
  // BOUNDED. An operator dragging fields around would otherwise hold every cube for the life of
  // the instance.
  clearCubeCache();
  for (let i = 0; i < 40; i++) pivotCached(facts, { ...cfg, filters: { ...cfg.filters, city: `c${i}` } }, "k1");
  if (cubeCacheSize() <= 24) ok(`the cache is bounded — 40 configs left ${cubeCacheSize()} entries`);
  else bad("the cache is bounded", `${cubeCacheSize()} entries`);
  const route = readFileSync("src/app/api/lifecycle/dataroom/route.ts", "utf8");
  if (/pivotCached\(F\.facts, cfg, F\.key\)/.test(route)) ok("the route serves the memoised cube");
  else bad("the route serves the memoised cube");
}

// ── 8. WHAT WAS KEPT ─────────────────────────────────────────────────────────────────────────
console.log("\nkept: the presets, Export, every dimension and every measure");
{
  const panel = readFileSync("src/components/growth/DataRoomPanel.tsx", "utf8");
  for (const p of ["Players by city by month", "Spots per player by field", "Revenue by cohort year", "New players by city", "Field by month"])
    if (panel.includes(p)) ok(`preset "${p}" kept`); else bad(`preset "${p}" kept`);
  for (const d of ["City", "Field", "Month", "Year", "Cohort year", "Cohort month"])
    if (new RegExp(`"${d}"`).test(panel)) ok(`dimension ${d} kept`); else bad(`dimension ${d} kept`);
  for (const m of [...ADDITIVE_METRICS, ...DISTINCT_METRICS])
    if (panel.includes(`"${m}"`) || panel.includes(`${m}:`)) ok(`measure ${m} kept`); else bad(`measure ${m} kept`);
  if (/data-testid="dr-export"/.test(panel)) ok("Export kept on the table"); else bad("Export kept");
  if (/mode: "tableCsv"/.test(panel)) ok("…and still builds the CSV server-side"); else bad("…still server-side");
  /* STACKED ROWS STAY, because something uses them: the "Field by month" preset is rows
   * ["City","Field"]. They live in the chip strip like any other field. */
  if (/rows: \["City", "Field"\]/.test(panel)) ok("stacked rows are still reachable — a preset uses them");
  else bad("stacked rows are still reachable", "the preset that uses them would break");
  if (/data-testid="dr-chip-row"/.test(panel)) ok("…and they render as chips, not a hidden list");
  else bad("…and they render as chips");
}

// ── 9. THE PARTITIONED COLD FETCH ────────────────────────────────────────────────────────────
console.log("\nthe cold fetch: eight bands that cover the id space exactly once");
{
  /* THE COLD START WAS 15.4s AND THE CUBE MEMO NEVER TOUCHED IT — that made SWAPPING fast, not
   * OPENING. Sequential keyset is an index seek per page (~147ms) but SEQUENTIAL BY CONSTRUCTION:
   * every page needs the previous page's last id, so 151,654 rows is 152 round trips in a row.
   * Partitioning into 8 bands is the same seek with the waiting overlapped: 16,588ms -> 2,996ms,
   * verified against a sequential fetch of the LIVE table as identical — same count, same rows,
   * same sha256 after sort, same id endpoints (14 .. 303745).
   *
   * A FASTER FETCH THAT DROPS A PARTITION BOUNDARY IS THE WORST OUTCOME AVAILABLE HERE, and the
   * live comparison cannot run in the fast set. So the BAND MATHS is pinned here instead: every id
   * in [min, max] must fall in exactly one band. */
  is("×8 is what ships, not ×12", FACT_FETCH_CONCURRENCY, 8);

  const coversExactlyOnce = (min: number, max: number, n: number) => {
    const bands = planBands(min, max, n);
    for (let id = min; id <= max; id++) {
      const hits = bands.filter((b) => id > b.after && id <= b.upto).length;
      if (hits !== 1) return { ok: false, id, hits, bands };
    }
    return { ok: true, bands };
  };
  for (const [min, max, n] of [
    [1, 100, 8], [14, 303745 % 977, 8], [0, 7, 8], [1, 8, 8], [1, 9, 8], [5, 5, 8],
    [1, 1000, 4], [1, 1000, 1], [100, 103, 8], [-5, 5, 8], [1, 33, 7],
  ] as [number, number, number][]) {
    const r = coversExactlyOnce(min, max, n);
    if (r.ok) ok(`[${min}..${max}] over ${n} bands: every id in exactly one band (${r.bands.length} bands)`);
    else bad(`[${min}..${max}] over ${n} bands`, `id ${r.id} is in ${r.hits} bands — A ROW WOULD BE ${r.hits === 0 ? "DROPPED" : "DUPLICATED"}`);
  }
  // THE ENDS ARE THE PART THAT BREAKS. The first band must reach below the minimum (the query is
  // `> after`), and the last must reach the maximum exactly.
  for (const [min, max, n] of [[14, 303745, 8], [1, 100, 8], [7, 7000, 3]] as [number, number, number][]) {
    const b = planBands(min, max, n);
    is(`[${min}..${max}] first band starts below the minimum`, b[0].after, min - 1);
    is(`[${min}..${max}] last band ends exactly at the maximum`, b[b.length - 1].upto, max);
    is(`[${min}..${max}] bands are contiguous`, b.every((x, i) => i === 0 || x.after === b[i - 1].upto), true);
  }
  is("an empty range plans nothing rather than a bad band", planBands(5, 4, 8).length, 0);
  is("a single id still gets a band that contains it", planBands(9, 9, 8).length >= 1 ? planBands(9, 9, 8)[0].upto : -1, 9);
  is("…whose lower bound is below it", planBands(9, 9, 8)[0].after, 8);
  is("more bands than ids does not produce empty bands", planBands(1, 3, 8).every((b) => b.upto > b.after), true);

  // ── THE COLD/WARM COUNTER. "What fraction of visits hit a cold instance" was unanswerable —
  // not hard, unanswerable: a module-level cache with no counter and no log line.
  const s0 = factCacheStats(false);
  for (const k of ["cold", "coldBuilds", "warmServes", "bootedAt", "lastBuildMs", "concurrency"])
    if (k in s0) ok(`the counter reports ${k}`); else bad(`the counter reports ${k}`);
  is("it reports the concurrency actually in force", s0.concurrency, FACT_FETCH_CONCURRENCY);
  is("cold is whatever the caller was told, not a guess", factCacheStats(true).cold, true);
  const route = readFileSync("src/app/api/lifecycle/dataroom/route.ts", "utf8");
  if (/coldBuilds > buildsBefore/.test(route)) ok("cold is decided by the build counter MOVING across the call");
  else bad("cold is decided by the counter moving", "a boolean set by hand would drift from the truth");
  if (/Server-Timing/.test(route) && /facts;dur=/.test(route)) ok("…and rides on Server-Timing, readable without parsing a body");
  else bad("…rides on Server-Timing");
  const lib = readFileSync("src/lib/dataRoom.ts", "utf8");
  if (/\[dataroom\] fact table BUILT/.test(lib))
    ok("every rebuild logs itself, so a week of traffic answers the question");
  else bad("every rebuild logs itself");

  /* ── SINGLE FLIGHT, WHICH THE COUNTER IS WHAT FOUND ───────────────────────────────────────
   * The first browser open after the counter shipped read coldBuilds: 2 — the page fires the pivot
   * request and another moments later, BOTH landed before the first build finished, and each
   * fetched all 151,654 rows. One instance paying the cold cost twice, in parallel, on every cold
   * open, with nothing wrong on screen to show for it. After the fix: coldBuilds 1, joinedBuild 1. */
  if (/if \(inFlight\) \{ joinedBuild\+\+; return inFlight; \}/.test(lib))
    ok("a caller arriving mid-build joins it instead of starting a second full fetch");
  else bad("a caller arriving mid-build joins it", "ONE COLD OPEN WOULD FETCH 151,654 ROWS TWICE");
  if (/inFlight = buildFacts\(sb, key\)\.finally\(\(\) => \{ inFlight = null; \}\)/.test(lib))
    ok("…and the in-flight slot is released even if the build throws");
  else bad("…the in-flight slot is released on failure", "one failed build would wedge the instance forever");
  is("the counter reports how many joined", "joinedBuild" in s0, true);
  /* THE STALENESS CHECK MUST SURVIVE THE SINGLE FLIGHT. An earlier version of it returned `cache`
   * before reading the key at all — faster, and wrong: a warm instance would serve last month's
   * facts until it was recycled. The key read is the contract. */
  const gf = lib.slice(lib.indexOf("export async function getFacts"), lib.indexOf("async function buildFacts"));
  if (/select\("match_month"\)/.test(gf)) ok("getFacts still reads the max month on EVERY call");
  else bad("getFacts reads the max month on every call", "A NEW MONTH WOULD NEVER INVALIDATE THE CACHE");
  if (/cache && cache\.key === key/.test(gf)) ok("…and only serves the cache when the key still matches");
  else bad("…only serves the cache when the key matches");
  const keyIdx = gf.indexOf("const key ="), cacheIdx = gf.indexOf("warmServes++");
  if (keyIdx >= 0 && keyIdx < cacheIdx) ok("…reading the key BEFORE any early return, not after");
  else bad("…reading the key before any early return", "the cache would be returned unchecked");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
