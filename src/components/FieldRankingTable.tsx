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
  { key: "totalRevenue", label: "Total Revenue", align: "right" },
  { key: "revenue", label: "DPP Revenue", align: "right" },
  { key: "memberRev", label: "Member Rev", align: "right" },
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
}: {
  collapsed?: boolean;
  onToggle?: () => void;
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
  // "as_billed" = monthly_flat lumps, lump_sum quarterly hits, per_match
  //   count × rate. Default — same shape as the rest of Finance (Cash
  //   Flow, Cities P&L, hero metrics).
  // "per_match" = cost_per_match × matches per leg. Smooths billing
  //   timing across months for venues that bill in lumps (NEMP's quarterly
  //   permit, Hattrick, Bicentennial) so per-venue Net P&L / Margin
  //   compare cleanly month-over-month.
  const [costMode, setCostMode] = useState<"as_billed" | "per_match">(
    "per_match",
  );

  const rows = useMemo<RankingRow[]>(() => {
    if (!data) return [];
    return buildRankingRows(data, matchRegistrations, month);
  }, [data, matchRegistrations, month]);

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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1180px] text-xs">
          <thead className="sticky top-0 z-10 bg-cream-soft">
            <tr className="border-y border-cream-line text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              {COLUMNS.map((col) => {
                const isSortable = col.key !== "rank";
                const isActive = isSortable && sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    className={`px-3 py-2 ${col.align === "right" ? "text-right" : "text-left"} ${
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
                  <td className="px-3 py-2 font-mono font-bold tabular-nums text-deep-green/70">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2 font-semibold text-deep-green">
                    <div>{row.venue}</div>
                    {(() => {
                      // Per-Match mode: uniform "N × $cpm" subtitle for
                      // every venue, joined by " + " for split legs.
                      // Same logic the Cities Per-Match view uses, sourcing
                      // from costPerMatchLegs (cost_per_match with primary
                      // fallback) so the two pages render identically and
                      // the subtitle reconciles against the swapped cost
                      // column. Zero-match legs filtered to keep the
                      // breakdown clean across months.
                      if (costMode === "per_match") {
                        const visible = row.costPerMatchLegs.filter(
                          (l) => l.matchCount > 0,
                        );
                        if (visible.length === 0) return null;
                        return (
                          <div className="text-[10px] font-normal text-deep-green/45">
                            {visible
                              .map(
                                (l) =>
                                  `${l.matchCount} × $${Math.round(l.cpm)}`,
                              )
                              .join(" + ")}
                          </div>
                        );
                      }
                      // As-Billed mode: combined per_match groups (ATH
                      // Katy) render the split breakdown by billed rate;
                      // single-leg per_match falls back to the legacy
                      // "N × $rate"; monthly_flat shows "monthly"; rest
                      // render nothing.
                      if (row.perMatchLegs.length > 0) {
                        const visible = row.perMatchLegs.filter(
                          (l) => l.matchCount > 0,
                        );
                        if (visible.length === 0) return null;
                        return (
                          <div className="text-[10px] font-normal text-deep-green/45">
                            {visible
                              .map(
                                (l) =>
                                  `${l.matchCount} × $${Math.round(l.rate)}`,
                              )
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
                          <div className="text-[10px] font-normal text-deep-green/45">
                            monthly
                          </div>
                        );
                      }
                      return null;
                    })()}
                  </td>
                  <td className="px-3 py-2 text-deep-green/85">{row.city}</td>
                  <td className="px-3 py-2 text-deep-green/65">
                    {relativeTimeFromDate(row.launchDate)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/85">
                    {row.matchCount}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold tabular-nums text-mint-hover">
                    {fmtMoney(row.totalRevenue)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-mint-hover">
                    {fmtMoney(row.revenue)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-mint-hover">
                    {fmtMoney(row.memberRev)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/75">
                    {fmtPct(row.cityMbrPct)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/75">
                    {fmtPct(row.mbrMixPct)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-deep-green/75">
                    {fmtPct(row.dppMixPct)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-coral">
                    {fmtMoney(row.cost)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-mono font-bold tabular-nums ${
                      row.netPL >= 0 ? "text-mint-hover" : "text-coral"
                    }`}
                  >
                    {fmtMoney(row.netPL)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MarginPill margin={row.margin} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
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
