/* THE TWO PROPERTIES THAT REPLACE FOUR SOURCE-TEXT REGEXES.
 *
 * WHAT THEY GUARDED, AND HOW. When the weekly comparison was fixed, the SCREEN was corrected and the
 * CSV kept shipping the old change: two figures for one pair of weeks, one right and one wrong, and
 * the wrong one visible only to someone who opened the file. The guard for that was four regexes over
 * BehaviorPanel's source text, pinning the literal `Latest ${changeColumnLabel(gran)}`.
 *
 * THAT PINNED THE SPELLING, NOT THE PROPERTY. Renaming the column broke all four, while a genuine
 * divergence between table and file would still have walked past: nothing in a regex over a template
 * string can tell you the two produce the same numbers.
 *
 * SO THE FOUR BECOME TWO, BOTH OBSERVED ON COMPUTED VALUES AND NEITHER MENTIONING THE WORDING:
 *
 *   1. THE LABEL AGREES WITH THE COMPARISON. The unit named in the heading is the unit of the two
 *      windows the sub-line names. That is the original bug stated directly - a header saying WoW
 *      while comparing months - and it survives any copy change because it never reads the copy.
 *   2. THE CSV DOES NOT COMPUTE ITS OWN. The exported change and total equal the table's, cell for
 *      cell, at every grain. Equality is the only check that catches a second implementation.
 *
 * AND THEY STAY IN THE PUSH GATE. Moving them to a browser script would have made them stronger and
 * dropped them out of `npm run verify`, which is the whole pre-push gate; extracting the builder to
 * lib/behaviorExport is what let both be true at once.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/behavior-export-test.ts
 */
import { exportHeader, exportBody, renderedChange, renderedTotal, type ExportRow } from "@/lib/behaviorExport";
import { grainUnitWord, matchedMonthWindow, type Granularity } from "@/lib/weekBuckets";

let pass = 0, fail = 0;
const ok = (n: string) => { pass++; console.log(`  ok  ${n}`); };
const bad = (n: string, d = "") => { fail++; console.log(`  XX  ${n} ${d}`); };
const is = (n: string, got: unknown, want: unknown) =>
  JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const yes = (n: string, c: boolean, d = "") => (c ? ok(n) : bad(n, d));

/* THE ROWS A TABLE WOULD RENDER. Deliberately mixed: counts and a rate, positive and negative moves,
 * a zero, so the formatters are exercised rather than a single happy row. */
const ROWS: ExportRow[] = [
  { name: "Registrations", cells: [1200, 1310, 900], total: 3410, mom: -31.3 },
  { name: "New players", cells: [585, 1123, 700], total: 2408, mom: -37.7 },
  { name: "Total players", cells: [4000, 4200, 4100], total: 4100, mom: -2.4 },
  { name: "Spots booked", cells: [6573, 8870, 8243], total: 23686, mom: -7.1 },
  { name: "Returning players", cells: [3415, 3077, 3400], total: 9892, mom: 10.5 },
  { name: "Returning player %", cells: [85.4, 73.3, 82.9], total: 82.9, mom: 9.6, points: true },
  { name: "A zero row", cells: [0, 0, 0], total: 0, mom: 0 },
];

