"use client";

import { useEffect, useMemo, useState } from "react";
import type { FinRevenue, FinVenue } from "@/lib/useFinanceData";
import { isCityHidden } from "@/lib/types";

export type RevenueDraft = {
  date: string;
  city: string;
  source: string;
  type: string;
  venue: string | null;
  gross: number;
  fees: number;
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
  "Deleted Account Revenue",
].filter((c) => !isCityHidden(c));

const SOURCE_OPTIONS = ["Venmo", "Cash", "Sponsorship", "Other"];

const TYPE_OPTIONS = ["Membership", "DPP", "Private Rental", "Other"];

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyDraft(): RevenueDraft {
  return {
    date: todayIso(),
    city: CITY_OPTIONS[0],
    source: SOURCE_OPTIONS[0],
    type: TYPE_OPTIONS[0],
    venue: null,
    gross: 0,
    fees: 0,
    notes: "",
  };
}

function fromExisting(row: FinRevenue): RevenueDraft {
  return {
    date: row.date,
    city: row.city || CITY_OPTIONS[0],
    source: row.source || SOURCE_OPTIONS[0],
    type: row.type || TYPE_OPTIONS[0],
    venue: row.venue,
    gross: row.gross,
    fees: row.fees,
    notes: row.notes ?? "",
  };
}

export default function RevenueRowEditor({
  open,
  mode,
  initial,
  venues,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: "add" | "edit";
  initial: FinRevenue | null;
  venues: FinVenue[];
  onClose: () => void;
  onSubmit: (draft: RevenueDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RevenueDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setDraft(initial ? fromExisting(initial) : emptyDraft());
  }, [open, initial]);

  const net = useMemo(() => draft.gross - draft.fees, [draft.gross, draft.fees]);

  const sourceOptions = useMemo(() => {
    // In edit mode, allow keeping the existing source value even if it's
    // outside the manual-entry list (e.g. an old "Manual" row).
    if (mode === "edit" && draft.source && !SOURCE_OPTIONS.includes(draft.source)) {
      return [draft.source, ...SOURCE_OPTIONS];
    }
    return SOURCE_OPTIONS;
  }, [mode, draft.source]);

  const typeOptions = useMemo(() => {
    if (mode === "edit" && draft.type && !TYPE_OPTIONS.includes(draft.type)) {
      return [draft.type, ...TYPE_OPTIONS];
    }
    return TYPE_OPTIONS;
  }, [mode, draft.type]);

  // Venues filtered to the current city — used by the conditional Venue
  // dropdown that shows for Private Rental rows. Dedup canonical names so
  // ATH Katy + ATH Katy Sunday don't both appear.
  const venuesForCity = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of venues) {
      if (v.city !== draft.city) continue;
      if (seen.has(v.venue_name)) continue;
      seen.add(v.venue_name);
      out.push(v.venue_name);
    }
    out.sort();
    return out;
  }, [venues, draft.city]);

  // When city changes, drop venue selection if it no longer matches a venue
  // in the new city.
  useEffect(() => {
    if (!open) return;
    if (draft.venue && !venuesForCity.includes(draft.venue)) {
      setDraft((d) => ({ ...d, venue: null }));
    }
  }, [open, draft.city, draft.venue, venuesForCity]);

  const showVenueField = draft.type === "Private Rental";

  if (!open) return null;

  async function handleSave() {
    setError(null);
    if (!draft.date) {
      setError("Date is required.");
      return;
    }
    if (!draft.city) {
      setError("City is required.");
      return;
    }
    if (!Number.isFinite(draft.gross)) {
      setError("Gross must be a number.");
      return;
    }
    if (showVenueField && !draft.venue) {
      setError("Venue is required for Private Rental rows.");
      return;
    }
    // Strip venue for non-Private-Rental types so the type → venue rule is
    // enforced one way (Private Rental sets it; everything else clears it).
    const submission: RevenueDraft = showVenueField
      ? draft
      : { ...draft, venue: null };
    setSaving(true);
    try {
      await onSubmit(submission);
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
          {mode === "add" ? "Add Revenue" : "Edit Revenue"}
        </h2>

        <div className="mt-5 space-y-4">
          <Field label="Date">
            <input
              type="date"
              value={draft.date}
              onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="City">
              <select
                value={draft.city}
                onChange={(e) => setDraft({ ...draft, city: e.target.value })}
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              >
                {CITY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Source">
              <select
                value={draft.source}
                onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              >
                {sourceOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Type">
            <select
              value={draft.type}
              onChange={(e) => setDraft({ ...draft, type: e.target.value })}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-deep-green/55">
              Membership rolls into city memberships · DPP into per-venue
              field rev · Other stays out of both rollups but still counts in
              totals.
            </p>
          </Field>

          {showVenueField && (
            <Field label="Venue (required for Private Rental)">
              <select
                value={draft.venue ?? ""}
                onChange={(e) =>
                  setDraft({ ...draft, venue: e.target.value || null })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              >
                <option value="">Pick a venue…</option>
                {venuesForCity.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              {venuesForCity.length === 0 && (
                <p className="mt-1 text-[11px] text-coral">
                  No venues in {draft.city}. Add one in fin_venues first.
                </p>
              )}
            </Field>
          )}

          <div className="grid grid-cols-3 gap-4">
            <Field label="Gross ($)">
              <input
                type="number"
                step="0.01"
                value={draft.gross}
                onChange={(e) =>
                  setDraft({ ...draft, gross: Number(e.target.value) })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-right font-mono tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
            <Field label="Fees ($)">
              <input
                type="number"
                step="0.01"
                value={draft.fees}
                onChange={(e) =>
                  setDraft({ ...draft, fees: Number(e.target.value) })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-right font-mono tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
            <Field label="Net (auto)">
              <div
                className={`rounded-md border border-cream-line bg-cream-soft px-3 py-2 text-right font-mono text-sm tabular-nums ${
                  net < 0 ? "text-coral" : "text-deep-green"
                }`}
              >
                {net.toFixed(2)}
              </div>
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
