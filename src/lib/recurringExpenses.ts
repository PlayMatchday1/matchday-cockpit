// Recurring-expense inference for the redesigned Expenses page.
//
// The flat fin_expenses ledger is grouped into *recurring line items* — a thing
// that gets booked month after month — so a missing month reads as a visible
// gap instead of being buried in a date-sorted list. Every rule here was chosen
// against the real data in the Phase 0 recon (2026-07); the notable findings:
//   - vendor is null on 42/257 rows, so the group key falls back to
//     (city, category) when vendor is blank (recon 0a/0b).
//   - a (city, category, vendor, month) cell can hold >1 row (recon 0c) — the
//     grid sums them and badges the count; it never silently merges.
//   - "usual" amount wanders per series (recon 0d) → median, not mean.
//   - day-of-month is not stable within a series (recon 0e) → the bulk-add
//     drawer lets the operator pick the day; we never auto-pick one here.
//
// Match Manager Pay is excluded — it is recompute-owned (managed on /managers)
// and its weekly rows aren't a monthly line item.

import type { FinExpense } from "@/lib/useFinanceData";
import { getQuarterByKey, type QuarterInfo } from "@/lib/quarters";

// Categories that never appear as recurring line items on this page.
// Match Manager Pay is recompute-owned + weekly; it lives on the Manager Pay
// page (see RECOMPUTE_OWNED_CATEGORIES in finExpenseWrites).
export const RECURRING_EXCLUDED_CATEGORIES = new Set<string>(["Match Manager Pay"]);

const SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// "Jul 2026" → a chronological ordinal (year*12 + month). Sortable, and the
// unit used by the gap rule (a difference of 1 == adjacent months).
export function monthOrd(monthKey: string): number {
  const [mon, yr] = monthKey.split(" ");
  return parseInt(yr, 10) * 12 + (SHORT.indexOf(mon) + 1);
}
export function ordToMonthKey(ord: number): string {
  const y = Math.floor((ord - 1) / 12);
  const m = (ord - 1) % 12;
  return `${SHORT[m]} ${y}`;
}

// Normalize vendor for grouping: trimmed + lowercased, blank → null (fallback
// to city+category). Display keeps the first row's original spelling.
function normVendor(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t.toLowerCase();
}
function cityKey(c: string | null | undefined): string {
  const t = (c ?? "").trim();
  return t === "" || t === "Company-wide" ? "" : t;
}

