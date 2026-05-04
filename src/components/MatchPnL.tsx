"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";
import {
  fetchWeekMatchPnL,
  summarize,
  type MatchPnLRow,
  type MatchPnLStatus,
} from "@/lib/matchPnL";
import {
  mostRecentCompletedWeekMonday,
  sundayEndOf,
  sundayOf,
} from "@/lib/weekWindow";

type SortKey =
  | "match"
  | "city"
  | "spotsSold"
  | "grossRevenue"
  | "fieldCost"
  | "net"
  | "status";
type SortDir = "asc" | "desc";

const STATUS_PILL: Record<MatchPnLStatus, string> = {
  loss: "bg-coral-soft text-coral",
  breakeven: "bg-[rgba(245,158,11,0.15)] text-[#92400E]",
  profit: "bg-mint-soft text-deep-green",
  "missing-cost": "bg-cream-soft text-deep-green/55",
};

const STATUS_LABEL: Record<MatchPnLStatus, string> = {
  loss: "Loss",
  breakeven: "Breakeven",
  profit: "Profit",
  "missing-cost": "No cost set",
};

function fmtUsd(n: number): string {
  const r = Math.round(n);
  const sign = r < 0 ? "-" : "";
  return `${sign}$${Math.abs(r).toLocaleString("en-US")}`;
}
function fmtSig(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "$0";
  return r > 0 ? `+$${r.toLocaleString("en-US")}` : `-$${Math.abs(r).toLocaleString("en-US")}`;
}
function fmtMonthDay(d: Date): string {
  return `${d.toLocaleDateString("en-US", { month: "short" })} ${d.getDate()}`;
}

