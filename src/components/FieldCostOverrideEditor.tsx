"use client";

import { useEffect, useState } from "react";
import type { FieldCostRow } from "@/lib/financeCosts";
import type { Q2Month } from "@/lib/financeStats";
import { Q2_MONTHS } from "@/lib/financeStats";

export type OverrideDraft = {
  month: Q2Month;
  override_amount: number;
  reason: string;
};

function fmtMoney(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

export default function FieldCostOverrideEditor({
  open,
  row,
  initialMonth,
  onClose,
  onSubmit,
}: {
  open: boolean;
  row: FieldCostRow | null;
  initialMonth: Q2Month;
  onClose: () => void;
  onSubmit: (draft: OverrideDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<OverrideDraft>({
    month: initialMonth,
    override_amount: 0,
    reason: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !row) return;
    setError(null);
    setDraft({
      month: (row.override?.month as Q2Month) ?? initialMonth,
      override_amount: row.override?.override_amount ?? row.autoAmount,
      reason: row.override?.reason ?? "",
    });
  }, [open, row, initialMonth]);

  if (!open || !row) return null;

  async function handleSave() {
    setError(null);
    if (!Number.isFinite(draft.override_amount)) {
      setError("Override amount must be a number.");
      return;
    }
    setSaving(true);
    try {
      await onSubmit(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const editingExisting = Boolean(row.override);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green">
          {editingExisting ? "Edit Override" : "Set Override"}
        </h2>
        <p className="mt-1 text-xs text-deep-green/55">
          Override is the canonical truth — it replaces the auto-computed cost
          for this venue and month everywhere in the dashboard.
        </p>

        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-lg border border-cream-line bg-cream-soft/40 px-3 py-2 text-xs">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
                Venue
              </div>
              <div className="font-mono text-deep-green">
                {row.displayName}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
                City
              </div>
              <div className="font-mono text-deep-green">{row.city}</div>
            </div>
          </div>

          <Field label="Month">
            <select
              value={draft.month}
              onChange={(e) =>
                setDraft({ ...draft, month: e.target.value as Q2Month })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              {Q2_MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>

          <div className="rounded-md border border-cream-line bg-cream-soft/40 px-3 py-2 text-xs text-deep-green/75">
            <span className="font-bold uppercase tracking-wider text-deep-green/55">
              Auto would show:
            </span>{" "}
            <span className="font-mono">{fmtMoney(row.autoAmount)}</span>{" "}
            <span className="text-deep-green/55">({row.autoFormula})</span>
          </div>

          <Field label="Override Amount ($)">
            <input
              type="number"
              step="0.01"
              value={draft.override_amount}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  override_amount: Number(e.target.value),
                })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          <Field label="Reason">
            <input
              type="text"
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
              placeholder="e.g., Q2-Q3 lump prepayment, profit-share adjustment"
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          {row.secondaryVenueIds.length > 0 && (
            <div className="rounded-md border border-mint/40 bg-mint-soft/40 px-3 py-2 text-xs text-deep-green">
              This override applies to the combined {row.displayName} row
              (covers both weekday and Sunday legs). The Sunday leg will be
              set to $0 so aggregations stay correct.
            </div>
          )}
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
            {saving
              ? "Saving…"
              : editingExisting
                ? "Save"
                : "Set Override"}
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
