"use client";

import {
  getWeeklyCancellationStats,
  getWeeklySpots,
} from "@/lib/cityStats";
import { isActiveMember } from "@/lib/membershipStats";
import { useMatchWindowData } from "@/lib/useMatchData";
import { useMembers } from "@/lib/useMembers";

// Network-wide ops hero for /cities. Four big stats, no toggles —
// always reflects the in-progress current week. Same surface
// treatment as FinanceExecHero so the two read as one design system.

export default function CitiesExecHero() {
  // 12-week window — see useMatchWindowData header. Shares the cache
  // with OverviewLens so /cities only fires one match-data fetch.
  const { rows, meta, loading } = useMatchWindowData(12);
  // useMembers pulls only mdapi_subscriptions for the active-member
  // count below. Replaced useFinanceData so /cities no longer pays for
  // the 13-table finance-page fetch just to render one stat tile.
  const { members, loading: membersLoading } = useMembers();

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
  const runRate =
    currentCancel.scheduled === 0
      ? 0
      : (currentCancel.ran / currentCancel.scheduled) * 100;

  const activeMembers = members.filter(isActiveMember).length;

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
          label="Match run rate"
          value={
            currentCancel.scheduled === 0 ? "—" : `${Math.round(runRate)}%`
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
          subtitle={membersLoading ? "loading…" : "network-wide"}
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