export default function MatchPnL({
  onJumpToConfig,
}: {
  // Lifted from the parent (FieldCostsView) — switches the parent
  // sub-tab back to "config" and triggers a scroll-to-venue effect.
  onJumpToConfig: (venueId: number) => void;
}) {
  const { data, loading: dataLoading } = useFinanceData();

  const [weekStart, setWeekStart] = useState<Date>(
    () => mostRecentCompletedWeekMonday(),
  );
  const [rows, setRows] = useState<MatchPnLRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("net");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const weekEnd = useMemo(() => sundayEndOf(weekStart), [weekStart]);
  const weekLabel = useMemo(() => {
    const sun = sundayOf(weekStart);
    return `${fmtMonthDay(weekStart)} – ${fmtMonthDay(sun)}`;
  }, [weekStart]);

  // Disable the right arrow once we'd step into the in-progress
  // week. Match P&L only makes sense for completed weeks.
  const canStepForward = useMemo(() => {
    const next = new Date(
      weekStart.getFullYear(),
      weekStart.getMonth(),
      weekStart.getDate() + 7,
    );
    return next <= mostRecentCompletedWeekMonday();
  }, [weekStart]);

  useEffect(() => {
    let cancelled = false;
    if (dataLoading || !data) return;
    setRows(null);
    setError(null);
    fetchWeekMatchPnL(supabase, weekStart, weekEnd, data.venues)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // fetchKey lets a manual refresh re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart, weekEnd, data, dataLoading, fetchKey]);

  function step(deltaWeeks: number) {
    setWeekStart((prev) => {
      const next = new Date(
        prev.getFullYear(),
        prev.getMonth(),
        prev.getDate() + deltaWeeks * 7,
      );
      return next;
    });
  }

  function toggleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      // Default direction per column: net ascending (worst losses
      // first), spotsSold/gross/cost descending, others ascending.
      setSortDir(
        k === "spotsSold" || k === "grossRevenue" || k === "fieldCost"
          ? "desc"
          : "asc",
      );
    }
  }

  // Split rows: those with cost set sort + render in main table;
  // those without render in a separate "No cost set" section.
  const { sorted, missingCost } = useMemo(() => {
    if (!rows) return { sorted: [], missingCost: [] };
    const main = rows.filter((r) => r.status !== "missing-cost");
    const missing = rows.filter((r) => r.status === "missing-cost");
    const cmp = (a: MatchPnLRow, b: MatchPnLRow): number => {
      const dir = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "match":
          return (
            (a.venueDisplayName.localeCompare(b.venueDisplayName) ||
              a.matchStart.getTime() - b.matchStart.getTime()) * dir
          );
        case "city":
          return (a.city.localeCompare(b.city)) * dir;
        case "spotsSold":
          return (a.spotsSold - b.spotsSold) * dir;
        case "grossRevenue":
          return (a.grossRevenue - b.grossRevenue) * dir;
        case "fieldCost":
          return ((a.fieldCost ?? 0) - (b.fieldCost ?? 0)) * dir;
        case "net":
          return ((a.net ?? 0) - (b.net ?? 0)) * dir;
        case "status": {
          const order: Record<MatchPnLStatus, number> = {
            loss: 0,
            breakeven: 1,
            profit: 2,
            "missing-cost": 3,
          };
          return (order[a.status] - order[b.status]) * dir;
        }
      }
    };
    return { sorted: [...main].sort(cmp), missingCost: missing };
  }, [rows, sortKey, sortDir]);

  const summary = useMemo(() => (rows ? summarize(rows) : null), [rows]);

  return (
    <div className="space-y-5">
      {/* Week selector + summary */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => step(-1)}
            className="rounded border border-cream-line bg-white px-2 py-1 text-deep-green/70 transition hover:bg-cream-soft"
            aria-label="Previous week"
          >
            <ChevronLeft size={14} aria-hidden />
          </button>
          <span className="font-mono text-sm font-bold tabular-nums text-deep-green">
            {weekLabel}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={!canStepForward}
            className="rounded border border-cream-line bg-white px-2 py-1 text-deep-green/70 transition hover:bg-cream-soft disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Next week"
          >
            <ChevronRight size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setFetchKey((k) => k + 1)}
            className="ml-2 text-[11px] font-bold uppercase tracking-wider text-mint-hover transition hover:text-deep-green"
          >
            Refresh
          </button>
        </div>
        {summary && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-deep-green/75">
            <span>
              <span className="font-bold tabular-nums text-deep-green">
                {summary.totalMatches}
              </span>{" "}
              matches
            </span>
            <span>
              gross{" "}
              <span className="font-mono font-bold tabular-nums text-deep-green">
                {fmtUsd(summary.totalRevenue)}
              </span>
            </span>
            <span>
              cost{" "}
              <span className="font-mono font-bold tabular-nums text-deep-green">
                {fmtUsd(summary.totalFieldCost)}
              </span>
            </span>
            <span>
              net{" "}
              <span
                className={`font-mono font-bold tabular-nums ${
                  summary.net > 10
                    ? "text-mint-hover"
                    : summary.net < -10
                      ? "text-coral"
                      : "text-deep-green/75"
                }`}
              >
                {fmtSig(summary.net)}
              </span>
            </span>
            <span>
              <span className="font-bold tabular-nums text-coral">
                {summary.losingMatches}
              </span>{" "}
              losing
            </span>
            {summary.matchesWithoutCost > 0 && (
              <span className="text-deep-green/55">
                · {summary.matchesWithoutCost} missing cost
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
          {error}
        </div>
      )}

      {/* Main table */}
      <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              <tr>
                <SortHeader k="match" label="Match" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="left" />
                <SortHeader k="city" label="City" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="left" />
                <SortHeader k="spotsSold" label="Spots Sold" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortHeader k="grossRevenue" label="Gross Revenue" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortHeader k="fieldCost" label="Field Cost" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortHeader k="net" label="Net" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                <SortHeader k="status" label="Status" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="left" />
              </tr>
            </thead>
            <tbody>
              {rows === null ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-deep-green/55">
                    Loading match P&L…
                  </td>
                </tr>
              ) : sorted.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-deep-green/55">
                    No matches with cost data this week.
                    {missingCost.length > 0 &&
                      ` (${missingCost.length} matches without cost set — see below.)`}
                  </td>
                </tr>
              ) : (
                sorted.map((r) => <Row key={`${r.venueId ?? r.venueRawName}|${r.matchStartIso}`} row={r} onJumpToConfig={onJumpToConfig} />)
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Missing-cost section — same shape as the main table but
          rendered separately so they don't pollute the loss/profit
          sort. */}
      {missingCost.length > 0 && (
        <div className="overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
          <div className="border-b border-cream-line bg-cream-soft/60 px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
            No cost set ({missingCost.length})
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {missingCost
                  .sort(
                    (a, b) =>
                      a.venueDisplayName.localeCompare(b.venueDisplayName) ||
                      a.matchStart.getTime() - b.matchStart.getTime(),
                  )
                  .map((r) => (
                    <Row
                      key={`${r.venueId ?? r.venueRawName}|${r.matchStartIso}`}
                      row={r}
                      onJumpToConfig={onJumpToConfig}
                    />
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SortHeader({
  k,
  label,
  sortKey,
  sortDir,
  onClick,
  align,
}: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align: "left" | "right";
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onClick(k)}
        className={`inline-flex items-center gap-1 transition hover:text-deep-green ${active ? "text-deep-green" : ""}`}
      >
        {label}
        <span className="text-[9px]">{arrow}</span>
      </button>
    </th>
  );
}

function Row({
  row,
  onJumpToConfig,
}: {
  row: MatchPnLRow;
  onJumpToConfig: (venueId: number) => void;
}) {
  return (
    <tr className="border-t border-cream-line/60">
      <td className="px-3 py-2 align-top">
        <div className="font-bold text-deep-green">{row.venueDisplayName}</div>
        <div className="text-[11px] text-deep-green/55">
          {row.dayLabel} {row.timeLabel}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-deep-green/75">{row.city}</td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.spotsSold}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {fmtUsd(row.grossRevenue)}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {row.fieldCost === null ? (
          row.venueId !== null ? (
            <button
              type="button"
              onClick={() => onJumpToConfig(row.venueId as number)}
              className="font-mono text-[11px] italic text-coral underline-offset-2 hover:underline"
              title="Jump to Field Costs config to set this venue's cost/match"
            >
              $? — set in Field Costs
            </button>
          ) : (
            <span className="font-mono text-[11px] italic text-deep-green/45">
              $? — venue unresolved
            </span>
          )
        ) : (
          <span className="font-mono tabular-nums text-deep-green">
            {fmtUsd(row.fieldCost)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {row.net === null ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          <span
            className={`font-mono font-bold tabular-nums ${
              row.net > 10
                ? "text-mint-hover"
                : row.net < -10
                  ? "text-coral"
                  : "text-deep-green/75"
            }`}
          >
            {fmtSig(row.net)}
          </span>
        )}
      </td>
      <td className="px-3 py-2 align-top">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_PILL[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </td>
    </tr>
  );
}
