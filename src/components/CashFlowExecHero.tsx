"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  getQ2MonthPairs,
  monthOverMonthDeltas,
  type MoMLineItem,
  type MonthOverMonthDeltas,
  type Q2Month,
  type Q2MonthPair,
} from "@/lib/financeStats";

const PROJECTION_TOOLTIP =
  "Estimate seeded April 25. Will be replaced when next month's Stripe data is uploaded.";

const VISIBLE_THRESHOLD = 500; // |Δ| < $500 → omitted from list

export default function CashFlowExecHero() {
  const { data, loading, error } = useFinanceData();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Adjacent Q2 month pairs + the default-selected one.
  const pairs = useMemo(() => getQ2MonthPairs(), []);
  const defaultPair = pairs.find((p) => p.isDefault) ?? pairs[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    defaultPair ? pairKey(defaultPair) : null,
  );
  // Re-sync if the pair list changes (e.g., underlying data refresh
  // shifted today's month). Cheap idempotent default-picker.
  useEffect(() => {
    if (!selectedKey && defaultPair) {
      setSelectedKey(pairKey(defaultPair));
    }
  }, [selectedKey, defaultPair]);
  const selectedPair =
    pairs.find((p) => pairKey(p) === selectedKey) ?? defaultPair;

  const result: MonthOverMonthDeltas | null = useMemo(() => {
    if (!data) return null;
    return monthOverMonthDeltas(
      data,
      selectedPair?.current ?? null,
      selectedPair?.next ?? null,
    );
  }, [data, selectedPair]);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
            Looking ahead — {shortMonth(nextMonth)} vs {shortMonth(currentMonth)}
          </div>
          {pairs.length > 1 && (
            <PairToggle
              pairs={pairs}
              selectedKey={selectedKey}
              onSelect={(p) => setSelectedKey(pairKey(p))}
            />
          )}
        </div>
      </div>

      <div className="mt-3 px-6 sm:px-7">
        {visible.length === 0 ? (
          <div className="py-3 text-sm italic text-deep-green/45">
            No significant category-level changes.
          </div>
        ) : (
          <ul className="divide-y divide-cream-line/60">
            {visible.map((li) => {
              const key = `${li.kind}|${li.name}`;
              return (
                <LineRow
                  key={key}
                  item={li}
                  expanded={expanded.has(key)}
                  onToggle={() => toggle(key)}
                />
              );
            })}
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

function LineRow({
  item,
  expanded,
  onToggle,
}: {
  item: MoMLineItem;
  expanded: boolean;
  onToggle: () => void;
}) {
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
  const hasChildren = (item.children?.length ?? 0) > 0;

  const headerInner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-deep-green">{item.name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-deep-green/60">
          <span className="truncate">{item.driver}</span>
          {item.isProjectionDriven && <ProjectionIcon />}
        </div>
      </div>
      <div className="flex shrink-0 items-baseline gap-2.5">
        {hasChildren ? (
          expanded ? (
            <ChevronDown
              size={16}
              aria-hidden
              className="self-center text-deep-green/45 transition group-hover:text-deep-green/75"
            />
          ) : (
            <ChevronRight
              size={16}
              aria-hidden
              className="self-center text-deep-green/45 transition group-hover:text-deep-green/75"
            />
          )
        ) : (
          <span aria-hidden className="inline-block w-4" />
        )}
        <div
          className={`font-mono text-base font-bold tabular-nums ${valueCls}`}
        >
          {fmtSig(item.delta)}
        </div>
      </div>
    </>
  );

  return (
    <li className={projectionMuted ? "opacity-80" : ""}>
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="group -mx-2 flex w-full cursor-pointer items-baseline justify-between gap-4 rounded px-2 py-3 text-left transition hover:bg-cream-soft/40"
        >
          {headerInner}
        </button>
      ) : (
        <div className="-mx-2 flex items-baseline justify-between gap-4 px-2 py-3">
          {headerInner}
        </div>
      )}

      {hasChildren && (
        // grid-rows trick — animates from 0fr → 1fr for smooth height
        // transition without JS measurement. The inner overflow-hidden
        // wrapper is what actually clips during the animation.
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-out ${
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <div className="space-y-1.5 pb-3 pl-7 pr-1">
              {item.children!.map((child) => (
                <SubRow
                  key={child.name}
                  parentKind={item.kind}
                  projectionMuted={projectionMuted}
                  name={child.name}
                  delta={child.delta}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function SubRow({
  parentKind,
  projectionMuted,
  name,
  delta,
}: {
  parentKind: "expense" | "revenue";
  projectionMuted: boolean;
  name: string;
  delta: number;
}) {
  // Apply parent's tone palette to the sub-row's own delta sign:
  // expenses up=coral/down=mint; revenue up=mint/down=coral.
  const isGood = parentKind === "expense" ? delta < 0 : delta > 0;
  const valueCls = projectionMuted
    ? isGood
      ? "text-mint-hover/60"
      : "text-coral/60"
    : isGood
      ? "text-mint-hover"
      : "text-coral";
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="truncate text-deep-green/70">{name}</span>
      <span className={`shrink-0 font-mono font-semibold tabular-nums ${valueCls}`}>
        {fmtSig(delta)}
      </span>
    </div>
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

function pairKey(p: { current: Q2Month; next: Q2Month }): string {
  return `${p.current}|${p.next}`;
}

function PairToggle({
  pairs,
  selectedKey,
  onSelect,
}: {
  pairs: Q2MonthPair[];
  selectedKey: string | null;
  onSelect: (p: Q2MonthPair) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Month-pair comparison"
      className="inline-flex flex-wrap items-center gap-1.5"
    >
      {pairs.map((p) => {
        const k = pairKey(p);
        const active = selectedKey === k;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(p)}
            className={
              active
                ? "rounded-full bg-mint px-3 py-1 text-[11px] font-bold text-deep-green transition hover:bg-mint-hover"
                : "rounded-full border border-cream-line bg-white px-3 py-1 text-[11px] font-bold text-deep-green/65 transition hover:bg-cream-soft hover:text-deep-green"
            }
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function fmtSig(n: number): string {
  if (Math.round(n) === 0) return "$0";
  const abs = Math.round(Math.abs(n)).toLocaleString("en-US");
  return n > 0 ? `+$${abs}` : `-$${abs}`;
}
