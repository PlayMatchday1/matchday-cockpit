"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import {
  projectedEndingCash,
  q2ExpensesActual,
  q2ExpensesProjected,
  q2NetPLProjected,
  q2NetRevenueActual,
  q2NetRevenueProjected,
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

  const start = startingCash(data);
  const ending = projectedEndingCash(data);
  const netRev = q2NetRevenueProjected(data);
  const totExp = q2ExpensesProjected(data);
  const netPL = q2NetPLProjected(data);
  const netRevActual = q2NetRevenueActual(data);
  const totExpActual = q2ExpensesActual(data);
  const netRevProjected = netRev - netRevActual;
  const totExpProjected = totExp - totExpActual;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Card
        label="Projected Ending Cash"
        value={fmtMoney(ending)}
        subtitle={`$${fmt(start)} start · $${fmt(netPL)} net P&L`}
      />
      <Card
        label="Q2 Net P&L"
        value={fmtMoney(netPL)}
        subtitle={`$${fmt(netRev)} rev − $${fmt(totExp)} exp`}
        toneFromValue={netPL}
      />
      <Card
        label="Q2 Projected Net Revenue"
        value={fmtMoney(netRev)}
        subtitle={`${fmtMoney(netRevActual)} actual + ${fmtMoney(netRevProjected)} projected`}
      />
      <Card
        label="Q2 Projected Expenses"
        value={fmtMoney(totExp)}
        subtitle={`${fmtMoney(totExpActual)} actual + ${fmtMoney(totExpProjected)} projected`}
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
  value: string;
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
        className={`mt-2 font-display text-4xl uppercase leading-none tracking-tight md:text-5xl ${valueColor}`}
      >
        {value}
      </div>
      {subtitle && (
        <div className="mt-3 text-xs text-deep-green/55">{subtitle}</div>
      )}
    </div>
  );
}
