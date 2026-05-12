"use client";

import { useEffect, useState } from "react";
import { CITIES } from "@/lib/types";
import type { FinVenue } from "@/lib/useFinanceData";

export type AddVenueDraft = {
  venue_name: string;
  city: string;
  billing_type: FinVenue["billing_type"];
  per_match_rate: number | null;
  hourly_rate: number | null;
  cost_per_match: number | null;
  max_spots: number | null;
  dpp_price: number | null;
  member_price: number | null;
  launch_date: string | null;
  notes: string | null;
  aliases: string[];
};

const BILLING_TYPE_OPTIONS: FinVenue["billing_type"][] = [
  "per_match",
  "monthly_flat",
  "per_hour",
  "lump_sum",
  "profit_share",
  "no_charge",
];

function emptyDraft(): AddVenueDraft {
  return {
    venue_name: "",
    city: CITIES[0],
    billing_type: "per_match",
    per_match_rate: null,
    hourly_rate: null,
    cost_per_match: null,
    max_spots: null,
    dpp_price: null,
    member_price: null,
    launch_date: null,
    notes: null,
    aliases: [],
  };
}

function parseNum(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === "") return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

function parseAliases(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function AddVenueDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (draft: AddVenueDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AddVenueDraft>(emptyDraft);
  const [aliasesRaw, setAliasesRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(emptyDraft());
    setAliasesRaw("");
    setError(null);
    setSaving(false);
  }, [open]);

  if (!open) return null;

  const showPerMatch = draft.billing_type === "per_match";
  const showPerHour = draft.billing_type === "per_hour";

  async function handleSave() {
    setError(null);
    if (!draft.venue_name.trim()) {
      setError("Venue name is required.");
      return;
    }
    if (!CITIES.includes(draft.city as (typeof CITIES)[number])) {
      setError("City is required.");
      return;
    }
    const payload: AddVenueDraft = {
      ...draft,
      venue_name: draft.venue_name.trim(),
      notes: draft.notes?.trim() ? draft.notes.trim() : null,
      aliases: parseAliases(aliasesRaw),
      // Zero out rate fields that don't apply to the chosen billing
      // type so a stale value from before the user switched doesn't
      // get persisted.
      per_match_rate: showPerMatch ? draft.per_match_rate : null,
      hourly_rate: showPerHour ? draft.hourly_rate : null,
      cost_per_match:
        showPerMatch || showPerHour ? draft.cost_per_match : null,
    };
    setSaving(true);
    try {
      await onSubmit(payload);
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
        className="w-full max-w-xl rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-3xl uppercase leading-none tracking-tight text-deep-green">
          Add Venue
        </h2>
        <p className="mt-1 text-xs text-deep-green/55">
          Creates a venue row that flows into Field Costs, Billing Schedule,
          and every revenue/cost surface. After save you can seed a billing
          schedule for it from the next tab.
        </p>

        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Venue name">
            <input
              type="text"
              value={draft.venue_name}
              onChange={(e) =>
                setDraft({ ...draft, venue_name: e.target.value })
              }
              placeholder="e.g., Galatzan Park"
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          <Field label="City">
            <select
              value={draft.city}
              onChange={(e) => setDraft({ ...draft, city: e.target.value })}
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              {CITIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Billing type">
            <select
              value={draft.billing_type}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  billing_type: e.target.value as FinVenue["billing_type"],
                })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            >
              {BILLING_TYPE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </Field>

          {showPerMatch && (
            <Field label="Per-match rate ($)">
              <input
                type="number"
                step="0.01"
                min="0"
                value={draft.per_match_rate ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    per_match_rate: parseNum(e.target.value),
                  })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
          )}

          {showPerHour && (
            <Field label="Hourly rate ($)">
              <input
                type="number"
                step="0.01"
                min="0"
                value={draft.hourly_rate ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    hourly_rate: parseNum(e.target.value),
                  })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
          )}

          {(showPerMatch || showPerHour) && (
            <Field label="Cost/match ($) — for Match P&L">
              <input
                type="number"
                step="0.01"
                min="0"
                value={draft.cost_per_match ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    cost_per_match: parseNum(e.target.value),
                  })
                }
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
              />
            </Field>
          )}

          <Field label="Max spots">
            <input
              type="number"
              step="1"
              min="0"
              value={draft.max_spots ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, max_spots: parseNum(e.target.value) })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          <Field label="DPP price ($)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.dpp_price ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, dpp_price: parseNum(e.target.value) })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          <Field label="Member price ($)">
            <input
              type="number"
              step="0.01"
              min="0"
              value={draft.member_price ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  member_price: parseNum(e.target.value),
                })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-right font-mono text-sm tabular-nums text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>

          <Field label="Launch date">
            <input
              type="date"
              value={draft.launch_date ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  launch_date: e.target.value || null,
                })
              }
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="Notes">
            <textarea
              value={draft.notes ?? ""}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={2}
              className="w-full resize-y rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
          </Field>
        </div>

        <div className="mt-4">
          <Field label='Also known as — comma-separated raw match-feed names'>
            <input
              type="text"
              value={aliasesRaw}
              onChange={(e) => setAliasesRaw(e.target.value)}
              placeholder="e.g., Galatzan, Galatzan Park ELP"
              className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            <div className="mt-1 text-[11px] text-deep-green/55">
              Each entry becomes a row in fin_venue_aliases mapping that raw
              name to the venue&apos;s canonical name. Leave empty if the
              match feed already uses the canonical name above.
            </div>
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
            {saving ? "Adding…" : "Add Venue"}
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
