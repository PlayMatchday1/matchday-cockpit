"use client";

import { useEffect, useMemo, useState } from "react";
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
import { useFinancePeriod } from "@/lib/financePeriodContext";
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

const chipAct = "text-[12px] font-bold text-deep-green/60 underline decoration-cream-line underline-offset-2 hover:text-deep-green";

/** "2026-09-30" → "Sep 2026". Only used when a row carries no explicit month string. */
function monthOf(date: string): string {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y, m] = (date ?? "").split("-");
  const i = Number(m) - 1;
  return M[i] ? `${M[i]} ${y}` : (date ?? "");
}

/**
 * HOW MANY OTHER MONTHS OF THE SAME LINE ITEM SURVIVE THIS DELETE.
 *
 * fin_expenses has no recurrence column — "City Manager · Dallas · $800, monthly" is not one row
 * with a repeat rule, it is one row per month. So a delete can only ever remove a single month, and
 * this counts what is left so the confirmation can say so with a number rather than a reassurance.
 *
 * Identity is city + category + vendor, all compared case-insensitively and null-tolerantly, and
 * NOT amount — a raise mid-year is the same line item at a different price.
 */
function otherMonthsOf(row: FinExpense, all: FinExpense[]): number {
  const key = (r: FinExpense) =>
    [r.city ?? "", r.category ?? "", r.vendor ?? ""].map((v) => v.trim().toLowerCase()).join("|");
  const k = key(row);
  const months = new Set<string>();
  for (const r of all) {
    if (r.id === row.id) continue;
    if (key(r) !== k) continue;
    months.add(r.month || monthOf(r.date));
  }
  months.delete(row.month || monthOf(row.date));
  return months.size;
}

