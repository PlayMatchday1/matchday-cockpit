"use client";

import { useEffect, useMemo, useState } from "react";
import type { FinVenue, FinVenueCostOverride } from "@/lib/useFinanceData";
import { Q2_MONTHS, type Q2Month } from "@/lib/financeStats";

export type BulkScheduleDraft = {
  venue_id: number;
  venue_name: string;
  city: string;
  month: Q2Month;
  dates: string[];
  // Per-date multipliers — applied uniformly across every date.
  match_count: number;
  total_hours: number | null;
};

const ISO_DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function parseDateList(input: string): { dates: string[]; bad: string[] } {
  const tokens = input
    .split(/[\s,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const dates: string[] = [];
  const bad: string[] = [];
  for (const t of tokens) {
    if (ISO_DATE_RX.test(t)) {
      const d = new Date(t + "T00:00:00");
      if (!Number.isNaN(d.getTime())) {
        dates.push(t);
        continue;
      }
    }
    bad.push(t);
  }
  return { dates: [...new Set(dates)].sort(), bad };
}

function fmtMoney(n: number): string {
  const r = Math.round(n);
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

function monthMatches(date: string, month: Q2Month): boolean {
  // 'Apr 2026' → '2026-04'
  const lookup: Record<Q2Month, string> = {
    "Apr 2026": "2026-04",
    "May 2026": "2026-05",
    "Jun 2026": "2026-06",
  };
  return date.startsWith(lookup[month]);
}

export default function ScheduleBulkAddEditor({
  open,
  venues,
  overrides,
  onClose,
  onSubmit,
}: {
  open: boolean;
  venues: FinVenue[];
  overrides: FinVenueCostOverride[];
  onClose: () => void;
  onSubmit: (draft: BulkScheduleDraft) => Promise<void>;
}) {
  const [venueId, setVenueId] = useState<number | null>(null);
  const [month, setMonth] = useState<Q2Month>("Apr 2026");
  const [dateInput, setDateInput] = useState("");
  const [matchCountInput, setMatchCountInput] = useState("1");
  const [totalHoursInput, setTotalHoursInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setVenueId(null);
    setMonth("Apr 2026");
    setDateInput("");
    setMatchCountInput("1");
    setTotalHoursInput("");
  }, [open]);

  const matchCountParsed = parseInt(matchCountInput, 10);
  const matchCountValid =
    Number.isFinite(matchCountParsed) && matchCountParsed >= 1;

  const totalHoursTrimmed = totalHoursInput.trim();
  const totalHoursParsed =
    totalHoursTrimmed === "" ? null : parseFloat(totalHoursTrimmed);
  const totalHoursValid =
    totalHoursParsed === null ||
    (Number.isFinite(totalHoursParsed) && totalHoursParsed >= 0);

  const venue = useMemo(
    () => (venueId ? (venues.find((v) => v.id === venueId) ?? null) : null),
    [venueId, venues],
  );

  const sortedVenues = useMemo(
    () => [...venues].sort((a, b) => a.venue_name.localeCompare(b.venue_name)),
    [venues],
  );

  const parsed = useMemo(() => parseDateList(dateInput), [dateInput]);

  const inMonth = useMemo(
    () => parsed.dates.filter((d) => monthMatches(d, month)),
    [parsed.dates, month],
  );

  const outOfMonth = useMemo(
    () => parsed.dates.filter((d) => !monthMatches(d, month)),
    [parsed.dates, month],
  );

  const activeOverride = useMemo(() => {
    if (!venueId) return null;
    return (
      overrides.find((o) => o.venue_id === venueId && o.month === month) ??
      null
    );
  }, [venueId, month, overrides]);

  if (!open) return null;

  async function handleSubmit() {
    setError(null);
    if (!venue) return setError("Pick a venue.");
    if (inMonth.length === 0) {
      return setError(
        "Add at least one date that falls within the selected month.",
      );
    }
    if (!matchCountValid) {
      return setError("Match Count must be a whole number ≥ 1.");
    }
    if (!totalHoursValid) {
      return setError("Total Hours must be a number ≥ 0 (or blank).");
    }
    setSaving(true);
    try {
      await onSubmit({
        venue_id: venue.id,
        venue_name: venue.venue_name,
        city: venue.city,
        month,
        dates: inMonth,
        match_count: matchCountParsed,
        total_hours: totalHoursParsed,
      });
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
          Bulk Add Matches
        </h2>
        <p className="mt-1 text-xs text-deep-green/55">
          One venue, one month, multiple dates. Each date inserts ONE
          schedule row with the match count + hours below. For dates with
          varied counts (e.g. 3 matches one night, 2 another), use Add
          Match individually after.
        </p>

        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Venue">
              <select
                value={venueId ?? ""}
                onChange={(e) =>
                  setVenueId(e.target.value ? Number(e.target.value) : null)
                }
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
            <Field label="Month">
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value as Q2Month)}
                className="w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-deep-green focus:outline-none"
              >
                {Q2_MONTHS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {venue && (
            <div className="rounded-md border border-cream-line bg-cream-soft/40 px-3 py-2 text-xs text-deep-green/75">
              City: <span className="font-mono">{venue.city}</span> · Billing:{" "}
              <span className="font-mono">{venue.billing_type}</span>
              {venue.billing_type === "per_match" && venue.per_match_rate && (
                <>
                  {" "}
                  · Rate:{" "}
                  <span className="font-mono">${venue.per_match_rate}</span>
                </>
              )}
            </div>
          )}

          {activeOverride && (
            <div className="rounded-md border border-gold/40 bg-gold-soft/40 px-3 py-2 text-xs text-deep-green">
              <strong>⚠️ Override active</strong> for {venue?.venue_name} in{" "}
              {month}: {fmtMoney(activeOverride.override_amount)} (set by{" "}
              {activeOverride.created_by}). Bulk-adding here will increase the
              visible match count but won't change the billed cost while the
              override stands.
            </div>
          )}

          <Field label="Match Dates">
            <textarea
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              rows={5}
              placeholder="2026-05-04, 2026-05-06, 2026-05-09, 2026-05-11&#10;2026-05-13"
              className="w-full resize-y rounded-md border border-cream-line bg-white px-3 py-2 font-mono text-sm text-deep-green focus:border-deep-green focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-deep-green/55">
              Comma, space, semicolon, or newline-separated. ISO format
              (YYYY-MM-DD). Duplicates are deduped.
            </p>
          </Field>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Match Count (per date)">
              <input
                type="number"
                min={1}
                step={1}
                value={matchCountInput}
                onChange={(e) => setMatchCountInput(e.target.value)}
                className={`w-full rounded-md border bg-white px-3 py-2 font-mono text-sm text-deep-green focus:outline-none ${
                  matchCountValid
                    ? "border-cream-line focus:border-deep-green"
                    : "border-coral focus:border-coral"
                }`}
              />
            </Field>
            <Field label="Total Hours (optional, per date)">
              <input
                type="number"
                min={0}
                step="0.5"
                value={totalHoursInput}
                onChange={(e) => setTotalHoursInput(e.target.value)}
                placeholder="—"
                className={`w-full rounded-md border bg-white px-3 py-2 font-mono text-sm text-deep-green focus:outline-none ${
                  totalHoursValid
                    ? "border-cream-line focus:border-deep-green"
                    : "border-coral focus:border-coral"
                }`}
              />
            </Field>
          </div>
          <p className="-mt-2 text-[11px] text-deep-green/55">
            Applied uniformly to every date entered. For varied per-date
            counts, use Add Match individually.
          </p>

          <div className="rounded-md border border-cream-line bg-cream-soft/30 p-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/55">
              Preview
            </div>
            <div className="mt-1 text-sm text-deep-green">
              {venue && inMonth.length > 0 && matchCountValid ? (
                <>
                  <span className="font-mono font-bold tabular-nums">
                    {inMonth.length}
                  </span>{" "}
                  date{inMonth.length === 1 ? "" : "s"} ×{" "}
                  <span className="font-mono font-bold tabular-nums">
                    {matchCountParsed}
                  </span>{" "}
                  match_count ={" "}
                  <span className="font-mono font-bold tabular-nums">
                    {inMonth.length * matchCountParsed}
                  </span>{" "}
                  match{inMonth.length * matchCountParsed === 1 ? "" : "es"} at{" "}
                  {venue.venue_name} in {month}
                  {totalHoursParsed !== null && totalHoursValid && (
                    <>
                      {" "}
                      <span className="text-deep-green/55">
                        ({(totalHoursParsed * inMonth.length).toLocaleString(
                          "en-US",
                          { maximumFractionDigits: 2 },
                        )}{" "}
                        hours total at {totalHoursParsed} hr/date)
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span className="italic text-deep-green/45">
                  Pick a venue, add at least one date, and confirm match
                  count.
                </span>
              )}
            </div>
            {inMonth.length > 0 && (
              <ul className="mt-2 max-h-32 overflow-auto pl-4 font-mono text-[11px] text-deep-green/75">
                {inMonth.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
            {outOfMonth.length > 0 && (
              <div className="mt-2 text-[11px] text-coral">
                Skipped (outside {month}):{" "}
                <span className="font-mono">{outOfMonth.join(", ")}</span>
              </div>
            )}
            {parsed.bad.length > 0 && (
              <div className="mt-2 text-[11px] text-coral">
                Couldn't parse:{" "}
                <span className="font-mono">{parsed.bad.join(", ")}</span>
              </div>
            )}
          </div>
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
            onClick={handleSubmit}
            disabled={
              saving ||
              inMonth.length === 0 ||
              !venue ||
              !matchCountValid ||
              !totalHoursValid
            }
            className="rounded-full bg-mint px-5 py-2 text-xs font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-50"
          >
            {saving
              ? "Adding…"
              : (() => {
                  const total = inMonth.length * (matchCountValid ? matchCountParsed : 0);
                  return total > 0
                    ? `Add ${total} match${total === 1 ? "" : "es"}`
                    : "Add matches";
                })()}
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
