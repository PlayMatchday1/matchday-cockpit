"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  EXPENSE_FORECAST_MOVER_THRESHOLD,
  PINNED_FORECAST_CATEGORIES,
  expenseForecastDeltas,
  getQuarterMonthPairs,
  type ExpenseForecastRow,
  type Q2Month,
  type Q2MonthPair,
} from "@/lib/financeStats";

// Pinned set lookup + declared-order index for the panel's render
// order. Pinned categories always render top-level regardless of |Δ|;
// non-pinned categories follow the legacy threshold rule.
const PINNED_SET = new Set<string>(PINNED_FORECAST_CATEGORIES);
const PINNED_ORDER = new Map<string, number>(
  PINNED_FORECAST_CATEGORIES.map((c, i) => [c, i]),
);

// =====================================================================
// Expense Forecast panel (replaces "Looking ahead").
//
// Two-lane layout:
//   - Movers: |Δ| ≥ $500, expanded, sorted by |Δ| desc, source/method
//     line under each category. Only Field Costs has a chevron
//     drill-down (per-venue children).
//   - Static: |Δ| < $500, collapsed by default. Toggle expands a
//     compact 4-col table.
//
// Bottom: totals footer with absolute From / To / Δ figures so the
// reader sees the magnitude behind the deltas.
// =====================================================================

function fmtUsd(n: number): string {
  if (Math.round(n) === 0) return "$0";
  return "$" + Math.round(n).toLocaleString("en-US");
}
function fmtSig(n: number): string {
  if (Math.round(n) === 0) return "$0";
  const abs = Math.round(Math.abs(n)).toLocaleString("en-US");
  return n > 0 ? `+$${abs}` : `-$${abs}`;
}
function shortMonth(month: string): string {
  return month.split(" ")[0];
}
function pairKey(p: { current: Q2Month; next: Q2Month }): string {
  return `${p.current}|${p.next}`;
}

// Tone for an expense delta cell.
//   coral = expense increased = bad for P&L
//   mint  = expense decreased = good for P&L
//   muted = $0
function deltaToneClass(delta: number): string {
  const r = Math.round(delta);
  if (r === 0) return "text-deep-green/55";
  if (r > 0) return "text-coral";
  return "text-mint-hover";
}

