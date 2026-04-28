"use client";

import { useEffect, useMemo, useState } from "react";
import type { FinExpense } from "@/lib/useFinanceData";

export type ExpenseDraft = {
  date: string;
  month: string;
  city: string;
  category: string;
  vendor: string;
  amount: number;
  notes: string;
};

const CITY_OPTIONS = [
  "Austin",
  "Houston",
  "San Antonio",
  "Dallas",
  "Atlanta",
  "St. Louis",
  "OKC",
  "El Paso",
];

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function monthFromDate(date: string): string {
  const m = date.match(/^(\d{4})-(\d{2})-/);
  if (!m) return "";
  const idx = parseInt(m[2], 10) - 1;
  if (idx < 0 || idx > 11) return "";
  return `${MONTH_NAMES[idx]} ${m[1]}`;
}

function emptyDraft(): ExpenseDraft {
  const date = todayIso();
  return {
    date,
    month: monthFromDate(date),
    city: CITY_OPTIONS[0],
    category: "",
    vendor: "",
    amount: 0,
    notes: "",
  };
}

function fromExisting(row: FinExpense): ExpenseDraft {
  // Normalize city for the dropdown:
  //   null / "" / legacy literal "Company-wide" → "" (selects the
  //   canonical Company-wide option, which writes null on save)
  //   real city name → kept as-is
  const cityForEditor =
    !row.city || row.city === "Company-wide" ? "" : row.city;
  return {
    date: row.date,
    month: row.month || monthFromDate(row.date),
    city: cityForEditor,
    category: row.category ?? "",
    vendor: row.vendor ?? "",
    amount: row.amount,
    notes: row.notes ?? "",
  };
}

export default function ExpenseRowEditor({
  open,
  mode,
  initial,
  knownCategories,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "add" | "edit";
  initial: FinExpense | null;
  knownCategories: string[];
  onClose: () => void;
  onSubmit: (draft: ExpenseDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ExpenseDraft>(emptyDraft);
  const [monthOverridden, setMonthOverridden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initial) {
      const d = fromExisting(initial);
      setDraft(d);
      // Treat the existing month as "explicit" so editing the date doesn't
      // surprise-overwrite it.
      setMonthOverridden(d.month !== monthFromDate(d.date));
    } else {
      setDraft(emptyDraft());
      setMonthOverridden(false);
    }
  }, [open, initial]);

  const cityOptions = useMemo(() => {
    if (mode === "edit" && draft.city && !CITY_OPTIONS.includes(draft.city)) {
      return [draft.city, ...CITY_OPTIONS];
    }
    return CITY_OPTIONS;
  }, [mode, draft.city]);

  if (!open) return null;

  function setDate(date: string) {
    setDraft((d) => ({
      ...d,
      date,
      month: monthOverridden ? d.month : monthFromDate(date),
    }));
  }

  function setMonth(month: string) {
    setMonthOverridden(true);
    setDraft((d) => ({ ...d, month }));
  }

  async function handleSave() {
    setError(null);
    if (!draft.date) {
      setError("Date is required.");
      return;
    }
    if (!draft.month) {
      setError("Month is required.");
      return;
    }
    if (!draft.category.trim()) {
      setError("Category is required.");
      return;
    }
    // City is optional for any category — empty selects the
    // canonical Company-wide option (writes null on save).
    if (!Number.isFinite(draft.amount)) {
      setError("Amount must be a number.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit({ ...draft, category: draft.category.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green">
          {mode === "add" ? "Add Expense" : "Edit Expense"}
        </h2>

        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Date">
              <input
                type="date"
                value={draft.date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
            <Field label="Month">
              <input
                type="text"
                value={draft.month}
                onChange={(e) => setMonth(e.target.value)}
                placeholder="e.g. Apr 2026"
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              />
              <p className="mt-1 text-[11px] text-deep-green/55">
                Auto-fills from Date. Edit to backdate into a different
                accounting month.
              </p>
            </Field>
          </div>

          <Field label="City">
            <select
              value={draft.city}
              onChange={(e) => setDraft({ ...draft, city: e.target.value })}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              <option value="">Company-wide</option>
              {cityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Category">
            <input
              list="expense-categories"
              type="text"
              value={draft.category}
              onChange={(e) =>
                setDraft({ ...draft, category: e.target.value })
              }
              placeholder="Pick or type a new category"
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            <datalist id="expense-categories">
              {knownCategories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <p className="mt-1 text-[11px] text-deep-green/55">
              Type to filter existing categories or enter a new one.
            </p>
          </Field>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Vendor">
              <input
                type="text"
                value={draft.vendor}
                onChange={(e) =>
                  setDraft({ ...draft, vendor: e.target.value })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
            <Field label="Amount ($)">
              <input
                type="number"
                step="0.01"
                value={draft.amount}
                onChange={(e) =>
                  setDraft({ ...draft, amount: Number(e.target.value) })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-right font-mono tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              className="w-full resize-y rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-coral/40 bg-coral-soft/40 px-3 py-2 text-xs text-coral">
            {error}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-full border border-cream-line bg-transparent px-4 py-2 text-xs font-bold text-deep-green hover:bg-cream-soft disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-full bg-mint px-5 py-2 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : mode === "add" ? "Add" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
        {label}
      </div>
      {children}
    </label>
  );
}
