import "server-only"; // no-op under --conditions=react-server
// FINANCE › EXPENSES › RECURRING — ONE WINDOW, THREE READOUTS, ONE NUMBER.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/recurring-window-test.ts
//
// THE BUG THIS ENDS. The page had TWO period controls: the header picker (Month/Quarter/Year) and
// a QUARTER row inside the grid. The grid obeyed the second, every label obeyed the first, and
// nothing reconciled them. With the header on August 2026:
//
//   the Marketing chip read $12,971   (Jul $4,850 + Aug $5,721 + Sep $2,400 — the QUARTER)
//   the header said August            ($5,721)
//   the TOTAL column summed the quarter, so pre-July rows displayed real May and June money
//     and totalled $0.00 — correct for the window it summed, wrong for the row it sat on.
//
// So this suite does not check a layout. It checks that the CHIP, the sum of the ROW TOTALS and
// the BOOKED TOTAL are three views of ONE number, for every grain. They were not, and nothing
// caught it.

import {
  buildColumns, buildRecurringSeries, columnTotals, windowTotal, isContextOnly, monthOrd,
} from "../src/lib/recurringExpenses";
import type { FinExpense } from "../src/lib/useFinanceData";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

let id = 0;
const row = (month: string, category: string, city: string | null, vendor: string | null, amount: number): FinExpense => ({
  id: `e${++id}`, date: `${month.split(" ")[1]}-01-01`, month, city, category, vendor,
  amount, notes: null, manual_entry: true,
} as unknown as FinExpense);

/* THE REAL SHAPE OF THE DEFECT, as fixtures. Marketing is booked in every month May..Sep, with
 * the per-city May/June rows that used to total $0.00 while displaying real money. */
const ROWS: FinExpense[] = [
  // Pre-window per-city Marketing — the rows that rendered $0.00 against visible figures.
  row("May 2026", "Marketing", "Atlanta", null, 310),
  row("May 2026", "Marketing", "Austin", null, 155),
  row("Jun 2026", "Marketing", "Atlanta", null, 310),
  row("Jun 2026", "Marketing", "Austin", null, 155),
  // In-quarter Marketing, one vendor line that spans the whole quarter.
  row("Jul 2026", "Marketing", null, "Agency", 4850),
  row("Aug 2026", "Marketing", null, "Agency", 5721),
  row("Sep 2026", "Marketing", null, "Agency", 2400),
  // A second category so the chip sum is not trivially the grand total.
  row("Aug 2026", "Corporate Salaries", null, "Payroll", 1000),
  row("Jul 2026", "Corporate Salaries", null, "Payroll", 1000),
];
const NOW_ORD = monthOrd("Aug 2026");

/** The three readouts, for a given header window. */
function readouts(months: string[], category?: string) {
  const cols = buildColumns(months);
  const rows = category ? ROWS.filter((r) => r.category === category) : ROWS;
  const series = buildRecurringSeries(rows, cols, NOW_ORD);
  const chip = ROWS
    .filter((r) => months.includes(r.month) && (!category || r.category === category))
    .reduce((s, r) => s + Number(r.amount), 0);
  const rowTotals = series.reduce((s, sr) => s + sr.rowTotal, 0);
  const booked = windowTotal(series);
  const colSum = columnTotals(series, cols)
    .filter((_, i) => !cols[i].context)
    .reduce((s, v) => s + v, 0);
  return { chip, rowTotals, booked, colSum, cols, series };
}

console.log("RECURRING — WINDOW AGREEMENT\n");

// ── 1. MONTH: the exact case in the report ─────────────────────────────────────────────────────
console.log("month — August 2026");
{
  const r = readouts(["Aug 2026"], "Marketing");
  is("the Marketing chip is August only", r.chip, 5721);
  is("…and is NOT the quarter figure", r.chip === 12971, false);
  is("the sum of row totals agrees", r.rowTotals, r.chip);
  is("the BOOKED TOTAL agrees", r.booked, r.chip);
  is("the visible month columns agree", r.colSum, r.chip);
  ok(`  (all three: $${r.chip.toLocaleString()})`);
}

// ── 2. CONTEXT COLUMNS ARE NEVER IN A TOTAL ────────────────────────────────────────────────────
console.log("\ncontext columns");
{
  const r = readouts(["Aug 2026"], "Marketing");
  const ctx = r.cols.filter((c) => c.context).map((c) => c.month);
  is("two context months precede August", ctx, ["Jun 2026", "Jul 2026"]);
  is("CONTROL — a context column carries money", columnTotals(r.series, r.cols)[1] > 0, true);
  is("…and it is still excluded from the booked total", r.booked, 5721);
}

// ── 3. A ROW WHOSE ONLY MONEY IS CONTEXT IS NOT ZERO ───────────────────────────────────────────
console.log("\ncontext-only rows");
{
  const r = readouts(["Aug 2026"], "Marketing");
  const atlanta = r.series.find((s) => s.city === "Atlanta");
  if (!atlanta) { bad("the Atlanta row is present"); }
  else {
    ok("the Atlanta row is present");
    is("its window total is 0", atlanta.rowTotal, 0);
    is("…but it is flagged context-only, not zero", isContextOnly(atlanta), true);
    const agency = r.series.find((s) => s.vendor === "Agency")!;
    is("CONTROL — a row with in-window money is NOT context-only", isContextOnly(agency), false);
  }
}

// ── 4. QUARTER AND YEAR — the same rule, no special case ───────────────────────────────────────
console.log("\nquarter and year");
{
  const q = readouts(["Jul 2026", "Aug 2026", "Sep 2026"], "Marketing");
  is("the quarter chip is the three months", q.chip, 12971);
  is("row totals agree", q.rowTotals, q.chip);
  is("booked total agrees", q.booked, q.chip);
  const y = readouts(
    ["Jan 2026","Feb 2026","Mar 2026","Apr 2026","May 2026","Jun 2026",
     "Jul 2026","Aug 2026","Sep 2026","Oct 2026","Nov 2026","Dec 2026"], "Marketing");
  is("the year chip includes May and June", y.chip, 12971 + 930);
  is("row totals agree", y.rowTotals, y.chip);
  is("booked total agrees", y.booked, y.chip);
  is("nothing is context-only in a year window",
    y.series.filter(isContextOnly).length, 0);
}

// ── 5. ACROSS CATEGORIES the three still agree ─────────────────────────────────────────────────
console.log("\nall categories at once");
{
  const r = readouts(["Aug 2026"]);
  is("chip sum equals row totals", r.rowTotals, r.chip);
  is("chip sum equals booked total", r.booked, r.chip);
  ok(`  (August, every category: $${r.chip.toLocaleString()})`);
}

// ── 6. THE FLOOR: context months are not invented below the record start ───────────────────────
console.log("\nrecord floor");
{
  const floor = monthOrd("Jul 2026");
  const cols = buildColumns(["Jul 2026", "Aug 2026", "Sep 2026"], 2, floor);
  is("no context column below the floor", cols.filter((c) => c.context).length, 0);
  is("CONTROL — without a floor there are two", buildColumns(["Jul 2026"], 2).filter((c) => c.context).length, 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
if (pass === 0) { console.log("ZERO ASSERTIONS — that is a failure, not a pass"); process.exit(1); }
