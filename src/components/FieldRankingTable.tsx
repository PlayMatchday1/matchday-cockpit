"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  Q2_MONTHS,
  buildRankingRows,
  getCurrentQ2Month,
  relativeTimeFromDate,
  type Q2Month,
  type RankingRow,
} from "@/lib/financeStats";

type SortKey =
  | "venue"
  | "city"
  | "launchedMs"
  | "dppRev"
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
  { key: "dppRev", label: "DPP Rev", align: "right" },
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
  const [month, setMonth] = useState<Q2Month>(
    () => getCurrentQ2Month(new Date()) ?? "Apr 2026",
  );
  const [sortKey, setSortKey] = useState<SortKey>("dppRev");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const rows = useMemo<RankingRow[]>(() => {
    if (!data) return [];
    return buildRankingRows(data, month);
  }, [data, month]);

  const sorted = useMemo(() => {
    const copy = [...rows];
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
  }, [rows, sortKey, sortDir]);

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
        <select
          value={month}
          onChange={(e) => setMonth(e.target.value as Q2Month)}
          onClick={(e) => e.stopPropagation()}
          className="rounded-full border border-cream-line bg-cream-soft px-4 py-1.5 text-xs font-bold text-deep-green focus:border-deep-green focus:outline-none"
          aria-label="Month"
        >
          {Q2_MONTHS.map((m) => (
            <option key={m} value={m}>
              {m.replace(" 2026", "")}
            </option>
          ))}
        </select>
      </div>

      {!collapsed && (
      <div>
        <table className="w-full text-xs">
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
                    {row.billingType === "per_match" &&
                      row.perMatchRate &&
                      row.matchCount > 0 && (
                        <div className="text-[10px] font-normal text-deep-green/45">
                          {row.matchCount} × ${Math.round(row.perMatchRate)}
                        </div>
                      )}
                    {row.billingType === "monthly_flat" && (
                      <div className="text-[10px] font-normal text-deep-green/45">
                        monthly
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-deep-green/85">{row.city}</td>
                  <td className="px-3 py-2 text-deep-green/65">
                    {relativeTimeFromDate(row.launchDate)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-mint-hover">
                    {fmtMoney(row.dppRev)}
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
