"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  projectedEndingCash,
  quarterExpensesActual,
  quarterExpensesProjected,
  quarterNetPLProjected,
  quarterNetRevenueActual,
  quarterNetRevenueProjected,
  startingCash,
} from "@/lib/financeStats";

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}$${fmt(abs)}`;
}

export default function FinanceHeroMetrics() {
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

  const start = startingCash(data, quarter);
  const ending = projectedEndingCash(data, quarter);
  const netRev = quarterNetRevenueProjected(data, quarter);
  const totExp = quarterExpensesProjected(data, quarter);
  const netPL = quarterNetPLProjected(data, quarter);
  const netRevActual = quarterNetRevenueActual(data, quarter);
  const totExpActual = quarterExpensesActual(data, quarter);
  const netRevProjected = netRev - netRevActual;
  const totExpProjected = totExp - totExpActual;
  // Empty state — no revenue + no expenses for this quarter (typical
  // for planning quarters before any data is entered). Render the
  // em-dash placeholder in each card's value slot rather than $0.
  const noData = netRev === 0 && totExp === 0 && netPL === 0;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card
        label="Projected Ending Cash"
        value={noData ? null : fmtMoney(ending)}
        subtitle={noData ? "No data yet" : `$${fmt(start)} start · $${fmt(netPL)} net P&L`}
      />
      <Card
        label={`${quarter.label} Net P&L`}
        value={noData ? null : fmtMoney(netPL)}
        subtitle={noData ? "No data yet" : `$${fmt(netRev)} rev − $${fmt(totExp)} exp`}
        toneFromValue={noData ? undefined : netPL}
      />
      <Card
        label={`${quarter.label} Projected Net Revenue`}
        value={noData ? null : fmtMoney(netRev)}
        subtitle={
          noData
            ? "No data yet"
            : `${fmtMoney(netRevActual)} actual + ${fmtMoney(netRevProjected)} projected`
        }
      />
      <Card
        label={`${quarter.label} Projected Expenses`}
        value={noData ? null : fmtMoney(totExp)}
        subtitle={
          noData
            ? "No data yet"
            : `${fmtMoney(totExpActual)} actual + ${fmtMoney(totExpProjected)} projected`
        }
      />
    </div>
  );
}

function Card({
  label,
  value,
  subtitle,
  toneFromValue,
}: {
  label: string;
  // null = empty-state (no data yet for this quarter); renders an
  // em-dash placeholder in the same dimensions as a real value so
  // the grid doesn't shift.
  value: string | null;
  subtitle?: string;
  toneFromValue?: number;
}) {
  const valueColor =
    toneFromValue === undefined
      ? "text-deep-green"
      : toneFromValue >= 0
        ? "text-mint-hover"
        : "text-coral";
  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/60">
        {label}
      </div>
      <div
        className={`mt-2 font-display text-4xl uppercase leading-none tracking-tight md:text-5xl ${value === null ? "text-deep-green/30" : valueColor}`}
      >
        {value ?? "—"}
      </div>
      {subtitle && (
        <div className="mt-3 text-xs text-deep-green/55">{subtitle}</div>
      )}
    </div>
  );
}
