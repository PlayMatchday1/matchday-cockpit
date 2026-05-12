"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  getCurrentMonthInQuarter,
  grossRevenueFor,
  priorMonthSameDayMtdGross,
  quarterNetPLActualClosedMonth,
  quarterNetPLProjected,
} from "@/lib/financeStats";
import { isCurrentQuarter } from "@/lib/quarters";

// Three-stat exec hero: quarter Net P&L (actual + projected),
// current-month Gross with month-end pace, and MTD vs same-day-
// last-month delta. The MTD card is only meaningful for the active
// in-progress quarter — past quarters drop it entirely (no
// substitute card; the hero shrinks to two stats).

export default function FinanceExecHero() {
  const { data, loading, error } = useFinanceData();
  const quarter = useFinanceQuarter();

  if (loading) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10">
        Loading finance data…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-coral/40 bg-coral-soft p-6 text-sm text-coral">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const now = new Date();
  const netPLProjected = quarterNetPLProjected(data, quarter, now);
  // Closed-month actual: each quarter month that has started, summed
  // at its full-month projection. Future months contribute $0; for
  // past quarters all three months are closed so this equals the
  // realized quarter total.
  const actualPL = quarterNetPLActualClosedMonth(data, quarter, now);
  const projectedPL = netPLProjected - actualPL;

  // Show MTD card only when viewing the active quarter — point-in-time
  // semantics don't carry over to past quarters.
  const showMtdCard = isCurrentQuarter(quarter, now);
  const currentMonthKey = getCurrentMonthInQuarter(quarter, now);
  const monthLabelKey = currentMonthKey ?? quarter.months[0].key;
  const monthShort = monthLabelKey.split(" ")[0];

  const monthGrossMtd = currentMonthKey
    ? grossRevenueFor(data, currentMonthKey, "mtd", now)
    : 0;
  const monthGrossPace = currentMonthKey
    ? grossRevenueFor(data, currentMonthKey, "projection", now)
    : 0;
  const priorMtd = priorMonthSameDayMtdGross(data, now);
  const delta = monthGrossMtd - priorMtd;

  const gridCols = showMtdCard ? "md:grid-cols-3" : "md:grid-cols-2";

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div aria-hidden className="h-1 w-full bg-mint" />
      <div
        className={`grid grid-cols-1 divide-y divide-cream-line ${gridCols} md:divide-x md:divide-y-0`}
      >
        <Stat
          label={`${quarter.label} Net P&L`}
          value={fmtSignedMoney(netPLProjected)}
          tone={netPLProjected >= 0 ? "up" : "down"}
          subtitle={`${fmtMoney(actualPL)} actual + ${fmtMoney(projectedPL)} projected`}
        />
        <Stat
          label={
            showMtdCard
              ? `${monthShort} ${quarter.year} Gross Revenue`
              : `${quarter.label} Gross Revenue`
          }
          value={fmtMoney(monthGrossMtd)}
          subtitle={
            showMtdCard
              ? `Pacing ${fmtMoney(monthGrossPace)} by month end`
              : "Last completed month"
          }
        />
        {showMtdCard && (
          <Stat
            label="MTD vs same day last month"
            value={fmtSignedMoney(delta)}
            tone={delta > 0 ? "up" : delta < 0 ? "down" : undefined}
            subtitle={
              priorMtd > 0
                ? `vs ${fmtMoney(priorMtd)} on same day last month`
                : "no prior-month revenue on same day"
            }
          />
        )}
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
  tone?: "up" | "down";
}) {
  const valueCls =
    tone === "up"
      ? "text-mint-hover"
      : tone === "down"
        ? "text-coral"
        : "text-deep-green";
  return (
    <div className="px-6 py-5 sm:px-7 sm:py-6">
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

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${fmt(abs)}`;
}

function fmtSignedMoney(n: number): string {
  if (Math.round(n) === 0) return "$0";
  return n > 0 ? `+$${fmt(n)}` : `-$${fmt(Math.abs(n))}`;
}