export default function ExpenseAdminView() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();
  const quarter = useFinanceQuarter();
  /* THE HEADER PICKER IS THE ONLY PERIOD CONTROL. The recurring grid used to render a fixed
   * quarter and carry its own All/Jul/Aug/Sep row, so the page had two period controls with no
   * relationship — the chips summed one window and the header named another. `period.months` is
   * whatever the header says, month or quarter or year. */
  const { period } = useFinancePeriod();

  const [monthFilter, setMonthFilter] = useState<MonthFilter>("ALL");
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [cityFilter, setCityFilter] = useState<string>(ALL);
  // CHIPS, NOT A DROPDOWN. Eight categories were invisible inside a single-select that could only
  // ever show one, and picking one meant guessing whether it had any spend. Each chip carries its
  // own period total, so the choice is informed before it is made.
  //
  // A CATEGORY WITH NO SPEND STARTS OFF. That is what removes the fifteen $0.00 rows — a DEFAULT,
  // not a rule: the chip is still there, still tappable, and turning it on brings its rows back.
  // Dim-and-off and unavailable are drawn differently for exactly that reason.
  //
  // REMEMBERED BETWEEN VISITS, so a deliberate selection is not undone by navigating away.
  const [selectedCats, setSelectedCats] = useState<Set<string> | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("add");
  const [editorRow, setEditorRow] = useState<FinExpense | null>(null);

  const [deleteRow, setDeleteRow] = useState<FinExpense | null>(null);

  // Recurring vs Ledger view. Recurring is the default — it groups the flat
  // rows into line items so a missing month shows as a gap.
  const [view, setView] = useState<"rec" | "led">("rec");
  // NO GRID-LEVEL PERIOD STATE. There was a gridMonth drill-down here; the page header's picker
  // is now the only period control, so the grid holds no window of its own to disagree with it.
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

  // Per-category spend for the ACTIVE PERIOD — the number on the chip, and what decides which
  // chips open on.
  const categorySpend = useMemo(() => {
    // THE HEADER'S WINDOW, not the containing quarter. These chips read $12,971 for Marketing
    // with August selected — Jul + Aug + Sep — while the header said August ($5,721).
    const months = new Set(period.months);
    const out = new Map<string, number>();
    for (const c of selectableCategories) out.set(c, 0);
    for (const r of allRows) {
      if (!months.has(r.month)) continue;
      if (!out.has(r.category)) continue;
      out.set(r.category, (out.get(r.category) ?? 0) + Number(r.amount || 0));
    }
    return out;
  }, [allRows, selectableCategories, period.months]);

  const CHIP_KEY = "finance:expenses:categories";
  // Restore a remembered selection; otherwise open on "only the ones with spend".
  useEffect(() => {
    // WAIT FOR THE DATA. This ran on the first render, when allRows is empty and every category
    // therefore looks like $0 — so "only with spend" resolved to NOTHING and the guard below kept
    // it that way once the rows arrived. The page opened with every chip off and an empty table.
    if (selectedCats !== null || selectableCategories.length === 0) return;
    if (allRows.length === 0) return;
    let restored: Set<string> | null = null;
    try {
      const raw = window.localStorage.getItem(CHIP_KEY);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        // Intersect with what exists today — a category that has since disappeared must not
        // resurrect, and a NEW one must not be silently excluded by an old selection.
        restored = new Set(arr.filter((c) => selectableCategories.includes(c)));
      }
    } catch { /* private mode */ }
    setSelectedCats(
      restored && restored.size > 0
        ? restored
        : new Set(selectableCategories.filter((c) => (categorySpend.get(c) ?? 0) !== 0)),
    );
  }, [selectedCats, selectableCategories, categorySpend, allRows.length]);

  const activeCats = selectedCats ?? new Set(selectableCategories);
  const setCats = (next: Set<string>) => {
    setSelectedCats(next);
    try { window.localStorage.setItem(CHIP_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
  };

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
    rows = rows.filter((r) => activeCats.has(r.category));
    return rows;
  }, [allRows, monthFilter, rangeFrom, rangeTo, cityFilter, activeCats, quarter]);

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
    rows = rows.filter((r) => activeCats.has(r.category));
    return rows;
  }, [allRows, cityFilter, activeCats]);

  const columns = useMemo(() => buildColumns(period.months), [period.months]);
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
      </div>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            Expenses
          </h1>
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
          /* THE SECOND PERIOD CONTROL IS GONE. This row was a QUARTER selector with its own
             All/Jul/Aug/Sep, sitting on a page whose header already names a period — two controls
             with no relationship, and the grid obeyed this one while every label obeyed the other.
             The header picker is now the only period control on the page. */
          <div className="text-[11.5px] leading-snug text-deep-green/50" data-testid="rec-window">
            Showing <b className="text-deep-green/70">{period.label}</b>
            {period.months.length > 1 && <> · {period.months.length} months</>}
            . Greyed columns before it are context and are not in any total.
          </div>
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


      </div>

      {/* ── THE CATEGORIES ARE THE CONTROL ───────────────────────────────────────────────────── */}
      <div className="mb-5">
        <div className="mb-2 flex items-baseline gap-3">
          <span className="text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-deep-green/45">
            Show
          </span>
          <button type="button" className={chipAct} onClick={() => setCats(new Set(selectableCategories))}>All</button>
          <button type="button" className={chipAct} onClick={() => setCats(new Set())}>None</button>
          <button type="button" className={chipAct}
            onClick={() => setCats(new Set(selectableCategories.filter((c) => (categorySpend.get(c) ?? 0) !== 0)))}>
            Only with spend
          </button>
        </div>
        <div className="flex flex-wrap gap-[7px]">
          {selectableCategories.map((c) => {
            const spend = categorySpend.get(c) ?? 0;
            const on = activeCats.has(c);
            // DIM = no spend this period. Still tappable — off and unavailable must not look alike.
            const dim = spend === 0;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                data-testid="expense-cat-chip"
                onClick={() => {
                  const next = new Set(activeCats);
                  if (next.has(c)) next.delete(c); else next.add(c);
                  setCats(next);
                }}
                className={
                  "inline-flex min-h-[36px] items-center gap-[7px] rounded-full border px-3 py-1 text-[12.5px] transition " +
                  (on
                    ? "border-[#d5ded8] bg-[#f2f5f3] font-bold text-deep-green"
                    : dim
                      ? "border-[#eef2ef] bg-white font-semibold text-deep-green/25"
                      : "border-cream-line bg-white font-semibold text-deep-green/55")
                }
              >
                {c}
                <span className={"text-[11.5px] font-bold tabular-nums " + (on ? "text-deep-green/60" : "text-deep-green/25")}>
                  {spend === 0 ? "$0" : fmtMoney(spend)}
                </span>
              </button>
            );
          })}
        </div>
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
            // The Total column must NAME the window it sums. A column headed plain TOTAL sitting
            // beside context columns it excludes is the bug, not the columns.
            windowLabel={period.grain === "month" ? period.label.split(" ")[0].slice(0, 3).toUpperCase() : period.label.toUpperCase()}
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
        onDelete={(row) => {
          // Close the editor first so the confirmation is the only thing on screen. Leaving a form
          // full of half-typed edits behind a delete prompt invites confirming the wrong thing.
          setEditorOpen(false);
          setDeleteRow(row);
        }}
      />

      <ConfirmDeleteDialog
        open={Boolean(deleteRow)}
        title={
          deleteRow
            ? `Delete ${deleteRow.category} — ${fmtMoney(deleteRow.amount, true)} — ${deleteRow.month || deleteRow.date}?`
            : "Delete this expense entry?"
        }
        summary={
          deleteRow ? (
            <div className="space-y-2 text-xs">
              <div className="space-y-1 font-mono">
                <div>
                  <span className="text-deep-green/55">Line item </span>
                  <span className="font-bold">
                    {deleteRow.city || "Company-wide"} · {deleteRow.category}
                    {deleteRow.vendor ? ` · ${deleteRow.vendor}` : ""}
                  </span>
                </div>
                <div>
                  <span className="text-deep-green/55">Month </span>
                  <span className="font-bold">{deleteRow.month || monthOf(deleteRow.date)}</span>
                  <span className="text-deep-green/55"> (dated {deleteRow.date})</span>
                </div>
                <div className="font-bold text-coral">
                  Amount {fmtMoney(deleteRow.amount, true)}
                </div>
                {deleteRow.notes && (
                  <div className="text-deep-green/55">{deleteRow.notes}</div>
                )}
              </div>
              {/* SCOPE, SAID OUT LOUD. fin_expenses has no recurrence column — a recurring cost is
                  stored as one row per month, so this removes THIS month and nothing else. Someone
                  who believes they are cancelling a subscription needs to know that. */}
              <div className="rounded-md border border-cream-line bg-cream-soft/60 px-3 py-2 leading-relaxed text-deep-green/70">
                This removes <span className="font-bold">one month only</span> —{" "}
                {deleteRow.month || monthOf(deleteRow.date)}. If{" "}
                {deleteRow.category} recurs, every other month is stored as its own entry and stays.
                {otherMonthsOf(deleteRow, allRows) > 0 && (
                  <>
                    {" "}
                    <span className="font-bold">
                      {otherMonthsOf(deleteRow, allRows)} other month
                      {otherMonthsOf(deleteRow, allRows) === 1 ? "" : "s"}
                    </span>{" "}
                    of this line item will remain.
                  </>
                )}
              </div>
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
