"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import {
  Q2_MONTHS,
  getCurrentQ2Month,
  grossRevenueFor,
  priorMonthSameDayMtdGross,
  q2ExpensesActual,
  q2ExpensesProjected,
  q2NetPLProjected,
  q2NetRevenueActual,
} from "@/lib/financeStats";

// Three-stat exec hero: Q2 Net P&L (actual + projected),
// current-month Gross with month-end pace, and MTD vs same-day-
// last-month delta. No charts. Composes existing helpers — only
// new math is priorMonthSameDayMtdGross.

export default function FinanceExecHero() {
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

  const now = new Date();
  const netPLProjected = q2NetPLProjected(data, now);
  const actualPL =
    q2NetRevenueActual(data, now) - q2ExpensesActual(data, now);
  const projectedPL = netPLProjected - actualPL;

  // Total expenses derived from the same actual+projected math used
  // on the existing Q2 Net Revenue / Q2 Expenses cards — kept here so
  // the subtitle reads as composition, not a parallel calculation.
  // (Unused right now beyond Net P&L, but useful if we want to surface
  // it alongside.)
  void q2ExpensesProjected;

  const currentMonth = getCurrentQ2Month(now);
  const monthGrossMtd = currentMonth
    ? grossRevenueFor(data, currentMonth, "mtd", now)
    : 0;
  const monthGrossPace = currentMonth
    ? grossRevenueFor(data, currentMonth, "projection", now)
    : 0;
  const monthLabel = currentMonth ?? Q2_MONTHS[0];

  const priorMtd = priorMonthSameDayMtdGross(data, now);
  const delta = monthGrossMtd - priorMtd;

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div aria-hidden className="h-1 w-full bg-mint" />
      <div className="grid grid-cols-1 divide-y divide-cream-line md:grid-cols-3 md:divide-x md:divide-y-0">
        <Stat
          label="Q2 Net P&L"
          value={fmtSignedMoney(netPLProjected)}
          tone={netPLProjected >= 0 ? "up" : "down"}
          subtitle={`${fmtMoney(actualPL)} actual + ${fmtMoney(projectedPL)} projected`}
        />
        <Stat
          label={`${monthLabel} Gross Revenue`}
          value={fmtMoney(monthGrossMtd)}
          subtitle={`Pacing ${fmtMoney(monthGrossPace)} by month end`}
        />
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