export default function ExpenseForecastPanel() {
  const { data, loading, error } = useFinanceData();
  const quarter = useFinanceQuarter();
  const [staticOpen, setStaticOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const pairs = useMemo(
    () => getQuarterMonthPairs(quarter, new Date()),
    [quarter],
  );
  const defaultPair = pairs.find((p) => p.isDefault) ?? pairs[0] ?? null;
  const [selectedKey, setSelectedKey] = useState<string | null>(
    defaultPair ? pairKey(defaultPair) : null,
  );
  // When the quarter switches, the prior selection's pair-key is from
  // the wrong quarter — drop it and re-seed from the new defaultPair.
  useEffect(() => {
    if (!defaultPair) return;
    if (!selectedKey) {
      setSelectedKey(pairKey(defaultPair));
      return;
    }
    if (!pairs.some((p) => pairKey(p) === selectedKey)) {
      setSelectedKey(pairKey(defaultPair));
    }
  }, [selectedKey, defaultPair, pairs]);
  const selectedPair =
    pairs.find((p) => pairKey(p) === selectedKey) ?? defaultPair;

  const forecast = useMemo(() => {
    if (!data || !selectedPair) return null;
    return expenseForecastDeltas(
      data,
      selectedPair.current,
      selectedPair.next,
    );
  }, [data, selectedPair]);

  function toggleRow(category: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
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
  if (!forecast || !selectedPair) return null;

  // Top-level lane: pinned categories ALWAYS, plus any non-pinned
  // category with |Δ| ≥ $500. Render order: pinned first in declared
  // order (Field Costs → MMP → City Manager → Marketing → Equipment),
  // then non-pinned movers sorted by |Δ| desc.
  const movers = forecast.rows
    .filter(
      (r) =>
        PINNED_SET.has(r.category) ||
        Math.abs(r.delta) >= EXPENSE_FORECAST_MOVER_THRESHOLD,
    )
    .sort((a, b) => {
      const aPinned = PINNED_SET.has(a.category);
      const bPinned = PINNED_SET.has(b.category);
      if (aPinned && bPinned) {
        return (PINNED_ORDER.get(a.category) ?? 0) -
          (PINNED_ORDER.get(b.category) ?? 0);
      }
      if (aPinned) return -1;
      if (bPinned) return 1;
      return Math.abs(b.delta) - Math.abs(a.delta);
    });
  // Static lane: non-pinned categories below the threshold.
  const staticRows = forecast.rows.filter(
    (r) =>
      !PINNED_SET.has(r.category) &&
      Math.abs(r.delta) < EXPENSE_FORECAST_MOVER_THRESHOLD,
  );

  return (
    <Panel>
      <div className="px-6 pt-5 sm:px-7 sm:pt-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/55">
              Expense forecast
            </div>
            <p className="mt-1 max-w-2xl text-xs text-deep-green/60">
              Compare planned expenses across months. Adjust manual entries
              as actuals roll in.
            </p>
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

      <div className="mt-4 px-6 sm:px-7">
        <SecLabel>Top-level expenses</SecLabel>
        {movers.length === 0 ? (
          <div className="mt-2 rounded-md border border-cream-line bg-cream-soft/40 px-4 py-3 text-xs italic text-deep-green/55">
            No expense activity in this pair.
          </div>
        ) : (
          <>
            <ColumnHeaderRow
              fromMonth={forecast.fromMonth}
              toMonth={forecast.toMonth}
            />
            <ul className="divide-y divide-cream-line/60">
              {movers.map((r) => (
                <MoverRow
                  key={r.category}
                  row={r}
                  fromMonth={forecast.fromMonth}
                  toMonth={forecast.toMonth}
                  expanded={expanded.has(r.category)}
                  onToggle={() => toggleRow(r.category)}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="mt-5 px-6 sm:px-7">
        <StaticSection
          rows={staticRows}
          fromMonth={forecast.fromMonth}
          toMonth={forecast.toMonth}
          open={staticOpen}
          onToggle={() => setStaticOpen((o) => !o)}
        />
      </div>

      <div className="mt-4 border-t-2 border-cream-line bg-cream-soft/40 px-6 py-4 sm:px-7">
        <TotalsFooter
          forecast={forecast}
          isInProgressTo={isMonthInProgress(forecast.toMonth)}
        />
      </div>
    </Panel>
  );
}

// ----- Subcomponents -----

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
        Expense forecast
      </div>
    </div>
  );
}

function SecLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-deep-green/55">
      {children}
    </p>
  );
}

// Column headers above the movers list. Mirrors the row layout:
// flex item with min-w-0 fills the left "Category" column, three
// w-20 right-aligned numeric columns (From / To / Δ). Same column
// widths used in MoverRow so values line up under the headers.
function ColumnHeaderRow({
  fromMonth,
  toMonth,
}: {
  fromMonth: Q2Month;
  toMonth: Q2Month;
}) {
  // Mirrors MoverRow's outer flex (justify-between gap-4) + inner
  // numeric flex (gap-3, three w-20 cells) so header text lines up
  // under the values.
  return (
    <div className="mt-2 flex items-baseline justify-between gap-3 border-b border-cream-line/60 pb-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-deep-green/45 sm:gap-4">
      <div className="min-w-0 flex-1">Category</div>
      <div className="flex shrink-0 items-baseline gap-2 sm:gap-3">
        <div className="w-14 text-right sm:w-20">{shortMonth(fromMonth)}</div>
        <div className="w-14 text-right sm:w-20">{shortMonth(toMonth)}</div>
        <div className="w-14 text-right sm:w-20">Δ</div>
      </div>
    </div>
  );
}

function MoverRow({
  row,
  fromMonth,
  toMonth,
  expanded,
  onToggle,
}: {
  row: ExpenseForecastRow;
  fromMonth: Q2Month;
  toMonth: Q2Month;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasChildren = (row.children?.length ?? 0) > 0;
  const headerInner = (
    <>
      <div className="min-w-0 flex-1">
        {/* flex-wrap so the badge can drop to a second line on narrow
            viewports instead of bleeding into the numeric columns
            (mobile bug: "FORMULA" was visually overlapping the
            adjacent dollar value). Desktop still renders the badge
            inline because there's room. */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {hasChildren ? (
            expanded ? (
              <ChevronDown
                size={14}
                aria-hidden
                className="text-deep-green/45"
              />
            ) : (
              <ChevronRight
                size={14}
                aria-hidden
                className="text-deep-green/45"
              />
            )
          ) : (
            <span aria-hidden className="inline-block w-[14px]" />
          )}
          <span className="text-sm font-bold text-deep-green">
            {row.category}
          </span>
          <ConfidenceBadge confidence={row.sourceConfidence} />
        </div>
        <p className="ml-[22px] mt-0.5 text-[11px] text-deep-green/55">
          {row.sourceMethod}
        </p>
      </div>
      {/* Numeric columns: narrower on mobile (w-14) so the category
          column has more room. sm: floors restore the desktop widths
          where there's space. */}
      <div className="flex shrink-0 items-baseline gap-2 font-mono text-sm tabular-nums sm:gap-3">
        <span
          className="w-14 text-right text-deep-green/70 sm:w-20"
          title={`${shortMonth(fromMonth)} actual`}
        >
          {fmtUsd(row.fromAmount)}
        </span>
        <span
          className="w-14 text-right text-deep-green/70 sm:w-20"
          title={`${shortMonth(toMonth)} planned`}
        >
          {fmtUsd(row.toAmount)}
        </span>
        <span
          className={`w-14 text-right font-semibold sm:w-20 ${deltaToneClass(row.delta)}`}
        >
          {fmtSig(row.delta)}
        </span>
      </div>
    </>
  );

  return (
    <li>
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="group -mx-2 flex w-full cursor-pointer items-baseline justify-between gap-3 rounded px-2 py-3 text-left transition hover:bg-cream-soft/40 sm:gap-4"
        >
          {headerInner}
        </button>
      ) : (
        <div className="-mx-2 flex items-baseline justify-between gap-3 px-2 py-3 sm:gap-4">
          {headerInner}
        </div>
      )}

      {hasChildren && (
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-out ${
            expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <div className="space-y-2 pb-3 pl-7 pr-1">
              {row.children!.map((child) => (
                <div key={child.name}>
                  <div className="flex items-baseline gap-3 text-[12px]">
                    <span className="min-w-0 flex-1 truncate text-deep-green/65">
                      {child.name}
                    </span>
                    {/* Three numeric columns mirror the parent row's
                        alignment: from / to / Δ. Slightly narrower
                        than parent (w-16 vs w-20) so the indented
                        drill-down still nests visually. */}
                    <span className="w-16 shrink-0 text-right font-mono tabular-nums text-deep-green/55">
                      {fmtUsd(child.fromAmount)}
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono tabular-nums text-deep-green/55">
                      {fmtUsd(child.toAmount)}
                    </span>
                    <span
                      className={`w-16 shrink-0 text-right font-mono font-semibold tabular-nums ${deltaToneClass(child.delta)}`}
                    >
                      {fmtSig(child.delta)}
                    </span>
                  </div>
                  {/* Composition line — explains *why* the cost is
                      what it is in each month. Field Costs only;
                      other categories leave breakdowns undefined and
                      this line doesn't render. */}
                  {(child.fromBreakdown || child.toBreakdown) && (
                    <div className="mt-0.5 text-[10px] text-deep-green/45">
                      {shortMonth(fromMonth)}: {child.fromBreakdown ?? "—"}
                      {"   "}
                      {shortMonth(toMonth)}: {child.toBreakdown ?? "—"}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: ExpenseForecastRow["sourceConfidence"];
}) {
  if (confidence === "formula") {
    return (
      <span className="inline-block rounded-full bg-mint-soft px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider text-mint-hover">
        Formula
      </span>
    );
  }
  if (confidence === "mixed") {
    return (
      <span className="inline-block rounded-full bg-blue-soft px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider text-blue-info">
        Mixed
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full bg-muted-soft px-1.5 py-0 text-[9px] font-bold uppercase tracking-wider text-muted">
      Manual
    </span>
  );
}

function StaticSection({
  rows,
  fromMonth,
  toMonth,
  open,
  onToggle,
}: {
  rows: ExpenseForecastRow[];
  fromMonth: Q2Month;
  toMonth: Q2Month;
  open: boolean;
  onToggle: () => void;
}) {
  if (rows.length === 0) return null;
  const subtitle =
    "Stable categories · update on Expenses tab as needed.";
  return (
    <div className="rounded-md border border-cream-line bg-cream-soft/30">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition hover:bg-cream-soft/60"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden className="text-deep-green/55" />
        ) : (
          <ChevronRight size={14} aria-hidden className="text-deep-green/55" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-deep-green">
            Static · {rows.length}{" "}
            {rows.length === 1 ? "category" : "categories"}
          </p>
          <p className="mt-0.5 text-[11px] text-deep-green/55">{subtitle}</p>
        </div>
      </button>
      {open && (
        <div className="border-t border-cream-line/60 px-3 py-2.5">
          <table className="w-full text-[12px]">
            <thead className="text-[10px] font-semibold uppercase tracking-wider text-deep-green/45">
              <tr>
                <th className="py-1 text-left">Category</th>
                <th className="py-1 text-right">{shortMonth(fromMonth)}</th>
                <th className="py-1 text-right">{shortMonth(toMonth)}</th>
                <th className="py-1 text-right">Δ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.category} className="border-t border-cream-line/40">
                  <td className="py-1.5 text-deep-green">{r.category}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-deep-green/65">
                    {fmtUsd(r.fromAmount)}
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums text-deep-green/65">
                    {fmtUsd(r.toAmount)}
                  </td>
                  <td
                    className={`py-1.5 text-right font-mono font-semibold tabular-nums ${deltaToneClass(r.delta)}`}
                  >
                    {fmtSig(r.delta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TotalsFooter({
  forecast,
  isInProgressTo,
}: {
  forecast: ReturnType<typeof expenseForecastDeltas>;
  isInProgressTo: boolean;
}) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-deep-green/65">
          Total expenses · {shortMonth(forecast.fromMonth)} →{" "}
          {shortMonth(forecast.toMonth)}
        </div>
        <div className="flex items-baseline gap-3 font-mono text-sm tabular-nums">
          <span className="text-deep-green/65">
            {fmtUsd(forecast.totals.from)}
          </span>
          <span aria-hidden className="text-deep-green/35">
            →
          </span>
          <span className="text-deep-green">
            {fmtUsd(forecast.totals.to)}
          </span>
          <span
            className={`text-base font-bold ${deltaToneClass(forecast.totals.delta)}`}
          >
            {fmtSig(forecast.totals.delta)}
          </span>
        </div>
      </div>
      {isInProgressTo && (
        <p className="mt-1 text-[11px] italic text-deep-green/50">
          {shortMonth(forecast.toMonth)} is in progress — totals update
          as actuals are entered.
        </p>
      )}
    </>
  );
}

function isMonthInProgress(month: Q2Month, now: Date = new Date()): boolean {
  // "In progress" = today's calendar (year, month) matches the month
  // key's calendar (year, month). Quarter-agnostic; works for any
  // Q-month key like "Jul 2026".
  const [shortName, yearStr] = month.split(" ");
  const year = parseInt(yearStr, 10);
  const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIdx = SHORT.indexOf(shortName);
  if (monthIdx < 0 || Number.isNaN(year)) return false;
  return now.getFullYear() === year && now.getMonth() === monthIdx;
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
