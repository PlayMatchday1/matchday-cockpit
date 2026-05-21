"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import {
  buildRankingRows,
  getCurrentMonthInQuarter,
  relativeTimeFromDate,
  type Q2Month,
  type RankingRow,
} from "@/lib/financeStats";

type SortKey =
  | "venue"
  | "city"
  | "launchedMs"
  | "matchCount"
  | "totalRevenue"
  | "revenue"
  | "memberRev"
  | "cityMbrPct"
  | "mbrMixPct"
  | "dppMixPct"
  | "cost"
  | "netPL"
  | "margin";

type ColumnDef = {
  key: SortKey | "rank";
  label: string;
  align: "left" | "right";
};

const COLUMNS: ColumnDef[] = [
  { key: "rank", label: "#", align: "left" },
  { key: "venue", label: "Venue", align: "left" },
  { key: "city", label: "City", align: "left" },
  { key: "launchedMs", label: "Launched", align: "left" },
  { key: "matchCount", label: "Matches", align: "right" },
  { key: "totalRevenue", label: "Total Rev", align: "right" },
  { key: "revenue", label: "DPP Rev", align: "right" },
  { key: "memberRev", label: "Mbr Rev", align: "right" },
  { key: "cityMbrPct", label: "City Mbr %", align: "right" },
  { key: "mbrMixPct", label: "Mbr Mix %", align: "right" },
  { key: "dppMixPct", label: "DPP Mix %", align: "right" },
  { key: "cost", label: "Cost", align: "right" },
  { key: "netPL", label: "Net P&L", align: "right" },
  { key: "margin", label: "Margin", align: "right" },
];

function fmtMoney(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "—";
  const abs = Math.abs(r);
  return `${r < 0 ? "-" : ""}$${abs.toLocaleString("en-US")}`;
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "—";
  return `${Math.round(n * 100)}%`;
}

