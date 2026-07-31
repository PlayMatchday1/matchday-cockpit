"use client";

// The "Recurring" view of the Expenses page: one row per inferred line item,
// one cell per month, so a missing month reads as a visible gap. Presentational
// only — series/gap logic lives in src/lib/recurringExpenses.ts; all writes go
// up to the parent (ExpenseAdminView) through its shared editor / batch drawer.

import type {
  RecurringCell,
  RecurringColumn,
  RecurringSeries,
} from "@/lib/recurringExpenses";
import type { FinExpense } from "@/lib/useFinanceData";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyShort = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export default function RecurringExpensesGrid({
  series,
  columns,
  colTotals,
  grandTotal,
  onEditRow,
  onOpenCell,
  onFillCell,
}: {
  series: RecurringSeries[];
  columns: RecurringColumn[];
  colTotals: number[];
  grandTotal: number;
  onEditRow: (row: FinExpense) => void; // single editable booked/changed cell
  onOpenCell: (series: RecurringSeries, cell: RecurringCell) => void; // multi-row cell
  onFillCell: (series: RecurringSeries, month: string) => void; // gap / empty / future
}) {
  const firstInIdx = columns.findIndex((c) => !c.context);

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="bg-cream-soft text-[9.5px] font-black uppercase tracking-wider text-deep-green/55">
              <th className="sticky left-0 z-10 min-w-[240px] bg-cream-soft px-4 py-3 text-left">
                Line item
              </th>
              {columns.map((c, i) => (
                <th
                  key={c.month}
                  className={`px-2 py-3 text-center ${c.context ? "bg-cream text-deep-green/35" : ""} ${
                    i === firstInIdx && firstInIdx > 0 ? "border-l-2 border-deep-green/70" : ""
                  }`}
                >
                  {c.month.split(" ")[0]}
                  {c.context && (
                    <span className="block text-[7.5px] tracking-widest opacity-70">PRIOR Q</span>
                  )}
                </th>
              ))}
              <th className="px-4 py-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {series.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + 2}
                  className="px-4 py-8 text-center text-sm text-deep-green/55"
                >
                  No recurring line items in this window.
                </td>
              </tr>
            ) : (
              series.map((s) => (
                <tr key={s.key} className="border-t border-cream-line/40 hover:bg-cream-soft/40">
                  <td className="sticky left-0 z-[1] min-w-[240px] border-r border-cream-line bg-white px-4 py-3 text-left">
                    <div className="text-[13px] font-extrabold text-deep-green">{s.label}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px] text-deep-green/50">
                      <Tag>{s.city ?? "Company-wide"}</Tag>
                      <Tag>{s.category}</Tag>
                      {s.oneoff ? (
                        <Tag muted>one-off</Tag>
                      ) : (
                        <span>
                          {s.median != null ? moneyShort(s.median) : "—"} · {s.bookedMonthsAllTime} mo
                        </span>
                      )}
                    </div>
                  </td>
                  {s.cells.map((cell, i) => (
                    <td
                      key={cell.month}
                      className={`px-1 py-0 text-center ${cell.context ? "bg-cream/60" : ""} ${
                        i === firstInIdx && firstInIdx > 0 ? "border-l-2 border-deep-green/70" : ""
                      }`}
                    >
                      <Cell
                        s={s}
                        cell={cell}
                        onEditRow={onEditRow}
                        onOpenCell={onOpenCell}
                        onFillCell={onFillCell}
                      />
                    </td>
                  ))}
                  <td className="px-4 py-3 text-right font-black tabular-nums text-coral">
                    {money(s.rowTotal)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {series.length > 0 && (
            <tfoot>
              <tr className="bg-cream-soft font-black tabular-nums">
                <td className="sticky left-0 z-[1] bg-cream-soft px-4 py-3 text-left text-deep-green/70">
                  <span className="text-[10px] font-black uppercase tracking-wider">
                    Booked total
                  </span>
                  <span className="ml-1 text-[9px] font-semibold normal-case tracking-normal text-deep-green/45">
                    excl. Match Manager Pay
                  </span>
                </td>
                {columns.map((c, i) => (
                  <td
                    key={c.month}
                    className={`px-2 py-3 text-center text-[11px] text-deep-green ${
                      c.context ? "text-deep-green/40" : ""
                    } ${i === firstInIdx && firstInIdx > 0 ? "border-l-2 border-deep-green/70" : ""}`}
                  >
                    {colTotals[i] ? moneyShort(colTotals[i]) : "—"}
                  </td>
                ))}
                <td className="px-4 py-3 text-right text-coral">{money(grandTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-cream-line/70 px-4 py-3 text-[10.5px] text-deep-green/55">
        <Legend cls="bg-mint border border-mint">Booked</Legend>
        <Legend cls="border border-dashed border-amber-400 bg-amber-50">Gap — expected, not booked</Legend>
        <Legend cls="border border-blue-200 bg-blue-50">Amount differs from usual</Legend>
        <Legend cls="border border-cream-line bg-white">Not expected / future</Legend>
      </div>
    </section>
  );
}

function Cell({
  s,
  cell,
  onEditRow,
  onOpenCell,
  onFillCell,
}: {
  s: RecurringSeries;
  cell: RecurringCell;
  onEditRow: (row: FinExpense) => void;
  onOpenCell: (series: RecurringSeries, cell: RecurringCell) => void;
  onFillCell: (series: RecurringSeries, month: string) => void;
}) {
  // Locked (imported) cell — read-only, reason on hover. Same pattern as OpEx.
  if (cell.locked && cell.rows.length >= 1) {
    return (
      <span
        title={cell.lockReason}
        className="inline-flex min-w-[56px] items-center justify-center gap-1 rounded-lg border border-cream-line bg-cream-soft px-2 py-1.5 text-[11px] font-bold tabular-nums text-deep-green/55"
      >
        {moneyShort(cell.amount)}
        <LockIcon />
      </span>
    );
  }

  switch (cell.state) {
    case "multi":
      return (
        <button
          type="button"
          onClick={() => onOpenCell(s, cell)}
          title={`${cell.rows.length} rows in this month — click to view`}
          className="inline-flex min-w-[56px] items-center justify-center gap-1 rounded-lg border border-mint bg-mint px-2 py-1.5 text-[11px] font-bold tabular-nums text-deep-green hover:border-deep-green/40"
        >
          {moneyShort(cell.amount)}
          <span className="rounded bg-white/70 px-1 text-[8.5px] font-black">{cell.rows.length}</span>
        </button>
      );
    case "booked":
    case "changed": {
      const row = cell.rows[0];
      const changed = cell.state === "changed";
      return (
        <button
          type="button"
          onClick={() => onEditRow(row)}
          title="Click to edit this month"
          className={`inline-block min-w-[56px] rounded-lg px-2 py-1.5 text-[11px] font-bold tabular-nums transition ${
            changed
              ? "border border-blue-200 bg-blue-50 text-blue-800 hover:border-blue-400"
              : "border border-mint bg-mint text-deep-green hover:border-deep-green/40"
          }`}
        >
          {moneyShort(cell.amount)}
        </button>
      );
    }
    case "gap":
      return (
        <button
          type="button"
          onClick={() => onFillCell(s, cell.month)}
          title="Expected but not booked — click to fill"
          className="inline-block min-w-[56px] rounded-lg border border-dashed border-amber-400 bg-amber-50 px-2 py-1.5 text-[10px] font-black uppercase tracking-wide text-amber-800 hover:bg-amber-100"
        >
          gap
        </button>
      );
    case "future":
      return (
        <button
          type="button"
          onClick={() => onFillCell(s, cell.month)}
          title="Not booked yet — click to add"
          className="inline-block min-w-[44px] rounded-lg px-2 py-1.5 text-sm text-deep-green/30 hover:text-deep-green/70"
        >
          +
        </button>
      );
    default: // empty
      return <span className="inline-block px-2 py-1.5 text-deep-green/20">·</span>;
  }
}

function Tag({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
        muted ? "bg-cream text-deep-green/45" : "bg-cream-soft text-deep-green/55"
      }`}
    >
      {children}
    </span>
  );
}
function Legend({ cls, children }: { cls: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-3 w-3.5 rounded ${cls}`} />
      {children}
    </span>
  );
}
function LockIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
