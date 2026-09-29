/* THE PLAYER ACTIVITY EXPORT, AS A PURE FUNCTION.
 *
 * ── WHY THIS LEFT THE COMPONENT ──────────────────────────────────────────────────────────────
 * The CSV used to be built inline in BehaviorPanel, and it is where the one real bug in this feature
 * hid: when the weekly comparison was fixed, the SCREEN was corrected and the export kept shipping
 * the old number. Two change figures for one pair of weeks, one right and one wrong, and the wrong
 * one only visible to someone who opened the file.
 *
 * THE OLD GUARD FOR THAT WAS FOUR REGEXES OVER THE COMPONENT'S SOURCE TEXT. They pinned the spelling
 * `Latest ${changeColumnLabel(gran)}` rather than the property, so renaming the column broke them
 * while a genuine divergence between table and file would still have slipped past. Extracted here,
 * the property can be asserted directly and in the PUSH GATE: the exported rows are built from the
 * same rows the table renders, so a guard can compare them cell for cell.
 *
 * NOTHING ABOUT THE OUTPUT CHANGED. Same header, same body, same order.
 */
export type ExportRow = {
  name: string;
  cells: number[];
  total: number;
  mom: number;
  /** A rate: written with its unit so a spreadsheet cannot mistake 44 for a count. */
  points?: boolean;
};

export type ExportHeaderParts = {
  firstColHead: string;
  /** Bucket labels, already grain-aware, in column order. */
  bucketLabels: string[];
  /** Per column: false renders "(partial)" beside the label. */
  complete: boolean[];
  /** The change column's heading, built by the caller so the screen and the file share one string. */
  changeHead: string;
};

const fmtCell = (v: number, points?: boolean): string => (points ? `${v.toFixed(1)}%` : String(v));
const fmtChange = (v: number, points?: boolean): string =>
  points ? `${v >= 0 ? "+" : ""}${v.toFixed(1)} pts` : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/** The header row. The partial tag is written INTO the file: a CSV has no amber chip to inherit. */
export function exportHeader(p: ExportHeaderParts): string[] {
  return [
    p.firstColHead,
    ...p.bucketLabels.map((l, i) => (p.complete[i] ? l : `${l} (partial)`)),
    "Period total",
    p.changeHead,
  ];
}

/**
 * One body row per table row, in table order.
 *
 * THE CHANGE IS NOT RECOMPUTED HERE. It is read off the row the table already rendered, which is the
 * whole point: a second computation is what diverged last time. A guard asserts these equal the
 * table's own values.
 */
export function exportBody(rows: readonly ExportRow[]): string[][] {
  return rows.map((r) => [
    r.name,
    ...r.cells.map((c) => fmtCell(c, r.points)),
    fmtCell(r.total, r.points),
    fmtChange(r.mom, r.points),
  ]);
}

/** What the table shows for one row's change pill, so the two can be compared without a DOM. */
export function renderedChange(r: ExportRow): string {
  return fmtChange(r.mom, r.points);
}
/** What the table shows for one row's period total. */
export function renderedTotal(r: ExportRow): string {
  return fmtCell(r.total, r.points);
}
