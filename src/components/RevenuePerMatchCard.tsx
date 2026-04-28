"use client";

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import {
  computeRevenuePerMatchByCity,
  type RevenuePerMatchRow,
} from "@/lib/financeStats";

type SortKey = "gross" | "dpp";

export default function RevenuePerMatchCard() {
  const { data, loading: financeLoading } = useFinanceData();
  const { rows: matchRows, loading: matchLoading } = useMatchData();
  const [sortBy, setSortBy] = useState<SortKey>("gross");

  const rows = useMemo(() => {
    if (!data) return [];
    const slim = matchRows.map((r) => ({
      city: r.city,
      field: r.field,
      matchStart: r.matchStart,
      matchCanceled: r.matchCanceled,
    }));
    const computed = computeRevenuePerMatchByCity(data, slim);
    const visible = computed.filter((r) => r.matches > 0);
    return visible.sort((a, b) => {
      const av = sortBy === "gross" ? a.grossPerMatch : a.dppPerMatch;
      const bv = sortBy === "gross" ? b.grossPerMatch : b.dppPerMatch;
      return bv - av;
    });
  }, [data, matchRows, sortBy]);

  if (financeLoading || matchLoading) {
    return (
      <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10 sm:p-7">
        Loading revenue per match…
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        Revenue Per Match · last 4 weeks
      </div>
      <h3 className="mt-1 text-xl font-bold tracking-tight text-deep-green">
        By city
      </h3>
      <p className="mt-1 max-w-3xl text-sm text-deep-green/65">
        Average dollars generated per played match. Gross includes DPP +
        member spots + promos. DPP-only is walk-up cash per match.
      </p>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-cream-line text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              <th className="px-2 py-2 text-left">City</th>
              <th className="px-2 py-2 text-right">Matches</th>
              <SortableTh
                active={sortBy === "gross"}
                onClick={() => setSortBy("gross")}
                align="right"
              >
                Gross/Match
              </SortableTh>
              <SortableTh
                active={sortBy === "dpp"}
                onClick={() => setSortBy("dpp")}
                align="right"
              >
                DPP/Match
              </SortableTh>
              <th className="px-2 py-2 text-left">Mix</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-2 py-6 text-center text-sm text-deep-green/55"
                >
                  No matches in the last 4 weeks.
                </td>
              </tr>
            ) : (
              rows.map((r) => <Row key={r.city} row={r} />)
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs italic text-deep-green/55">
        Mix bar shows what % of gross is walk-up DPP. Higher bar = less
        membership-dependent.
      </p>
    </section>
  );
}

function Row({ row }: { row: RevenuePerMatchRow }) {
  return (
    <tr className="border-b border-cream-line/50 transition hover:bg-cream-soft/40">
      <td className="px-2 py-2 font-medium text-deep-green">{row.city}</td>
      <td className="px-2 py-2 text-right tabular-nums text-deep-green/65">
        {row.matches.toLocaleString()}
      </td>
      <td className="px-2 py-2 text-right font-bold tabular-nums text-deep-green">
        {fmtDollars(row.grossPerMatch)}
      </td>
      <td className="px-2 py-2 text-right tabular-nums text-deep-green/55">
        {fmtDollars(row.dppPerMatch)}
      </td>
      <td className="px-2 py-2">
        <MixBar pct={row.mixPct} />
      </td>
    </tr>
  );
}

function MixBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div
      className="relative h-[5px] w-[60px] overflow-hidden rounded-full"
      style={{ backgroundColor: "rgba(0,51,38,0.08)" }}
      title={`${clamped.toFixed(0)}% DPP of gross`}
    >
      <div
        className="absolute left-0 top-0 h-full rounded-full"
        style={{
          width: `${clamped}%`,
          backgroundColor: "#2CDB87",
        }}
      />
    </div>
  );
}

function SortableTh({
  children,
  active,
  onClick,
  align,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  align: "left" | "right";
}) {
  return (
    <th
      className={`px-2 py-2 ${align === "right" ? "text-right" : "text-left"}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 transition hover:text-deep-green ${
          active ? "text-deep-green" : "text-deep-green/55"
        }`}
      >
        {children}
        {active && <span aria-hidden>↓</span>}
      </button>
    </th>
  );
}

function fmtDollars(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString()}`;
}
