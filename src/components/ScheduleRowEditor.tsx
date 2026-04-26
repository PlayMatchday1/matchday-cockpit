"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  FinSchedule,
  FinVenue,
  FinVenueCostOverride,
} from "@/lib/useFinanceData";
import { monthFromDate } from "./ExpenseRowEditor";

export type ScheduleDraft = {
  date: string;
  month: string;
  venue_id: number | null;
  venue_name: string;
  city: string;
  match_count: number;
  total_hours: number | null;
  venue_cost: number | null;
  notes: string;
};

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyDraft(): ScheduleDraft {
  const date = todayIso();
  return {
    date,
    month: monthFromDate(date),
    venue_id: null,
    venue_name: "",
    city: "",
    match_count: 1,
    total_hours: null,
    venue_cost: null,
    notes: "",
  };
}

function fromExisting(row: FinSchedule, venues: FinVenue[]): ScheduleDraft {
  const venue = venues.find(
    (v) => v.venue_name === row.venue && v.city === row.city,
  );
  return {
    date: row.date,
    month: row.month || monthFromDate(row.date),
    venue_id: venue?.id ?? null,
    venue_name: row.venue,
    city: row.city,
    match_count: row.match_count,
    total_hours: row.total_hours,
    venue_cost: row.venue_cost,
    notes: row.notes ?? "",
  };
}

function fmtMoney(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

export default function ScheduleRowEditor({
  open,
  mode,
  initial,
  addPrefill,
  venues,
  overrides,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "add" | "edit";
  initial: FinSchedule | null;
  addPrefill?: { date?: string; venueId?: number } | null;
  venues: FinVenue[];
  overrides: FinVenueCostOverride[];
  onClose: () => void;
  onSubmit: (draft: ScheduleDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ScheduleDraft>(emptyDraft);
  const [monthOverridden, setMonthOverridden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initial) {
      const d = fromExisting(initial, venues);
      setDraft(d);
      setMonthOverridden(d.month !== monthFromDate(d.date));
    } else {
      const base = emptyDraft();
      if (addPrefill?.date) {
        base.date = addPrefill.date;
        base.month = monthFromDate(addPrefill.date);
      }
      if (addPrefill?.venueId) {
        const v = venues.find((x) => x.id === addPrefill.venueId);
        if (v) {
          base.venue_id = v.id;
          base.venue_name = v.venue_name;
          base.city = v.city;
        }
      }
      setDraft(base);
      setMonthOverridden(false);
    }
  }, [open, initial, addPrefill, venues]);

  const sortedVenues = useMemo(
    () => [...venues].sort((a, b) => a.venue_name.localeCompare(b.venue_name)),
    [venues],
  );

  const activeOverride: FinVenueCostOverride | null = useMemo(() => {
    if (!draft.venue_id || !draft.month) return null;
    return (
      overrides.find(
        (o) => o.venue_id === draft.venue_id && o.month === draft.month,
      ) ?? null
    );
  }, [draft.venue_id, draft.month, overrides]);

  const isLockedImport = mode === "edit" && initial && !initial.manual_entry;

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

  function setVenue(venueIdStr: string) {
    const id = Number(venueIdStr);
    const v = venues.find((x) => x.id === id) ?? null;
    setDraft((d) => ({
      ...d,
      venue_id: v?.id ?? null,
      venue_name: v?.venue_name ?? "",
      city: v?.city ?? "",
    }));
  }

  async function handleSave() {
    setError(null);
    if (!draft.date) return setError("Date is required.");
    if (!draft.month) return setError("Month is required.");
    if (!draft.venue_id) return setError("Pick a venue.");
    if (
      !Number.isFinite(draft.match_count) ||
      draft.match_count < 0 ||
      !Number.isInteger(draft.match_count)
    ) {
      return setError("Match count must be a non-negative integer.");
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green">
          {mode === "add" ? "Add Match" : "Edit Match"}
        </h2>
        <p className="mt-1 text-xs text-deep-green/55">
          Billing-side schedule. Decoupled from player registrations — a
          canceled match may still incur charges.
        </p>

        {isLockedImport && (
          <div className="mt-4 rounded-md border border-gold/40 bg-gold-soft/40 px-3 py-2 text-xs text-deep-green">
            <strong>This row was imported from the Sheet.</strong> Saving will
            convert it to a manual entry. Re-importing the Sheet later will
            NOT overwrite it (unless you explicitly choose Replace mode in the
            import dialog).
          </div>
        )}

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

          <Field label="City (auto)">
            <div className="rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-sm text-deep-green/75">
              {draft.city || "—"}
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Match Count">
              <input
                type="number"
                min="0"
                step="1"
                value={draft.match_count}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    match_count: Math.max(
                      0,
                      Math.round(Number(e.target.value) || 0),
                    ),
                  })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
            <Field label="Total Hours (optional)">
              <input
                type="number"
                step="0.25"
                value={draft.total_hours ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    total_hours:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
          </div>

          <Field label="Venue Cost (optional)">
            <input
              type="number"
              step="0.01"
              value={draft.venue_cost ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  venue_cost:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-deep-green/55">
              Informational only — the dashboard computes cost via{" "}
              <code className="rounded bg-cream-soft px-1">
                match_count × per_match_rate
              </code>{" "}
              with overrides applied. For cost adjustments use the Field
              Costs page.
            </p>
          </Field>

          {activeOverride && (
            <div className="rounded-md border border-gold/40 bg-gold-soft/40 px-3 py-2 text-xs text-deep-green">
              <strong>⚠️ Override active</strong> for {draft.venue_name} in{" "}
              {draft.month}: {fmtMoney(activeOverride.override_amount)} (set
              by {activeOverride.created_by}). Adding this match will increase
              the visible match count but{" "}
              <strong>won't change the billed cost</strong> until the override
              is removed. Adjust via the Field Costs page if needed.
            </div>
          )}

          <Field label="Notes">
            <textarea
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder="e.g., makeup match, weather adjustment, special booking"
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
            {saving
              ? "Saving…"
              : mode === "add"
                ? "Add"
                : isLockedImport
                  ? "Save & Convert to Manual"
                  : "Save"}
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