export function seriesKeyOf(row: FinExpense): string {
  return `${cityKey(row.city)}||${row.category}||${normVendor(row.vendor) ?? ""}`;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---- THE GAP RULE (single swap point) --------------------------------------
// R3: a month is a gap only if the series has >=3 booked months AND the month
// sits strictly between the first and last booked month (interior only). This
// deliberately never flags a series that has ended, and never flags a one-off
// (<=2 booked months). To change the rule later, change ONLY this function.
export function isGapMonth(bookedOrds: number[], candidateOrd: number): boolean {
  if (bookedOrds.length < 3) return false;
  if (bookedOrds.includes(candidateOrd)) return false;
  const lo = Math.min(...bookedOrds);
  const hi = Math.max(...bookedOrds);
  return candidateOrd > lo && candidateOrd < hi;
}
// ----------------------------------------------------------------------------

export type RecurringCellState =
  | "booked" // exactly one row, at/near the series median
  | "changed" // exactly one row, amount differs from the median
  | "multi" // >1 row in this month-cell (rendered as a sum + badge)
  | "gap" // expected (per isGapMonth) but not booked
  | "future" // a month later than now — not booked yet, not a gap
  | "empty"; // not booked and not expected

export type RecurringCell = {
  month: string;
  ord: number;
  context: boolean; // prior-quarter continuity column — not in totals
  rows: FinExpense[]; // underlying fin_expenses rows (0, 1, or many)
  amount: number; // sum of rows
  state: RecurringCellState;
  locked: boolean; // any underlying row is imported (manual_entry=false)
  lockReason?: string;
};

export type RecurringSeries = {
  key: string;
  city: string | null; // null == Company-wide
  category: string;
  vendor: string | null; // display spelling, null when grouped by city+category
  label: string; // vendor || category
  median: number | null;
  bookedMonthsAllTime: number;
  oneoff: boolean; // <=2 booked months → never gets a gap
  cells: RecurringCell[]; // one per column, in column order
  rowTotal: number; // sum over non-context columns
};

export type RecurringColumn = { month: string; ord: number; context: boolean };

// Columns for a quarter: the two trailing months of the prior quarter (context,
// greyed, excluded from totals) followed by the quarter's three months. When a
// single month is filtered, only that column shows and there is no context.
export function buildColumns(
  quarter: QuarterInfo,
  monthFilter: string | null,
): RecurringColumn[] {
  if (monthFilter) {
    return [{ month: monthFilter, ord: monthOrd(monthFilter), context: false }];
  }
  const inQ: RecurringColumn[] = quarter.months.map((m) => ({
    month: m.key,
    ord: monthOrd(m.key),
    context: false,
  }));
  // Prior quarter (may be null at EARLIEST_QUARTER) → last 2 months as context.
  const priorQ =
    quarter.quarter === 1
      ? getQuarterByKey(`${quarter.year - 1}Q4`)
      : getQuarterByKey(`${quarter.year}Q${quarter.quarter - 1}`);
  const ctx: RecurringColumn[] = priorQ
    ? priorQ.months.slice(-2).map((m) => ({
        month: m.key,
        ord: monthOrd(m.key),
        context: true,
      }))
    : [];
  return [...ctx, ...inQ];
}

// Build the recurring series for a set of columns. `expenses` is the full
// fin_expenses set (all time) — the series stats (median, booked-month count,
// gap detection) are computed over ALL of a series' history, not just the
// visible columns, so a gap in the visible quarter is judged against the whole
// life of the line item. `nowOrd` distinguishes future (not booked yet) from
// gap/empty.
export function buildRecurringSeries(
  expenses: FinExpense[],
  columns: RecurringColumn[],
  nowOrd: number,
): RecurringSeries[] {
  // Group, excluding recompute-owned / non-line-item categories.
  const groups = new Map<string, FinExpense[]>();
  for (const r of expenses) {
    if (RECURRING_EXCLUDED_CATEGORIES.has(r.category)) continue;
    const k = seriesKeyOf(r);
    const arr = groups.get(k);
    if (arr) arr.push(r);
    else groups.set(k, [r]);
  }

  const out: RecurringSeries[] = [];
  for (const [key, members] of groups) {
    // Per-month sums across ALL history → median of booked monthly values.
    const byMonth = new Map<number, FinExpense[]>();
    for (const r of members) {
      const o = monthOrd(r.month);
      const a = byMonth.get(o);
      if (a) a.push(r);
      else byMonth.set(o, [r]);
    }
    const bookedOrds = [...byMonth.keys()];
    const monthlySums = bookedOrds.map((o) =>
      byMonth.get(o)!.reduce((s, r) => s + r.amount, 0),
    );
    const med = median(monthlySums);
    const oneoff = bookedOrds.length <= 2;

    const first = members[0];
    const cells: RecurringCell[] = columns.map((col) => {
      const rows = byMonth.get(col.ord) ?? [];
      const amount = rows.reduce((s, r) => s + r.amount, 0);
      const locked = rows.some((r) => !r.manual_entry);
      let state: RecurringCellState;
      if (rows.length > 1) {
        state = "multi";
      } else if (rows.length === 1) {
        state =
          med != null && Math.abs(amount - med) > 0.005 ? "changed" : "booked";
      } else if (!col.context && !oneoff && isGapMonth(bookedOrds, col.ord)) {
        state = "gap";
      } else if (col.ord > nowOrd) {
        state = "future";
      } else {
        state = "empty";
      }
      return {
        month: col.month,
        ord: col.ord,
        context: col.context,
        rows,
        amount,
        state,
        locked,
        lockReason: locked
          ? "Imported — re-upload via Q2 Import to change"
          : undefined,
      };
    });

    const rowTotal = cells
      .filter((c) => !c.context)
      .reduce((s, c) => s + c.amount, 0);

    out.push({
      key,
      city: cityKey(first.city) === "" ? null : cityKey(first.city),
      category: first.category,
      vendor: normVendor(first.vendor) ? first.vendor : null,
      label: (normVendor(first.vendor) ? first.vendor : null) ?? first.category,
      median: med,
      bookedMonthsAllTime: bookedOrds.length,
      oneoff,
      cells,
      rowTotal,
    });
  }

  // Biggest line items first; stable tiebreak by label.
  out.sort((a, b) => b.rowTotal - a.rowTotal || a.label.localeCompare(b.label));
  return out;
}

// Column totals (booked) over the visible series, per the same column order.
export function columnTotals(series: RecurringSeries[], columns: RecurringColumn[]): number[] {
  return columns.map((_, i) => series.reduce((s, sr) => s + sr.cells[i].amount, 0));
}

// Quarter-scoped flags summary for the card header.
export function recurringFlags(series: RecurringSeries[]): { gaps: number; changed: number } {
  let gaps = 0;
  let changed = 0;
  for (const s of series) {
    for (const c of s.cells) {
      if (c.context) continue;
      if (c.state === "gap") gaps++;
      if (c.state === "changed") changed++;
    }
  }
  return { gaps, changed };
}
