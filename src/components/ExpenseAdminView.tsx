"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import ExpenseRowEditor, {
  type ExpenseDraft,
} from "@/components/ExpenseRowEditor";
import {
  insertFinExpense,
  updateFinExpense,
  deleteFinExpense,
} from "@/lib/finExpenseWrites";
import RecurringExpensesGrid from "@/components/RecurringExpensesGrid";
import BatchExpenseDrawer from "@/components/BatchExpenseDrawer";
import {
  buildColumns,
  buildRecurringSeries,
  columnTotals,
  recurringFlags,
  RECURRING_EXCLUDED_CATEGORIES,
  type RecurringCell,
  type RecurringSeries,
} from "@/lib/recurringExpenses";
import { type Q2Month } from "@/lib/financeStats";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import { useAuth } from "@/lib/useAuth";
import { isCityHidden } from "@/lib/types";
import {
  refetchFinanceData,
  useFinanceData,
  type FinExpense,
} from "@/lib/useFinanceData";

type SortKey = "date" | "city" | "category" | "vendor" | "amount";
type SortDir = "asc" | "desc";

type MonthFilter = Q2Month | "ALL" | "RANGE";

const ALL = "All";

const CITY_DISPLAY = [
  "Austin",
  "Houston",
  "San Antonio",
  "Dallas",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
  "Company-wide",
].filter((c) => !isCityHidden(c));

