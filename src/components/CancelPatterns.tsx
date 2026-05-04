"use client";

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import {
  CANCEL_PATTERNS_DOW_LABELS,
  getCancelPatterns,
  type CancelPatternsMode,
} from "@/lib/cancelPatterns";

type ColorTier = 1 | 2 | 3 | 4;

const PILL_COLORS: Record<ColorTier, string> = {
  4: "bg-[#DC2626] text-white",
  3: "bg-[#7F1D1D] text-white",
  2: "bg-[#F59E0B] text-[#1C1917]",
  1: "bg-[rgba(0,51,38,0.08)] text-[#003326]",
};

export default function CancelPatterns() {
  const { rows, meta, loading } = useMatchData();
  const { data: finData } = useFinanceData();
  const aliases = finData?.venueAliases ?? new Map<string, string>();
  const [mode, setMode] = useState<CancelPatternsMode>("patterns");

  const result = useMemo(
    () => getCancelPatterns(rows, aliases, mode),
    [rows, aliases, mode],
  );

  if (loading || !meta) return null;

  const isPatterns = mode === "patterns";
  const subtitle = isPatterns
    ? "Last 4 fully completed weeks · color shows count of weeks canceled across the window"
    : "Current week + 3 prior · current week gets chronic colors (may be sparse mid-week)";
  const topWeekTag = isPatterns ? "(most recent)" : "(current)";
  const emptyText = isPatterns
    ? "No cancellations in the last 4 completed weeks."
    : "No cancellations in the current view.";
  const helperText = isPatterns
    ? "Color highlights apply across all 4 weeks. Brighter = more weeks canceled, regardless of order."
    : "Color highlights apply to the current week. Prior weeks shown as context. Current week may be sparse early in the week.";

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-deep-green/55">
        Cancel Patterns · Last 4 Weeks
      </div>
      <h3 className="mt-1 font-display text-2xl uppercase leading-tight tracking-tight text-deep-green md:text-3xl">
        All cities
      </h3>
      <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
        Every canceled match across all cities, week by week. Color shows how
        chronic the slot is — bright red means the same slot has been
        canceled all 4 weeks running.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label="View mode"
          className="inline-flex rounded-md border border-cream-line bg-cream-soft/60 p-0.5"
        >
          {(
            [
              { id: "patterns", label: "Patterns" },
              { id: "live", label: "This Week" },
            ] as { id: CancelPatternsMode; label: string }[]
          ).map((opt) => {
            const active = mode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(opt.id)}
                className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition ${
                  active
                    ? "bg-white text-deep-green shadow-sm"
                    : "text-deep-green/55 hover:text-deep-green"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <span className="text-[11px] text-deep-green/55">{subtitle}</span>
      </div>

      {result.totalSlots === 0 ? (
        <div className="mt-5 rounded-xl bg-cream-soft px-4 py-8 text-center text-sm text-deep-green/60">
          {emptyText}
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {result.weeks.map((wk, weekIdx) => {
            // Color tier sourcing differs by mode:
            //   "patterns" — every cell uses cancelCount, so colors
            //     surface the same slot in every week it canceled.
            //   "live" — only the current (top) week uses streak;
            //     older weeks render muted (tier 1) so the actionable
            //     signal stays on this week.
            const isCurrentWeek = weekIdx === 0;
            return (
              <div key={wk.rangeLabel}>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-deep-green/55">
                  {wk.rangeLabel}
                  {isCurrentWeek && (
                    <span className="ml-2 font-normal text-deep-green/45">
                      {topWeekTag}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {CANCEL_PATTERNS_DOW_LABELS.map((dowLabel, dowIdx) => (
                    <div
                      key={dowLabel}
                      className="flex min-h-[68px] flex-col gap-1 rounded-md bg-cream-soft/60 p-1.5"
                    >
                      <div className="text-[9px] font-bold uppercase tracking-wider text-deep-green/45">
                        {dowLabel}
                      </div>
                      {wk.byDay[dowIdx].map((slot, i) => {
                        const colorTier: ColorTier = isPatterns
                          ? slot.cancelCount
                          : isCurrentWeek
                            ? slot.streak
                            : 1;
                        const tooltip = isPatterns
                          ? `${slot.canonicalField} · ${slot.dow} ${slot.time} · canceled ${slot.cancelCount} of 4 weeks`
                          : `${slot.canonicalField} · ${slot.dow} ${slot.time} · ${slot.streak === 1 ? "canceled this week" : `${slot.streak} weeks running`}`;
                        return (
                          <div
                            key={`${slot.canonicalField}|${slot.time}|${i}`}
                            className={`rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums leading-tight ${PILL_COLORS[colorTier]}`}
                            title={tooltip}
                          >
                            {slot.venueCode} {slot.time}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Legend — labels are mode-aware so the same color tokens
          read correctly under each scoring rule. */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-deep-green/70">
        {isPatterns ? (
          <>
            <LegendSwatch tier={4} label="Canceled 4 of 4 weeks (chronic)" />
            <LegendSwatch tier={3} label="3 of 4 weeks" />
            <LegendSwatch tier={2} label="2 of 4 weeks" />
            <LegendSwatch tier={1} label="1 week canceled" />
          </>
        ) : (
          <>
            <LegendSwatch tier={4} label="Canceled 4 weeks running (chronic)" />
            <LegendSwatch tier={3} label="3 weeks running" />
            <LegendSwatch tier={2} label="2 weeks running" />
            <LegendSwatch tier={1} label="Canceled this week" />
          </>
        )}
      </div>
      <p className="mt-2 text-[11px] italic text-deep-green/50">{helperText}</p>
    </section>
  );
}

function LegendSwatch({
  tier,
  label,
}: {
  tier: ColorTier;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={`inline-block h-3 w-5 rounded-sm ${PILL_COLORS[tier]}`}
      />
      <span>{label}</span>
    </div>
  );
}
