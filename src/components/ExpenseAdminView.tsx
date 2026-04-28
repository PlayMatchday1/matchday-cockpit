"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import ConfirmDeleteDialog from "@/components/ConfirmDeleteDialog";
import ExpenseRowEditor, {
  type ExpenseDraft,
} from "@/components/ExpenseRowEditor";
import { logChange } from "@/lib/financeAudit";
import { Q2_MONTHS, type Q2Month } from "@/lib/financeStats";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";
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
];

function fmtMoney(n: number, signZero = false): string {
  const r = Math.round(n);
  if (r === 0 && !signZero) return "—";
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

export default function ExpenseAdminView() {
  const { data, loading } = useFinanceData();
  const { appUser } = useAuth();

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

  const allRows = data?.expenses ?? [];

  const knownCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.category) set.add(r.category);
    return [...set].sort();
  }, [allRows]);

  // Categories the user can SELECT when filtering or adding a new row.
  // Excludes Match Manager Pay (managed on /admin/finance/manager-pay)
  // and always includes Misc as a creatable bucket. Existing MMP rows
  // still display in the table — only the dropdowns are filtered.
  const selectableCategories = useMemo(() => {
    const filtered = knownCategories.filter((c) => c !== "Match Manager Pay");
    if (!filtered.includes("Misc")) filtered.push("Misc");
    return filtered.sort();
  }, [knownCategories]);

  const categoryOptions = useMemo(
    () => [ALL, ...selectableCategories],
    [selectableCategories],
  );

  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.city) set.add(r.city);
    const ordered: string[] = [ALL];
    for (const c of CITY_DISPLAY) if (set.has(c)) ordered.push(c);
    for (const c of [...set].sort()) {
      if (!CITY_DISPLAY.includes(c)) ordered.push(c);
    }
    return ordered;
  }, [allRows]);

  const filtered = useMemo(() => {
    let rows = allRows.slice();
    if (monthFilter === "RANGE") {
      if (rangeFrom) rows = rows.filter((r) => r.date && r.date >= rangeFrom);
      if (rangeTo) rows = rows.filter((r) => r.date && r.date <= rangeTo);
    } else if (monthFilter !== "ALL") {
      rows = rows.filter((r) => r.month === monthFilter);
    }
    if (cityFilter !== ALL) rows = rows.filter((r) => r.city === cityFilter);
    if (categoryFilter !== ALL)
      rows = rows.filter((r) => r.category === categoryFilter);
    return rows;
  }, [allRows, monthFilter, rangeFrom, rangeTo, cityFilter, categoryFilter]);

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

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function openAdd() {
    setEditorMode("add");
    setEditorRow(null);
    setEditorOpen(true);
  }

  function openEdit(row: FinExpense) {
    setEditorMode("edit");
    setEditorRow(row);
    setEditorOpen(true);
  }

  async function handleSubmit(draft: ExpenseDraft): Promise<void> {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");

    if (editorMode === "add") {
      const payload = {
        date: draft.date,
        month: draft.month,
        city: draft.city || null,
        category: draft.category,
        vendor: draft.vendor || null,
        amount: draft.amount,
        notes: draft.notes || null,
        manual_entry: true,
      };
      const { data: inserted, error } = await supabase
        .from("fin_expenses")
        .insert(payload)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await logChange({
        tableName: "fin_expenses",
        rowId: (inserted as { id: number }).id,
        action: "insert",
        changedBy: email,
        after: inserted as Record<string, unknown>,
      });
    } else if (editorMode === "edit" && editorRow) {
      if (!editorRow.manual_entry) throw new Error("Row is locked.");
      const before = { ...editorRow };
      const updates = {
        date: draft.date,
        month: draft.month,
        city: draft.city || null,
        category: draft.category,
        vendor: draft.vendor || null,
        amount: draft.amount,
        notes: draft.notes || null,
      };
      const { data: updated, error } = await supabase
        .from("fin_expenses")
        .update(updates)
        .eq("id", editorRow.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      await logChange({
        tableName: "fin_expenses",
        rowId: editorRow.id,
        action: "update",
        changedBy: email,
        before: before as unknown as Record<string, unknown>,
        after: updated as Record<string, unknown>,
      });
    }

    await refetchFinanceData();
    setEditorOpen(false);
  }

  async function handleDelete(): Promise<void> {
    const email = appUser?.email;
    if (!email) throw new Error("Not signed in");
    if (!deleteRow) return;
    if (!deleteRow.manual_entry) throw new Error("Row is locked.");

    await logChange({
      tableName: "fin_expenses",
      rowId: deleteRow.id,
      action: "delete",
      changedBy: email,
      before: deleteRow as unknown as Record<string, unknown>,
    });
    const { error } = await supabase
      .from("fin_expenses")
      .delete()
      .eq("id", deleteRow.id);
    if (error) throw new Error(error.message);

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
          <p className="mt-2 text-sm text-deep-green/65">
            Inspect every fin_expenses row. Imported rows are read-only —
            re-upload via Q2 Import to change them.
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-2 rounded-full bg-mint px-5 py-2 text-sm font-bold text-deep-green hover:bg-mint-hover"
        >
          <Plus size={16} aria-hidden />
          Add Expense
        </button>
      </div>

      <div className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-cream-line bg-white p-4 shadow-md shadow-deep-green/10">
        <Filter label="Month">
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value as MonthFilter)}
            className="rounded-md border border-cream-line bg-cream-soft px-3 py-1.5 text-sm font-bold text-deep-green focus:border-deep-green focus:outline-none"
          >
            <option value="ALL">All months</option>
            {Q2_MONTHS.map((m) => (
              <option key={m} value={m}>
                {m}
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
                      {row.city || (
                        <span className="text-deep-green/45">—</span>
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
