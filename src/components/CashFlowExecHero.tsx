"use client";

import { useMemo } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  monthOverMonthDeltas,
  type MoMLineItem,
  type MonthOverMonthDeltas,
} from "@/lib/financeStats";

const PROJECTION_TOOLTIP =
  "Estimate seeded April 25. Will be replaced when next month's Stripe data is uploaded.";

const VISIBLE_THRESHOLD = 500; // |Δ| < $500 → omitted from list

export default function CashFlowExecHero() {
  const { data, loading, error } = useFinanceData();

  const result: MonthOverMonthDeltas | null = useMemo(
    () => (data ? monthOverMonthDeltas(data) : null),
    [data],
  );

  if (loading) {
    return (
      <Panel>
        <PanelHeader />
        <div className="px-6 py-5 sm:px-7">
          <SkeletonRows />
        </div>
      </Panel>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-coral/40 bg-coral-soft p-6 text-sm text-coral">
        {error}
      </div>
    );
  }
  if (!result) return null;

  // No comparison possible
  if (!result.currentMonth || !result.nextMonth || !result.netDelta) {
    return (
      <Panel>
        <div className="px-6 py-5 sm:px-7 sm:py-6">
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
            Looking ahead
          </div>
          <div className="mt-2 text-sm italic text-deep-green/55">
            No comparison data available — Q2 is the last quarter with
            projections.
          </div>
        </div>
      </Panel>
    );
  }

  const { currentMonth, nextMonth, netDelta } = result;
  const visible = result.lineItems.filter(
    (li) => Math.abs(li.delta) >= VISIBLE_THRESHOLD,
  );

  return (
    <Panel>
      <div className="px-6 pt-5 sm:px-7 sm:pt-6">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
          Looking ahead — {shortMonth(nextMonth)} vs {shortMonth(currentMonth)}
        </div>
      </div>

      <div className="mt-3 px-6 sm:px-7">
        {visible.length === 0 ? (
          <div className="py-3 text-sm italic text-deep-green/45">
            No significant category-level changes.
          </div>
        ) : (
          <ul className="divide-y divide-cream-line/60">
            {visible.map((li) => (
              <LineRow key={`${li.kind}|${li.name}`} item={li} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-3 border-t-2 border-cream-line bg-cream-soft/40 px-6 py-4 sm:px-7">
        <NetFooter
          netDelta={netDelta}
          currentMonth={currentMonth}
          nextMonth={nextMonth}
        />
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div aria-hidden className="h-1 w-full bg-mint" />
      {children}
    </section>
  );
}

function PanelHeader() {
  return (
    <div className="px-6 pt-5 sm:px-7 sm:pt-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
        Looking ahead
      </div>
    </div>
  );
}

function LineRow({ item }: { item: MoMLineItem }) {
  // Tone: expenses up=coral / down=mint; revenue up=mint / down=coral.
  const isGood =
    item.kind === "expense" ? item.delta < 0 : item.delta > 0;
  const projectionMuted = item.isProjectionDriven;
  const valueCls = projectionMuted
    ? isGood
      ? "text-mint-hover/60"
      : "text-coral/60"
    : isGood
      ? "text-mint-hover"
      : "text-coral";

  return (
    <li
      className={`flex items-baseline justify-between gap-4 py-3 ${
        projectionMuted ? "opacity-80" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-deep-green">{item.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-deep-green/60">
          <span className="truncate">{item.driver}</span>
          {item.isProjectionDriven && <ProjectionIcon />}
        </div>
      </div>
      <div
        className={`shrink-0 font-mono text-base font-bold tabular-nums ${valueCls}`}
      >
        {fmtSig(item.delta)}
      </div>
    </li>
  );
}

function NetFooter({
  netDelta,
  currentMonth,
  nextMonth,
}: {
  netDelta: { current: number; next: number; delta: number };
  currentMonth: string;
  nextMonth: string;
}) {
  const isPositive = netDelta.delta > 0;
  const isZero = Math.round(netDelta.delta) === 0;
  const arrow = isZero ? "→" : isPositive ? "↑" : "↓";
  const valueCls = isZero
    ? "text-deep-green/65"
    : isPositive
      ? "text-mint-hover"
      : "text-coral";
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/65">
        Net month-over-month change
      </div>
      <div
        className={`font-display text-3xl uppercase leading-none tracking-tight ${valueCls}`}
      >
        {arrow} {fmtSig(netDelta.delta)}
      </div>
      <div className="basis-full text-xs text-deep-green/60">
        Net P&amp;L: {shortMonth(currentMonth)} {fmtSig(netDelta.current)} →{" "}
        {shortMonth(nextMonth)} {fmtSig(netDelta.next)}
      </div>
    </div>
  );
}

function ProjectionIcon() {
  return (
    <span
      title={PROJECTION_TOOLTIP}
      aria-label={PROJECTION_TOOLTIP}
      className="inline-flex h-[13px] w-[13px] shrink-0 cursor-help items-center justify-center rounded-full bg-deep-green/15 text-[9px] font-bold leading-none text-deep-green/70 transition hover:bg-deep-green/25 hover:text-deep-green"
    >
      i
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul className="divide-y divide-cream-line/60">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-baseline justify-between gap-4 py-3"
        >
          <div className="min-w-0 flex-1">
            <div className="h-3 w-32 rounded bg-cream-soft" />
            <div className="mt-2 h-2 w-48 rounded bg-cream-soft/70" />
          </div>
          <div className="h-4 w-16 rounded bg-cream-soft" />
        </li>
      ))}
    </ul>
  );
}

function shortMonth(month: string): string {
  return month.split(" ")[0];
}

function fmtSig(n: number): string {
  if (Math.round(n) === 0) return "$0";
  const abs = Math.round(Math.abs(n)).toLocaleString("en-US");
  return n > 0 ? `+$${abs}` : `-$${abs}`;
}