function fmtMoney(n: number, signZero = false): string {
  const r = Math.round(n);
  if (r === 0 && !signZero) return "—";
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

export default function ExpenseAdminView() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();
  const quarter = useFinanceQuarter();

  const [monthFilter, setMonthFilter] = useState<MonthFilter>("ALL");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [cityFilter, setCityFilter] = useState<string>(ALL);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);

  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("add");
  const [editorRow, setEditorRow] = useState<FinExpense | null>(null);

  const [deleteRow, setDeleteRow] = useState<FinExpense | null>(null);

  // Recurring vs Ledger view. Recurring is the default — it groups the flat
  // rows into line items so a missing month shows as a gap.
  const [view, setView] = useState<"rec" | "led">("rec");
  // Single-month drill-down within the recurring grid (null = whole quarter).
  const [gridMonth, setGridMonth] = useState<string | null>(null);
  // Multi-month batch add drawer (+ optional seed from a clicked gap cell).
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSeed, setBatchSeed] = useState<
    { city: string; category: string; vendor: string; month?: string } | null
  >(null);
  // Multi-row cell inspector (a month-cell holding >1 fin_expenses row).
  const [multiCell, setMultiCell] = useState<
    { series: RecurringSeries; cell: RecurringCell } | null
  >(null);

  const allRows = data?.expenses ?? [];

  // "Now" as a month ordinal (year*12 + month) — distinguishes future months
  // (not booked yet) from real gaps in the recurring grid.
  const nowOrd = useMemo(() => {
    const n = new Date();
    return n.getFullYear() * 12 + (n.getMonth() + 1);
  }, []);

  const knownCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.category) set.add(r.category);
    return [...set].sort();
  }, [allRows]);

  // Always-visible categories — surfaced in the Add Expense dropdown
  // even before any rows exist. City Manager / Marketing / Equipment
  // are line-item categories as of the 2026-05-07 migration; they were
  // formerly placeholder columns in fin_monthly_expenses. Misc is the
  // generic catch-all bucket.
  const BASE_CATEGORIES = useMemo(
    () => ["City Manager", "Equipment", "Marketing", "Misc"],
    [],
  );

  // Categories the user can SELECT when filtering or adding a new row.
  // Excludes Match Manager Pay (managed on /admin/finance/manager-pay).
  // Existing MMP rows still display in the table — only the dropdowns
  // are filtered.
  const selectableCategories = useMemo(() => {
    const set = new Set<string>([...knownCategories, ...BASE_CATEGORIES]);
    set.delete("Match Manager Pay");
    return [...set].sort();
  }, [knownCategories, BASE_CATEGORIES]);

  const categoryOptions = useMemo(
    () => [ALL, ...selectableCategories],
    [selectableCategories],
  );

  // Filter dropdown options. Real city names come from row data;
  // "Company-wide" is synthetic — included when any row has city
  // null/empty or the legacy "Company-wide" literal, and the filter
  // logic below matches it against both shapes.
  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    let hasCompanyWide = false;
    for (const r of allRows) {
      if (!r.city || r.city === "Company-wide") {
        hasCompanyWide = true;
        continue;
      }
      set.add(r.city);
    }
    const ordered: string[] = [ALL];
    for (const c of CITY_DISPLAY) {
      if (c === "Company-wide") {
        if (hasCompanyWide) ordered.push(c);
      } else if (set.has(c)) {
        ordered.push(c);
      }
    }
    for (const c of [...set].sort()) {
      if (!CITY_DISPLAY.includes(c)) ordered.push(c);
    }
    return ordered;
  }, [allRows]);

  const filtered = useMemo(() => {
    // Hide Match Manager Pay rows from this view at render time —
    // they're managed on /admin/finance/manager-pay. Display-layer
    // filter only; fin_expenses rows still exist and every other
    // surface (city P&L cards, Cash Flow, Q2 hero) reads them.
    let rows = allRows.filter((r) => r.category !== "Match Manager Pay");
    if (monthFilter === "RANGE") {
      if (rangeFrom) rows = rows.filter((r) => r.date && r.date >= rangeFrom);
      if (rangeTo) rows = rows.filter((r) => r.date && r.date <= rangeTo);
    } else if (monthFilter !== "ALL") {
      rows = rows.filter((r) => r.month === monthFilter);
    } else {
      // ALL inside the active quarter only — match the page-level
      // selector's mental model (admin views are quarter-scoped).
      const monthSet = new Set(quarter.months.map((m) => m.key));
      rows = rows.filter((r) => monthSet.has(r.month));
    }
    if (cityFilter !== ALL) {
      if (cityFilter === "Company-wide") {
        rows = rows.filter((r) => !r.city || r.city === "Company-wide");
      } else {
        rows = rows.filter((r) => r.city === cityFilter);
      }
    }
    if (categoryFilter !== ALL)
      rows = rows.filter((r) => r.category === categoryFilter);
    return rows;
  }, [allRows, monthFilter, rangeFrom, rangeTo, cityFilter, categoryFilter, quarter]);

  const sorted = useMemo(() => {
    const rows = filtered.slice();
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "desc" ? bv - av : av - bv;
      }
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return sortDir === "desc" ? bs.localeCompare(as) : as.localeCompare(bs);
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  const totalAmount = useMemo(
    () => filtered.reduce((s, r) => s + r.amount, 0),
    [filtered],
  );

  // ---- Recurring view ----
  // Rows feeding the series: city + category filters applied, but NOT the month
  // filter — series stats (median, booked-month count, gaps) are computed over
  // a line item's whole history, then projected onto the visible columns.
  const seriesRows = useMemo(() => {
    let rows = allRows;
    if (cityFilter !== ALL) {
      if (cityFilter === "Company-wide") {
        rows = rows.filter((r) => !r.city || r.city === "Company-wide");
      } else {
        rows = rows.filter((r) => r.city === cityFilter);
      }
    }
    if (categoryFilter !== ALL) rows = rows.filter((r) => r.category === categoryFilter);
    return rows;
  }, [allRows, cityFilter, categoryFilter]);

  // Ignore a single-month selection that isn't in the active quarter (e.g. the
  // page-level ?q selector changed quarters while a month drill-down was set).
  const effectiveGridMonth = useMemo(
    () => (gridMonth && quarter.months.some((m) => m.key === gridMonth) ? gridMonth : null),
    [gridMonth, quarter],
  );
  const columns = useMemo(
    () => buildColumns(quarter, effectiveGridMonth),
    [quarter, effectiveGridMonth],
  );
  const series = useMemo(
    () => buildRecurringSeries(seriesRows, columns, nowOrd),
    [seriesRows, columns, nowOrd],
  );
  const colTot = useMemo(() => columnTotals(series, columns), [series, columns]);
  const grandTotal = useMemo(
    () => series.reduce((s, x) => s + x.rowTotal, 0),
    [series],
  );
  const flags = useMemo(() => recurringFlags(series), [series]);

  // Per-month row counts for the recurring month segments (excludes MMP, which
  // isn't a recurring line item on this page).
  const monthCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const mm of quarter.months) m[mm.key] = 0;
    for (const r of seriesRows) {
      if (RECURRING_EXCLUDED_CATEGORIES.has(r.category)) continue;
      if (m[r.month] !== undefined) m[r.month]++;
    }
    return m;
  }, [seriesRows, quarter]);

  function openBatch() {
    setBatchSeed(null);
    setBatchOpen(true);
  }
  function fillCell(s: RecurringSeries, month: string) {
    setBatchSeed({
      city: s.city ?? "Company-wide",
      category: s.category,
      vendor: s.vendor ?? "",
      month,
    });
    setBatchOpen(true);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function openEdit(row: FinExpense) {
    setEditorMode("edit");
    setEditorRow(row);
    setEditorOpen(true);
  }

  async function handleSubmit(draft: ExpenseDraft): Promise<void> {
    if (!appUser) throw new Error("Not signed in");
    const fields = {
      date: draft.date,
      month: draft.month,
      city: draft.city || null,
      category: draft.category,
      vendor: draft.vendor || null,
      amount: draft.amount,
      notes: draft.notes || null,
    };
    if (editorMode === "add") {
      await insertFinExpense(fields, appUser);
    } else if (editorMode === "edit" && editorRow) {
      await updateFinExpense(editorRow, fields, appUser);
    }
    await refetchFinanceData();
    setEditorOpen(false);
  }

  async function handleDelete(): Promise<void> {
    if (!appUser) throw new Error("Not signed in");
    if (!deleteRow) return;
    await deleteFinExpense(deleteRow, appUser);
    await refetchFinanceData();
    setDeleteRow(null);
  }

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Expenses
          </h1>
          <p className="mt-2 max-w-xl text-sm text-deep-green/65">
            Most of these repeat. The <b>Recurring</b> view groups the flat rows
            into line items so a missing month reads as a gap. Imported and
            recompute-owned rows stay read-only.
          </p>
          <p className="mt-1 text-xs text-deep-green/55">
            Match Manager Pay is managed separately on the{" "}
            <Link
              href="/admin/finance/manager-pay"
              className="font-bold text-mint-hover hover:underline"
            >
              Manager Pay page
            </Link>
            .
          </p>
        </div>
        <button
          type="button"
          onClick={openBatch}
          className="inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green hover:bg-mint-hover"
        >
          <Plus size={16} aria-hidden />
          Add Expense
        </button>
      </div>

      {/* View toggle */}
      <div className="mb-4 inline-flex gap-1 rounded-full border border-cream-line bg-white p-1">
        {(["rec", "led"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-full px-4 py-1.5 text-xs font-black transition ${
              view === v
                ? "bg-deep-green text-white"
                : "text-deep-green/55 hover:text-deep-green"
            }`}
          >
            {v === "rec" ? "Recurring" : "Ledger"}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        {view === "rec" ? (
          <Filter label={`Quarter · ${quarter.label}`}>
            <div className="inline-flex flex-wrap gap-1 rounded-lg border border-cream-line bg-cream-soft p-1">
              <Seg on={gridMonth === null} onClick={() => setGridMonth(null)}>
                All
              </Seg>
              {quarter.months.map((m) => (
                <Seg
                  key={m.key}
                  on={gridMonth === m.key}
                  onClick={() => setGridMonth(m.key)}
                >
                  {m.shortName}
                  <span className="ml-1 text-[9px] opacity-60">{monthCounts[m.key] ?? 0}</span>
                </Seg>
              ))}
            </div>
          </Filter>
        ) : (
          <>
            <Filter label="Month">
              <select
                value={monthFilter}
                onChange={(e) => setMonthFilter(e.target.value as MonthFilter)}
                className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
              >
                <option value="ALL">All months</option>
                {quarter.months.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.key}
                  </option>
                ))}
                <option value="RANGE">Custom range</option>
              </select>
            </Filter>

            {monthFilter === "RANGE" && (
              <>
                <Filter label="From">
                  <input
                    type="date"
                    value={rangeFrom}
                    onChange={(e) => setRangeFrom(e.target.value)}
                    className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
                  />
                </Filter>
                <Filter label="To">
                  <input
                    type="date"
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value)}
                    className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm text-deep-green focus:border-deep-green focus:outline-none"
                  />
                </Filter>
              </>
            )}
          </>
        )}

        <Filter label="City">
          <select
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {cityOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Filter>

        <Filter label="Category">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            {categoryOptions.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Filter>
      </div>

      {view === "rec" && (
        <>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-xs text-deep-green/60">
              Grouped by city + category + vendor. Click a cell to edit that
              month · click a gap to fill it.
            </div>
            <div className="text-xs font-bold text-deep-green/70">
              {flags.gaps > 0 && (
                <span className="text-amber-700">
                  {flags.gaps} gap{flags.gaps === 1 ? "" : "s"}
                </span>
              )}
              {flags.gaps > 0 && flags.changed > 0 && " · "}
              {flags.changed > 0 && (
                <span>
                  {flags.changed} amount change{flags.changed === 1 ? "" : "s"}
                </span>
              )}
              {flags.gaps === 0 && flags.changed === 0 && "Nothing unexpected this quarter"}
            </div>
          </div>
          <RecurringExpensesGrid
            series={series}
            columns={columns}
            colTotals={colTot}
            grandTotal={grandTotal}
            onEditRow={openEdit}
            onOpenCell={(s, cell) => setMultiCell({ series: s, cell })}
            onFillCell={fillCell}
          />
        </>
      )}

      {view === "led" && (
      <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <tr className="border-b border-cream-line">
                <Th
                  label="Date"
                  active={sortKey === "date"}
                  dir={sortDir}
                  onClick={() => toggleSort("date")}
                />
                <Th
                  label="City"
                  active={sortKey === "city"}
                  dir={sortDir}
                  onClick={() => toggleSort("city")}
                />
                <Th
                  label="Category"
                  active={sortKey === "category"}
                  dir={sortDir}
                  onClick={() => toggleSort("category")}
                />
                <Th
                  label="Vendor"
                  active={sortKey === "vendor"}
                  dir={sortDir}
                  onClick={() => toggleSort("vendor")}
                />
                <Th
                  label="Amount"
                  align="right"
                  active={sortKey === "amount"}
                  dir={sortDir}
                  onClick={() => toggleSort("amount")}
                />
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2 text-right">&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {loading && sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    Loading expenses…
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-8 text-center text-sm text-deep-green/55"
                  >
                    No expense rows match these filters.
                  </td>
                </tr>
              ) : (
                sorted.map((row) => (
                  <tr
                    key={row.id}
                    className="group border-t border-cream-line/40 hover:bg-cream-soft/50"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-deep-green">
                      {row.date}
                    </td>
                    <td className="px-3 py-2 text-deep-green">
                      {!row.city || row.city === "Company-wide" ? (
                        <span className="text-deep-green/45">
                          Company-wide
                        </span>
                      ) : (
                        row.city
                      )}
                    </td>
                    <td className="px-3 py-2 text-deep-green/85">
                      {row.category}
                    </td>
                    <td className="px-3 py-2 text-deep-green/65">
                      {row.vendor ?? ""}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-coral">
                      {fmtMoney(row.amount)}
                    </td>
                    <td className="max-w-[280px] truncate px-3 py-2 text-deep-green/65">
                      {row.notes ?? ""}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.manual_entry ? (
                        <div className="inline-flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => openEdit(row)}
                            className="rounded-full p-1 text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
                            aria-label="Edit row"
                            title="Edit"
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteRow(row)}
                            className="rounded-full p-1 text-coral/70 hover:bg-coral-soft/50 hover:text-coral"
                            aria-label="Delete row"
                            title="Delete"
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </div>
                      ) : (
                        <span
                          title="Imported from CSV — re-upload to modify"
                          className="inline-flex items-center text-deep-green/30"
                        >
                          <Lock size={12} aria-hidden />
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-cream-line/60 bg-cream-soft/40 px-4 py-3 text-xs text-deep-green/70">
          <div>
            Showing{" "}
            <span className="font-mono font-bold tabular-nums text-deep-green">
              {filtered.length.toLocaleString()}
            </span>{" "}
            of{" "}
            <span className="font-mono tabular-nums">
              {allRows.length.toLocaleString()}
            </span>{" "}
            rows
          </div>
          <div>
            Total Amount:{" "}
            <span className="font-mono font-bold tabular-nums text-coral">
              {fmtMoney(totalAmount, true)}
            </span>
          </div>
        </div>
      </section>
      )}

      <BatchExpenseDrawer
        open={batchOpen}
        quarter={quarter}
        expenses={allRows}
        cities={CITY_DISPLAY}
        categories={selectableCategories}
        appUser={appUser}
        seed={batchSeed}
        onClose={() => setBatchOpen(false)}
        onDone={refetchFinanceData}
      />

      <MultiCellModal
        data={multiCell}
        onClose={() => setMultiCell(null)}
        onEdit={(row) => {
          setMultiCell(null);
          openEdit(row);
        }}
        onDelete={(row) => {
          setMultiCell(null);
          setDeleteRow(row);
        }}
      />

      <ExpenseRowEditor
        open={editorOpen}
        mode={editorMode}
        initial={editorRow}
        knownCategories={selectableCategories}
        onClose={() => setEditorOpen(false)}
        onSubmit={handleSubmit}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteRow)}
        title="Delete this expense entry?"
        summary={
          deleteRow ? (
            <div className="space-y-1 font-mono text-xs">
              <div>{deleteRow.date}</div>
              <div>
                {deleteRow.city} · {deleteRow.category}
                {deleteRow.vendor ? ` · ${deleteRow.vendor}` : ""}
              </div>
              <div className="font-bold text-coral">
                Amount: {fmtMoney(deleteRow.amount, true)}
              </div>
              {deleteRow.notes && (
                <div className="text-deep-green/55">{deleteRow.notes}</div>
              )}
            </div>
          ) : null
        }
        onCancel={() => setDeleteRow(null)}
        onConfirm={handleDelete}
      />
    </>
  );
}

function Filter({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
        {label}
      </div>
      {children}
    </label>
  );
}

function Seg({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-black transition ${
        on ? "bg-deep-green text-white" : "text-deep-green/60 hover:bg-cream"
      }`}
    >
      {children}
    </button>
  );
}

// Inspector for a month-cell that holds more than one fin_expenses row (recon
// 0c). The grid never silently sums into an editor — it opens this list so the
// operator edits/deletes a specific underlying row.
function MultiCellModal({
  data,
  onClose,
  onEdit,
  onDelete,
}: {
  data: { series: RecurringSeries; cell: RecurringCell } | null;
  onClose: () => void;
  onEdit: (row: FinExpense) => void;
  onDelete: (row: FinExpense) => void;
}) {
  if (!data) return null;
  const { series, cell } = data;
  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-deep-green/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-cream-line px-5 py-4">
          <div>
            <div className="text-sm font-black text-deep-green">{series.label}</div>
            <div className="text-xs text-deep-green/55">
              {series.city ?? "Company-wide"} · {series.category} · {cell.month} ·{" "}
              {cell.rows.length} rows
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-2xl leading-none text-deep-green/50 hover:text-deep-green"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="max-h-[320px] divide-y divide-cream-line/60 overflow-auto">
          {cell.rows.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-5 py-3 text-xs">
              <span className="font-mono tabular-nums text-deep-green">{row.date}</span>
              <span className="flex-1 truncate text-deep-green/55">{row.notes ?? ""}</span>
              <span className="font-mono font-bold tabular-nums text-coral">
                ${row.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {row.manual_entry ? (
                <span className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(row)}
                    className="rounded-full p-1 text-deep-green/60 hover:bg-cream-soft hover:text-deep-green"
                    aria-label="Edit row"
                  >
                    <Pencil size={13} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(row)}
                    className="rounded-full p-1 text-coral/70 hover:bg-coral-soft/50 hover:text-coral"
                    aria-label="Delete row"
                  >
                    <Trash2 size={13} aria-hidden />
                  </button>
                </span>
              ) : (
                <span title="Imported — read-only" className="text-deep-green/30">
                  <Lock size={12} aria-hidden />
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Th({
  label,
  align = "left",
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: "left" | "right";
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className={`cursor-pointer select-none px-3 py-2 ${
        align === "right" ? "text-right" : "text-left"
      } ${active ? "text-deep-green" : ""} hover:bg-cream`}
    >
      <span
        className={`inline-flex items-center gap-1 ${
          align === "right" ? "justify-end" : ""
        }`}
      >
        {label}
        {active && <span aria-hidden>{dir === "desc" ? "▼" : "▲"}</span>}
      </span>
    </th>
  );
}
