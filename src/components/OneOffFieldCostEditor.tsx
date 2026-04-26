"use client";

import { useEffect, useMemo, useState } from "react";
import type { FinVenue } from "@/lib/useFinanceData";
import { monthFromDate } from "./ExpenseRowEditor";

export type OneOffDraft = {
  date: string;
  month: string;
  venue_id: number | null;
  venue_name: string;
  city: string;
  category: string;
  vendor: string;
  amount: number;
  notes: string;
};

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyDraft(): OneOffDraft {
  const date = todayIso();
  return {
    date,
    month: monthFromDate(date),
    venue_id: null,
    venue_name: "",
    city: "",
    category: "Venue Rental",
    vendor: "",
    amount: 0,
    notes: "",
  };
}

export default function OneOffFieldCostEditor({
  open,
  venues,
  knownCategories,
  onClose,
  onSubmit,
}: {
  open: boolean;
  venues: FinVenue[];
  knownCategories: string[];
  onClose: () => void;
  onSubmit: (draft: OneOffDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<OneOffDraft>(emptyDraft);
  const [monthOverridden, setMonthOverridden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(emptyDraft());
    setMonthOverridden(false);
  }, [open]);

  const sortedVenues = useMemo(
    () => [...venues].sort((a, b) => a.venue_name.localeCompare(b.venue_name)),
    [venues],
  );

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

  function setVenue(venueId: string) {
    const id = Number(venueId);
    const v = venues.find((x) => x.id === id) ?? null;
    setDraft((d) => ({
      ...d,
      venue_id: v?.id ?? null,
      venue_name: v?.venue_name ?? "",
      city: v?.city ?? "",
      // Default vendor to venue name so the override-aware Venue Rental line
      // recognizes this as a monthly_flat-venue charge if applicable.
      vendor: d.vendor || (v?.venue_name ?? ""),
    }));
  }

  async function handleSave() {
    setError(null);
    if (!draft.date) return setError("Date is required.");
    if (!draft.month) return setError("Month is required.");
    if (!draft.venue_id) return setError("Pick a venue.");
    if (!draft.category.trim()) return setError("Category is required.");
    if (!Number.isFinite(draft.amount))
      return setError("Amount must be a number.");
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
          Add One-off Field Cost
        </h2>
        <p className="mt-1 text-xs text-deep-green/55">
          For one-off charges on top of the venue's normal billing (damage
          fees, weather makeups, special rentals). Use{" "}
          <strong>Set Override</strong> instead if you want to replace the
          formula for the month.
        </p>

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
            </Field>
          </div>

          <Field label="Venue">
            <select
              value={draft.venue_id ?? ""}
              onChange={(e) => setVenue(e.target.value)}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              <option value="">Pick a venue…</option>
              {sortedVenues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.venue_name} ({v.city})
                </option>
              ))}
            </select>
          </Field>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="City (auto)">
              <div className="rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green/75">
                {draft.city || "—"}
              </div>
            </Field>
            <Field label="Category">
              <input
                list="oneoff-categories"
                type="text"
                value={draft.category}
                onChange={(e) =>
                  setDraft({ ...draft, category: e.target.value })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              />
              <datalist id="oneoff-categories">
                {knownCategories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>

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
              <p className="mt-1 text-[11px] text-deep-green/55">
                Defaults to the venue name so this charge is recognized as
                that venue's monthly cost where relevant.
              </p>
            </Field>
            <Field label="Amount ($)">
              <input
                type="number"
                step="0.01"
                value={draft.amount}
                onChange={(e) =>
                  setDraft({ ...draft, amount: Number(e.target.value) })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder="e.g., damage charge, makeup match, weather cancellation fee"
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
            {saving ? "Saving…" : "Add"}
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
