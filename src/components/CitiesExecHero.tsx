"use client";

import {
  getWeeklyCancellationStats,
  getWeeklySpots,
} from "@/lib/cityStats";
import { isActiveMember } from "@/lib/membershipStats";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";

// Network-wide ops hero for /cities. Four big stats, no toggles —
// always reflects the in-progress current week. Same surface
// treatment as FinanceExecHero so the two read as one design system.

export default function CitiesExecHero() {
  const { rows, meta, loading } = useMatchData();
  const { data: finData } = useFinanceData();

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading network data…
      </div>
    );
  }
  if (!meta) return null;

  const weekly = getWeeklySpots(rows, null, 8);
  const currentWeek = weekly[weekly.length - 1];
  const cancelStats = getWeeklyCancellationStats(rows, null, 1);
  const currentCancel = cancelStats[cancelStats.length - 1];
  const fillRate =
    currentCancel.scheduled === 0
      ? 0
      : (currentCancel.ran / currentCancel.scheduled) * 100;

  const activeMembers = (finData?.members ?? []).filter(isActiveMember).length;

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div aria-hidden className="h-1 w-full bg-mint" />
      <div className="grid grid-cols-2 divide-y divide-cream-line md:grid-cols-4 md:divide-x md:divide-y-0 md:divide-y-0">
        <Stat
          label="Matches this week"
          value={currentWeek.matches.toString()}
          subtitle={`${currentWeek.spots.toLocaleString()} spots booked`}
        />
        <Stat
          label="Fill rate this week"
          value={
            currentCancel.scheduled === 0 ? "—" : `${Math.round(fillRate)}%`
          }
          subtitle={
            currentCancel.scheduled === 0
              ? "no matches scheduled"
              : `${currentCancel.ran} of ${currentCancel.scheduled} ran`
          }
        />
        <Stat
          label="Cancel % this week"
          value={
            currentCancel.scheduled === 0
              ? "—"
              : `${Math.round(currentCancel.rate)}%`
          }
          tone={currentCancel.rate > 20 ? "down" : undefined}
          subtitle={
            currentCancel.scheduled === 0
              ? "no matches scheduled"
              : `${currentCancel.canceled} canceled`
          }
        />
        <Stat
          label="Active members"
          value={activeMembers.toLocaleString()}
          subtitle={
            finData ? "network-wide" : "loading…"
          }
        />
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  subtitle,
  tone,
}: {
  label: string;
  value: string;
  subtitle?: string;
  tone?: "down";
}) {
  const valueCls =
    tone === "down" ? "text-coral" : "text-deep-green";
  return (
    <div className="px-5 py-5 sm:px-6 sm:py-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
        {label}
      </div>
      <div
        className={`mt-2 font-display text-4xl uppercase leading-none tracking-tight md:text-5xl ${valueCls}`}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-2 text-xs text-deep-green/65">{subtitle}</div>
      )}
    </div>
  );
}
