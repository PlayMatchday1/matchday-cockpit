"use client";

import { useMemo } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import {
  CANCEL_PATTERNS_DOW_LABELS,
  getCancelPatterns,
  type CancelSlot,
} from "@/lib/cancelPatterns";

const PILL_COLORS: Record<CancelSlot["repeatCount"], string> = {
  4: "bg-[#DC2626] text-[#FFF1F1]",
  3: "bg-[#7F1D1D] text-[#FFE5E5]",
  2: "bg-[#F59E0B] text-[#422006]",
  1: "bg-[rgba(0,51,38,0.08)] text-[#003326]",
};

export default function CancelPatterns() {
  const { rows, meta, loading } = useMatchData();
  const { data: finData } = useFinanceData();
  const aliases = finData?.venueAliases ?? new Map<string, string>();

  const result = useMemo(
    () => getCancelPatterns(rows, aliases),
    [rows, aliases],
  );

  if (loading || !meta) return null;

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

      {result.totalSlots === 0 ? (
        <div className="mt-5 rounded-xl bg-cream-soft px-4 py-8 text-center text-sm text-deep-green/60">
          No cancellations in the last 4 completed weeks.
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          {result.weeks.map((wk) => (
            <div key={wk.rangeLabel}>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-deep-green/55">
                {wk.rangeLabel}
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
                    {wk.byDay[dowIdx].map((slot, i) => (
                      <div
                        key={`${slot.canonicalField}|${slot.time}|${i}`}
                        className={`rounded-sm px-1.5 py-0.5 font-mono text-[10px] tabular-nums leading-tight ${PILL_COLORS[slot.repeatCount]}`}
                        title={`${slot.canonicalField} · ${slot.dow} ${slot.time} · canceled ${slot.repeatCount} of 4 weeks`}
                      >
                        {slot.venueCode} {slot.time}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-deep-green/70">
        <LegendSwatch tier={4} label="Canceled 4 of 4 weeks (chronic)" />
        <LegendSwatch tier={3} label="3 of 4" />
        <LegendSwatch tier={2} label="2 of 4" />
        <LegendSwatch tier={1} label="1 of 4 (one-off)" />
      </div>
    </section>
  );
}

function LegendSwatch({
  tier,
  label,
}: {
  tier: CancelSlot["repeatCount"];
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