export default function FieldRankingTable({
  collapsed = false,
  onToggle,
  city,
  costScope = "projected",
}: {
  collapsed?: boolean;
  onToggle?: () => void;
  // Optional city filter. When set, only rows for that city render
  // and sort. Standalone Field Ranking page leaves it unset for the
  // all-cities view; Slate Review passes its selected city.
  city?: string;
  // Cost scope. "projected" (default) keeps the standalone behavior
  // — full-month canonical / per-match cost. "realized" feeds the
  // Slate Review embed: cost reflects only matches with date <=
  // today in the current month.
  costScope?: "projected" | "realized";
} = {}) {
  const { data } = useFinanceData();
  const { rows: matchRegistrations } = useMatchData();
  const quarter = useFinanceQuarter();
  // Default: current month within the active quarter; falls back to
  // the last month of the quarter (operator reads "the most recent
  // closed month" when viewing past quarters or pre-first-month).
  const [month, setMonth] = useState<Q2Month>(
    () =>
      getCurrentMonthInQuarter(quarter, new Date()) ??
      quarter.months[quarter.months.length - 1].key,
  );
  // Keep the selected month inside the active quarter when the
  // quarter changes (e.g. after a selector swap).
  useEffect(() => {
    if (!quarter.months.some((m) => m.key === month)) {
      setMonth(
        getCurrentMonthInQuarter(quarter, new Date()) ??
          quarter.months[quarter.months.length - 1].key,
      );
    }
  }, [quarter, month]);
  const [sortKey, setSortKey] = useState<SortKey>("totalRevenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Mobile-only: which cards have their secondary-metrics section
  // expanded. Keyed by row index + city + venue (same shape as the
  // desktop tr key). Desktop ignores this state.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleExpanded(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  // "as_billed" = monthly_flat / profit_share lumps + per_match count
  //   × rate. Matches the rest of Finance (Cash Flow, Cities P&L, hero
  //   metrics).
  // "per_match" = cost_per_match × matches per leg. Smooths billing
  //   timing across months for venues that bill in lumps (NEMP's
  //   quarterly permit, Hattrick, Bicentennial) so per-venue Net P&L /
  //   Margin compare cleanly month-over-month. Default.
  const [costMode, setCostMode] = useState<"as_billed" | "per_match">(
    "per_match",
  );

  const rows = useMemo<RankingRow[]>(() => {
    if (!data) return [];
    const all = buildRankingRows(data, matchRegistrations, month, {
      costScope,
    });
    return city ? all.filter((r) => r.city === city) : all;
  }, [data, matchRegistrations, month, city, costScope]);

  // In per-match mode, swap cost / netPL / margin onto the displayed
  // row so render + sort both see the normalized values. Other columns
  // (revenue, totalRevenue, matchCount, mix %) are unchanged across
  // modes.
  const viewRows = useMemo<RankingRow[]>(() => {
    if (costMode === "as_billed") return rows;
    return rows.map((r) => ({
      ...r,
      cost: r.perMatchCost,
      netPL: r.perMatchNetPL,
      margin: r.perMatchMargin,
    }));
  }, [rows, costMode]);

  const sorted = useMemo(() => {
    const copy = [...viewRows];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "desc" ? bv - av : av - bv;
      }
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "desc"
          ? bv.localeCompare(av)
          : av.localeCompare(bv);
      }
      return 0;
    });
    return copy;
  }, [viewRows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  if (!data) return null;

  const headerInteractive = Boolean(onToggle);

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 px-5 py-4 ${
          headerInteractive
            ? "cursor-pointer rounded-t-2xl hover:bg-cream-soft/40"
            : ""
        }`}
        onClick={headerInteractive ? onToggle : undefined}
        role={headerInteractive ? "button" : undefined}
        aria-expanded={headerInteractive ? !collapsed : undefined}
      >
        <div className="flex items-start gap-2">
          {headerInteractive &&
            (collapsed ? (
              <ChevronRight
                size={20}
                aria-hidden
                className="mt-1.5 shrink-0 text-deep-green/55"
              />
            ) : (
              <ChevronDown
                size={20}
                aria-hidden
                className="mt-1.5 shrink-0 text-deep-green/55"
              />
            ))}
          <div>
            <h2 className="font-display text-3xl uppercase tracking-tight text-deep-green md:text-4xl">
              Field Ranking
            </h2>
            <p className="text-xs text-deep-green/60">
              Current month venue performance · per-venue DPP, allocated
              memberships, cost, and margin
            </p>
          </div>
        </div>
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="inline-flex rounded-full border border-cream-line bg-cream-soft p-0.5 text-xs font-bold"
            role="radiogroup"
            aria-label="Cost view"
          >
            {(["as_billed", "per_match"] as const).map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => setCostMode(opt)}
                className={`rounded-full px-3 py-1.5 transition ${
                  costMode === opt
                    ? "bg-mint text-deep-green"
                    : "text-deep-green/65 hover:text-deep-green"
                }`}
                aria-pressed={costMode === opt}
              >
                {opt === "as_billed" ? "As Billed" : "Per-Match"}
              </button>
            ))}
          </div>
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value as Q2Month)}
            className="rounded-full border border-cream-line bg-cream-soft px-4 py-1.5 text-xs font-bold text-deep-green focus:border-deep-green focus:outline-none"
            aria-label="Month"
          >
            {quarter.months.map((m) => (
              <option key={m.key} value={m.key}>
                {m.shortName}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!collapsed && (
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full min-w-[980px] text-xs">
          <thead className="sticky top-0 z-10 bg-cream-soft">
            <tr className="border-y border-cream-line text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              {COLUMNS.map((col) => {
                const isSortable = col.key !== "rank";
                const isActive = isSortable && sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    className={`px-2 py-1.5 ${col.align === "right" ? "text-right" : "text-left"} ${
                      isSortable
                        ? "cursor-pointer select-none hover:bg-cream"
                        : ""
                    } ${isActive ? "text-deep-green" : ""}`}
                    onClick={
                      isSortable
                        ? () => toggleSort(col.key as SortKey)
                        : undefined
                    }
                  >
                    <span
                      className={`inline-flex items-center gap-1 ${col.align === "right" ? "justify-end" : ""}`}
                    >
                      {col.label}
                      {isActive && (
                        <span aria-hidden>
                          {sortDir === "desc" ? "▼" : "▲"}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-8 text-center text-sm text-deep-green/50"
                >
                  No venue activity for this month.
                </td>
              </tr>
            ) : (
              sorted.map((row, i) => (
                <tr
                  key={`${i}|${row.city}|${row.venue}`}
                  className="border-t border-cream-line/40 hover:bg-cream-soft/50"
                >
                  <td className="px-2 py-1.5 font-mono font-bold tabular-nums text-deep-green/70">
                    {i + 1}
                  </td>
                  <td className="px-2 py-1.5 font-semibold text-deep-green">
                    <div>{row.venue}</div>
                    <VenueSubtitle row={row} costMode={costMode} />
                  </td>
                  <td className="px-2 py-1.5 text-deep-green/85">{row.city}</td>
                  <td className="px-2 py-1.5 text-deep-green/65">
                    {relativeTimeFromDate(row.launchDate)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-deep-green/85">
                    {row.matchCount}
                    {row.chargedCancelCount > 0 && (
                      <span className="ml-1 text-[10px] text-deep-green/45">
                        +{row.chargedCancelCount} cxl
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono font-bold tabular-nums text-mint-hover">
                    {fmtMoney(row.totalRevenue)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-mint-hover">
                    {fmtMoney(row.revenue)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-mint-hover">
                    {fmtMoney(row.memberRev)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-deep-green/75">
                    {fmtPct(row.cityMbrPct)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-deep-green/75">
                    {fmtPct(row.mbrMixPct)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-deep-green/75">
                    {fmtPct(row.dppMixPct)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums text-coral">
                    {fmtMoney(row.cost)}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-mono font-bold tabular-nums ${
                      row.netPL >= 0 ? "text-mint-hover" : "text-coral"
                    }`}
                  >
                    {fmtMoney(row.netPL)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <MarginPill margin={row.margin} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}
      {!collapsed && (
        <div className="space-y-2 px-3 pb-3 pt-2 md:hidden">
          {sorted.length === 0 ? (
            <div className="rounded-xl bg-cream-soft px-3 py-8 text-center text-sm text-deep-green/50">
              No venue activity for this month.
            </div>
          ) : (
            sorted.map((row, i) => {
              const key = `${i}|${row.city}|${row.venue}`;
              const expanded = expandedKeys.has(key);
              return (
                <MobileRankingCard
                  key={key}
                  rank={i + 1}
                  row={row}
                  costMode={costMode}
                  expanded={expanded}
                  onToggle={() => toggleExpanded(key)}
                />
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

// Mobile-only card view of a RankingRow. Header line (rank + venue +
// city), per-leg subtitle, matches + margin pill summary, key money
// numbers in a 3-col grid, then a collapsible secondary-metrics
// section. Sort order follows the same `sorted` array the desktop
// table consumes, so flipping the desktop sort header (when a user
// switches between mobile and desktop on the same session) keeps
// the order in sync.
function MobileRankingCard({
  rank,
  row,
  costMode,
  expanded,
  onToggle,
}: {
  rank: number;
  row: RankingRow;
  costMode: "as_billed" | "per_match";
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-xl border border-cream-line bg-white p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="font-mono text-xs font-bold tabular-nums text-deep-green/55">
            #{rank}
          </span>
          <span className="truncate font-semibold text-deep-green">
            {row.venue}
          </span>
        </div>
        <span className="shrink-0 text-xs text-deep-green/65">{row.city}</span>
      </div>

      <div className="mt-0.5">
        <VenueSubtitle row={row} costMode={costMode} />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
        <span className="text-deep-green/85">
          <span className="font-mono tabular-nums">{row.matchCount}</span>
          {row.chargedCancelCount > 0 && (
            <span className="ml-1 text-[10px] text-deep-green/45">
              +{row.chargedCancelCount} cxl
            </span>
          )}
          <span className="ml-1 text-deep-green/55">matches</span>
        </span>
        <MarginPill margin={row.margin} />
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <MobileMetric
          label="Total Rev"
          value={fmtMoney(row.totalRevenue)}
          tone="mint-bold"
        />
        <MobileMetric label="Cost" value={fmtMoney(row.cost)} tone="coral" />
        <MobileMetric
          label="Net P&L"
          value={fmtMoney(row.netPL)}
          tone={row.netPL >= 0 ? "mint-bold" : "coral-bold"}
        />
      </div>

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md py-1 text-[10px] font-bold uppercase tracking-wider text-deep-green/55 transition hover:bg-cream-soft hover:text-deep-green"
      >
        <span aria-hidden>{expanded ? "▴" : "▾"}</span>
        {expanded ? "Less" : "More"}
      </button>

      {expanded && (
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-cream-line/60 pt-2 text-[11px]">
          <MobileMetric
            label="DPP Rev"
            value={fmtMoney(row.revenue)}
            tone="mint"
            inline
          />
          <MobileMetric
            label="Mbr Rev"
            value={fmtMoney(row.memberRev)}
            tone="mint"
            inline
          />
          <MobileMetric
            label="City Mbr %"
            value={fmtPct(row.cityMbrPct)}
            tone="muted"
            inline
          />
          <MobileMetric
            label="Mbr Mix %"
            value={fmtPct(row.mbrMixPct)}
            tone="muted"
            inline
          />
          <MobileMetric
            label="DPP Mix %"
            value={fmtPct(row.dppMixPct)}
            tone="muted"
            inline
          />
          <MobileMetric
            label="Launched"
            value={relativeTimeFromDate(row.launchDate)}
            tone="muted"
            inline
          />
        </div>
      )}
    </div>
  );
}

function MobileMetric({
  label,
  value,
  tone,
  inline = false,
}: {
  label: string;
  value: string;
  tone: "mint" | "mint-bold" | "coral" | "coral-bold" | "muted";
  inline?: boolean;
}) {
  const valueCls =
    tone === "mint-bold"
      ? "font-bold text-mint-hover"
      : tone === "coral-bold"
        ? "font-bold text-coral"
        : tone === "mint"
          ? "text-mint-hover"
          : tone === "coral"
            ? "text-coral"
            : "text-deep-green/75";
  if (inline) {
    return (
      <div className="flex items-baseline justify-between">
        <span className="text-deep-green/55">{label}</span>
        <span className={`font-mono tabular-nums ${valueCls}`}>{value}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
        {label}
      </span>
      <span className={`font-mono tabular-nums ${valueCls}`}>{value}</span>
    </div>
  );
}

// "N × $rate" subtitle shared by the desktop Venue cell and the
// mobile card view. Per-Match mode: charged per-leg matches × cpm
// joined by " + " (zero-match legs filtered). As-Billed mode:
// per_match split groups render charged per-leg matches × rate, the
// single per_match falls back to the legacy "matchCount × rate",
// monthly_flat shows "monthly", everything else renders nothing.
function VenueSubtitle({
  row,
  costMode,
}: {
  row: RankingRow;
  costMode: "as_billed" | "per_match";
}) {
  if (costMode === "per_match") {
    const visible = row.costPerMatchLegs.filter((l) => l.matchCount > 0);
    if (visible.length === 0) return null;
    return (
      <div className="text-[10px] font-normal text-deep-green/45">
        {visible
          .map((l) => `${l.matchCount} × $${Math.round(l.cpm)}`)
          .join(" + ")}
      </div>
    );
  }
  if (row.perMatchLegs.length > 0) {
    const visible = row.perMatchLegs.filter((l) => l.matchCount > 0);
    if (visible.length === 0) return null;
    return (
      <div className="text-[10px] font-normal text-deep-green/45">
        {visible
          .map((l) => `${l.matchCount} × $${Math.round(l.rate)}`)
          .join(" + ")}
      </div>
    );
  }
  if (
    row.billingType === "per_match" &&
    row.perMatchRate &&
    row.matchCount > 0
  ) {
    return (
      <div className="text-[10px] font-normal text-deep-green/45">
        {row.matchCount} × ${Math.round(row.perMatchRate)}
      </div>
    );
  }
  if (row.billingType === "monthly_flat") {
    return (
      <div className="text-[10px] font-normal text-deep-green/45">monthly</div>
    );
  }
  return null;
}

function MarginPill({ margin }: { margin: number }) {
  const pct = Math.round(margin * 100);
  const cls =
    margin >= 0.2
      ? "bg-mint text-deep-green ring-mint/60"
      : margin >= 0
        ? "bg-mint-soft text-deep-green ring-mint/40"
        : "bg-coral-soft text-coral ring-coral/40";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${cls}`}
    >
      {pct}%
    </span>
  );
}