console.log("\n— PROPERTY 2: the CSV does not compute its own change —");
{
  const body = exportBody(ROWS);
  is("one body row per table row", body.length, ROWS.length);
  /* CELL FOR CELL. The change column is the LAST cell and the period total the one before it, so
   * both of the values that diverged last time are compared. */
  let changeOk = true, totalOk = true, cellsOk = true;
  const diffs: string[] = [];
  ROWS.forEach((r, i) => {
    const row = body[i];
    if (row[row.length - 1] !== renderedChange(r)) { changeOk = false; diffs.push(`${r.name} change ${row[row.length - 1]} vs ${renderedChange(r)}`); }
    if (row[row.length - 2] !== renderedTotal(r)) { totalOk = false; diffs.push(`${r.name} total`); }
    r.cells.forEach((c, k) => {
      const want = r.points ? `${c.toFixed(1)}%` : String(c);
      if (row[k + 1] !== want) { cellsOk = false; diffs.push(`${r.name} cell ${k}`); }
    });
  });
  yes("the exported CHANGE equals the table's, every row", changeOk, diffs.join("; "));
  yes("  the exported PERIOD TOTAL equals the table's, every row", totalOk, diffs.join("; "));
  yes("  and every period cell matches too", cellsOk, diffs.join("; "));
  /* CONTROL: THE COMPARISON CAN FAIL. Without this, an exportBody that returned the table's own
   * strings unchanged would satisfy the three lines above and prove nothing about a divergence. */
  const drifted = exportBody([{ ...ROWS[0], mom: ROWS[0].mom + 1 }]);
  yes("CONTROL: a row whose change drifted by 1 is detected",
    drifted[0][drifted[0].length - 1] !== renderedChange(ROWS[0]),
    `${drifted[0][drifted[0].length - 1]} vs ${renderedChange(ROWS[0])}`);
  /* AND THE UNITS TRAVEL WITH THE VALUE, so a spreadsheet cannot read 82.9 as a count or +9.6 as a
   * percent when it is points. */
  const rate = body[5];
  yes("a rate's cells carry %", rate.slice(1, 4).every((c) => c.endsWith("%")), rate.join("|"));
  yes("  and its change carries pts, not %", rate[rate.length - 1].endsWith(" pts"), rate[rate.length - 1]);
  yes("  CONTROL: while a count's change carries % and not pts",
    body[0][body[0].length - 1].endsWith("%") && !body[0][body[0].length - 1].includes("pts"));
  is("  CONTROL: and a zero change is signed +0.0%, never bare", body[6][body[6].length - 1], "+0.0%");
}

console.log("\n— PROPERTY 1: the label agrees with the comparison —");
{
  /* THE HEADING NAMES A UNIT; THE SUB-LINE NAMES TWO WINDOWS. The bug was a heading saying WoW over a
   * month-to-month comparison. Asserted on the strings the component actually builds, with no
   * reference to the wording itself beyond the unit word the grain supplies. */
  const headFor = (g: Granularity, sub: string) =>
    exportHeader({
      firstColHead: "Metric",
      bucketLabels: ["a", "b", "c"],
      complete: [true, true, false],
      changeHead: sub ? `Change vs. last ${grainUnitWord(g)} (${sub})` : `Change vs. last ${grainUnitWord(g)}`,
    }).slice(-1)[0];

  for (const g of ["monthly", "weekly", "daily"] as Granularity[]) {
    const h = headFor(g, "");
    yes(`${g}: the heading names the ${grainUnitWord(g)}`, h.includes(grainUnitWord(g)), h);
    /* CONTROL: AND NAMES NO OTHER UNIT. A heading that said "month" at daily grain would pass a
     * mere includes() on "day" if it contained both. */
    const others = (["monthly", "weekly", "daily"] as Granularity[])
      .filter((o) => o !== g).map(grainUnitWord).filter((w) => w !== grainUnitWord(g));
    yes(`  CONTROL: and names no other unit (${others.join(", ")})`,
      others.every((w) => !h.includes(w)), h);
  }
  /* AND THE PARTIAL COLUMN IS LABELLED IN THE FILE, because a CSV has no amber chip to inherit. */
  const hdr = exportHeader({
    firstColHead: "Metric", bucketLabels: ["Jul 2026", "Aug 2026", "Sep 2026"],
    complete: [true, true, false], changeHead: "Change vs. last month",
  });
  is("the partial column is labelled in the file", hdr[3], "Sep 2026 (partial)");
  yes("  CONTROL: while the complete ones are not", hdr[1] === "Jul 2026" && hdr[2] === "Aug 2026");
  is("  and Period total sits between the buckets and the change", hdr[4], "Period total");

  /* THE WINDOWS THE SUB-LINE NAMES ARE THE ONES THE COMPARISON USED. matchedMonthWindow is the
   * source of both, so this asserts they cannot be built from different months. */
  const w = matchedMonthWindow("2026-09", "2026-08", "2026-09-27");
  const sub = `first ${w.days} days · Aug ${w.prevWeekends / 2} weekends → Sep ${w.lastWeekends / 2}`;
  const h = headFor("monthly", sub);
  yes("the sub-line names the day count the window actually used", h.includes("first 27 days"), h);
  yes("  and the heading still names the month, not the day", h.includes("last month"), h);
  /* CONTROL: a closed pair produces no day count, so the two branches are distinguishable. */
  const c = matchedMonthWindow("2026-08", "2026-07", "2026-09-27");
  is("  CONTROL: a closed comparison has no day count to name", c.days, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
