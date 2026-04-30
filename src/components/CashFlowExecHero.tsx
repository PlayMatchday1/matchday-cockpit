"use client";

import { useMemo } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  monthOverMonthDeltas,
  type MoMDelta,
  type MonthOverMonthDeltas,
} from "@/lib/financeStats";

const PROJECTION_TOOLTIP =
  "Estimate seeded April 25. Will be replaced when next month's Stripe data is uploaded.";

const NEAR_ZERO = 1; // < $1 absolute delta → "no significant change"

export default function CashFlowExecHero() {
  const { data, loading, error } = useFinanceData();

  const result: MonthOverMonthDeltas | null = useMemo(
    () => (data ? monthOverMonthDeltas(data) : null),
    [data],
  );

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
  if (!result) return null;

  // No comparison possible — render single muted card.
  if (!result.currentMonth || !result.nextMonth) {
    return (
      <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div aria-hidden className="h-1 w-full bg-mint" />
        <div className="px-6 py-5 sm:px-7 sm:py-6">
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
            Looking ahead
          </div>
          <div className="mt-2 text-sm italic text-deep-green/55">
            No comparison data available — Q2 is the last quarter with
            projections.
          </div>
        </div>
      </section>
    );
  }

  const { biggestExpenseDelta, biggestRevenueDelta, netDelta, currentMonth, nextMonth } = result;
  const eyebrowLabel = `Looking ahead — ${shortMonth(nextMonth)} vs ${shortMonth(currentMonth)}`;

  return (
    <section className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div aria-hidden className="h-1 w-full bg-mint" />
      <div className="px-6 pt-5 sm:px-7 sm:pt-6">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
          {eyebrowLabel}
        </div>
      </div>
      <div className="grid grid-cols-1 divide-y divide-cream-line md:grid-cols-3 md:divide-x md:divide-y-0">
        <ExpenseCard delta={biggestExpenseDelta} />
        <RevenueCard delta={biggestRevenueDelta} />
        <NetCard
          netDelta={netDelta}
          currentMonth={currentMonth}
          nextMonth={nextMonth}
        />
      </div>
    </section>
  );
}

function ExpenseCard({ delta }: { delta: MoMDelta | null }) {
  if (!delta || Math.abs(delta.delta) < NEAR_ZERO) {
    return (
      <Card label="Biggest expense change" muted>
        No significant change
      </Card>
    );
  }
  // Expenses going DOWN is good (mint); going UP is bad (coral).
  const tone: Tone = delta.delta < 0 ? "good" : "bad";
  return (
    <Card label="Biggest expense change">
      <Headline tone={tone}>
        {delta.label} {fmtSig(delta.delta)}
      </Headline>
      <Subtitle fromProjection={delta.driverFromProjection}>{delta.driver}</Subtitle>
    </Card>
  );
}

function RevenueCard({ delta }: { delta: MoMDelta | null }) {
  if (!delta || Math.abs(delta.delta) < NEAR_ZERO) {
    return (
      <Card label="Biggest revenue change" muted>
        No significant change
      </Card>
    );
  }
  // Revenue going UP is good (mint); going DOWN is bad (coral).
  const tone: Tone = delta.delta > 0 ? "good" : "bad";
  return (
    <Card label="Biggest revenue change">
      <Headline tone={tone}>
        {delta.label} {fmtSig(delta.delta)}
      </Headline>
      <Subtitle fromProjection={delta.driverFromProjection}>{delta.driver}</Subtitle>
    </Card>
  );
}

function NetCard({
  netDelta,
  currentMonth,
  nextMonth,
}: {
  netDelta: MonthOverMonthDeltas["netDelta"];
  currentMonth: string;
  nextMonth: string;
}) {
  if (!netDelta || Math.abs(netDelta.delta) < NEAR_ZERO) {
    return (
      <Card label="Net month-over-month change" muted>
        No significant change
      </Card>
    );
  }
  const tone: Tone = netDelta.delta > 0 ? "good" : "bad";
  const arrow = netDelta.delta > 0 ? "↑" : "↓";
  return (
    <Card label="Net month-over-month change">
      <Headline tone={tone}>
        {arrow} {fmtSig(netDelta.delta)}
      </Headline>
      <Subtitle>
        Net P&amp;L: {shortMonth(currentMonth)} {fmtSig(netDelta.current)} →{" "}
        {shortMonth(nextMonth)} {fmtSig(netDelta.next)}
      </Subtitle>
    </Card>
  );
}

type Tone = "good" | "bad";

function Card({
  label,
  muted,
  children,
}: {
  label: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="px-6 py-5 sm:px-7 sm:py-6">
      <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
        {label}
      </div>
      {muted ? (
        <div className="mt-2 text-sm italic text-deep-green/45">{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

function Headline({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const cls = tone === "good" ? "text-mint-hover" : "text-coral";
  return (
    <div
      className={`mt-2 font-display text-3xl uppercase leading-none tracking-tight md:text-4xl ${cls}`}
    >
      {children}
    </div>
  );
}

function Subtitle({
  fromProjection,
  children,
}: {
  fromProjection?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs text-deep-green/65">
      <span>{children}</span>
      {fromProjection && (
        <span
          title={PROJECTION_TOOLTIP}
          aria-label={PROJECTION_TOOLTIP}
          className="inline-flex h-[13px] w-[13px] cursor-help items-center justify-center rounded-full bg-deep-green/15 text-[9px] font-bold leading-none text-deep-green/70 transition hover:bg-deep-green/25 hover:text-deep-green"
        >
          i
        </span>
      )}
    </div>
  );
}

function shortMonth(month: string): string {
  // "Apr 2026" → "Apr"
  return month.split(" ")[0];
}

function fmt(n: number): string {
  return Math.round(Math.abs(n)).toLocaleString("en-US");
}

function fmtSig(n: number): string {
  if (Math.round(n) === 0) return "$0";
  return n > 0 ? `+$${fmt(n)}` : `-$${fmt(n)}`;
}
