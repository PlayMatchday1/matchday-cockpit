"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useFinanceData } from "@/lib/useFinanceData";
import { cityMembershipRevenueFor } from "@/lib/financeStats";
import {
  fetchWeekMatchPnL,
  summarize,
  summarizeCanceled,
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
  | "spotsSold" // labeled "Spots Booked"
  | "paidSpots"
  | "memberSpots"
  | "grossRevenue" // labeled "DPP Rev"; field name kept stable
  | "memberRev" // labeled "Member Rev"
  | "credit"
  | "total" // DPP + Member
  | "fieldCost"
  | "net"
  | "status";
type SortDir = "asc" | "desc";

const STATUS_PILL: Record<MatchPnLStatus, string> = {
  loss: "bg-coral-soft text-coral",
  breakeven: "bg-[rgba(245,158,11,0.15)] text-[#92400E]",
  profit: "bg-mint-soft text-deep-green",
  "missing-cost": "bg-cream-soft text-deep-green/55",
  // Distinct gray pill so canceled matches don't visually compete
  // with active losses — the operator's eye should land on Loss
  // rows first, then scan canceled separately.
  canceled: "bg-deep-green/10 text-deep-green/55",
};

const STATUS_LABEL: Record<MatchPnLStatus, string> = {
  loss: "Loss",
  breakeven: "Breakeven",
  profit: "Profit",
  "missing-cost": "No cost set",
  canceled: "Canceled",
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
  // Optional cross-tab deep link. When MatchPnL was nested under
  // Field Costs, the parent passed a callback that switched its
  // sub-tab to Config and scrolled to the venue. Now that Match P&L
  // is its own top-level tab, no such parent exists and the prop is
  // omitted; missing-cost cells render as plain text instead of a
  // clickable button.
  onJumpToConfig?: (venueId: number) => void;
}) {
  const { data, loading: dataLoading } = useFinanceData();

  const [weekStart, setWeekStart] = useState<Date>(
    () => mostRecentCompletedWeekMonday(),
  );
  const [activeRows, setActiveRows] = useState<MatchPnLRow[] | null>(null);
  const [canceledRows, setCanceledRows] = useState<MatchPnLRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>("net");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // Mobile-only: which match cards have their secondary metrics
  // section expanded. Keyed by `${venueId ?? venueRawName}|${matchStartIso}`
  // (same key Row uses). Desktop ignores.
  const [mobileExpanded, setMobileExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  function toggleMobileExpanded(key: string) {
    setMobileExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
    setActiveRows(null);
    setCanceledRows([]);
    setError(null);
    fetchWeekMatchPnL(supabase, weekStart, weekEnd, data)
      .then((result) => {
        if (cancelled) return;
        setActiveRows(result.active);
        setCanceledRows(result.canceled);
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
      // first), spotsSold/gross/memberRev/cost descending, others ascending.
      setSortDir(
        k === "spotsSold" ||
          k === "paidSpots" ||
          k === "memberSpots" ||
          k === "grossRevenue" ||
          k === "memberRev" ||
          k === "credit" ||
          k === "total" ||
          k === "fieldCost"
          ? "desc"
          : "asc",
      );
    }
  }

  // Split active rows: those with cost set group + sort by city;
  // those without render in a separate "No cost set" section.
  // Canceled rows render in their own bottom section, sorted city
  // then time — independent of the active sort.
  const { cityGroups, missingCost, canceledSorted } = useMemo(() => {
    if (!activeRows)
      return {
        cityGroups: [] as { city: string; rows: MatchPnLRow[] }[],
        missingCost: [] as MatchPnLRow[],
        canceledSorted: [] as MatchPnLRow[],
      };
    const main = activeRows.filter((r) => r.status !== "missing-cost");
    const missing = activeRows.filter((r) => r.status === "missing-cost");
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
        case "paidSpots":
          return (a.paidSpots - b.paidSpots) * dir;
        case "memberSpots":
          return (a.memberSpots - b.memberSpots) * dir;
        case "grossRevenue":
          return (a.grossRevenue - b.grossRevenue) * dir;
        case "memberRev":
          return (a.allocatedMemberRev - b.allocatedMemberRev) * dir;
        case "credit":
          return (a.credit - b.credit) * dir;
        case "total":
          return (
            (a.grossRevenue + a.allocatedMemberRev -
              (b.grossRevenue + b.allocatedMemberRev)) *
            dir
          );
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
            canceled: 4,
          };
          return (order[a.status] - order[b.status]) * dir;
        }
      }
    };
    // Group active main rows by city, sort cities alphabetically,
    // sort within each city by the current sort key.
    const byCity = new Map<string, MatchPnLRow[]>();
    for (const r of main) {
      const arr = byCity.get(r.city) ?? [];
      arr.push(r);
      byCity.set(r.city, arr);
    }
    const groups = [...byCity.entries()]
      .map(([city, rows]) => ({ city, rows: [...rows].sort(cmp) }))
      .sort((a, b) => a.city.localeCompare(b.city));

    const canceledSorted = [...canceledRows].sort(
      (a, b) =>
        a.city.localeCompare(b.city) ||
        a.matchStart.getTime() - b.matchStart.getTime(),
    );

    return { cityGroups: groups, missingCost: missing, canceledSorted };
  }, [activeRows, canceledRows, sortKey, sortDir]);

  const summary = useMemo(
    () => (activeRows ? summarize(activeRows) : null),
    [activeRows],
  );
  const canceledSummary = useMemo(
    () => summarizeCanceled(canceledRows),
    [canceledRows],
  );

  // Per-city subtotals for the section headers.
  function citySubtotal(rows: MatchPnLRow[]) {
    let gross = 0;
    let memberRev = 0;
    let memberSpots = 0;
    let paidSpots = 0;
    let credit = 0;
    let freeNonMemberSpots = 0;
    let cost = 0;
    let losses = 0;
    for (const r of rows) {
      gross += r.grossRevenue;
      memberRev += r.allocatedMemberRev;
      memberSpots += r.memberSpots;
      paidSpots += r.paidSpots;
      credit += r.credit;
      freeNonMemberSpots += r.freeNonMemberSpots;
      if (r.fieldCost !== null) cost += r.fieldCost;
      if (r.status === "loss") losses++;
    }
    return {
      matches: rows.length,
      gross,
      memberRev,
      memberSpots,
      paidSpots,
      credit,
      freeNonMemberSpots,
      cost,
      net: gross + memberRev - cost,
      losses,
    };
  }

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
          <div className="flex flex-col items-end gap-1 text-[12px] text-deep-green/75">
            <div className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1">
              <span>
                <span className="font-bold tabular-nums text-deep-green">
                  {summary.totalMatches}
                </span>{" "}
                matches
              </span>
              <span>
                Paid spots{" "}
                <span className="font-bold tabular-nums text-deep-green">
                  {summary.totalPaidSpots}
                </span>
              </span>
              <span>
                DPP Rev{" "}
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtUsd(summary.totalRevenue)}
                </span>
              </span>
              <span>
                Member spots{" "}
                <span className="font-bold tabular-nums text-deep-green">
                  {summary.totalMemberSpots}
                </span>
              </span>
              <span>
                Member Rev{" "}
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtUsd(summary.totalMemberRev)}
                </span>
              </span>
              <span>
                Credit{" "}
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtUsd(summary.totalCredit)}
                </span>
              </span>
              <span>
                Total{" "}
                <span className="font-mono font-bold tabular-nums text-deep-green">
                  {fmtUsd(summary.totalRevenue + summary.totalMemberRev)}
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
            {canceledSummary.totalMatches > 0 && (
              <div className="text-[11px] text-deep-green/55">
                +{" "}
                <span className="font-bold tabular-nums">
                  {canceledSummary.totalMatches}
                </span>{" "}
                canceled match
                {canceledSummary.totalMatches === 1 ? "" : "es"},{" "}
                <span className="font-mono font-bold tabular-nums">
                  {fmtUsd(canceledSummary.sunkCost)}
                </span>{" "}
                sunk cost
                {canceledSummary.matchesWithoutCost > 0 &&
                  ` (${canceledSummary.matchesWithoutCost} missing cost)`}
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
          {error}
        </div>
      )}

      {/* Main table — desktop */}
      <div className="hidden md:block overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            {/* Column headers are not rendered as a single top <thead>;
                instead, each city section renders its own copy of the
                ColumnHeadersRow below its city-header summary row. This
                keeps the labels visible while scrolling through long
                city sections without needing a sticky header. */}
            {activeRows === null ? (
              <tbody>
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-sm text-deep-green/55">
                    Loading match P&L…
                  </td>
                </tr>
              </tbody>
            ) : cityGroups.length === 0 ? (
              <tbody>
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-sm text-deep-green/55">
                    No matches with cost data this week.
                    {missingCost.length > 0 &&
                      ` (${missingCost.length} matches without cost set — see below.)`}
                  </td>
                </tr>
              </tbody>
            ) : (
              cityGroups.map((g) => {
                const sub = citySubtotal(g.rows);
                // April benchmark: structural monthly reference, same value
                // regardless of selected week. Numerator: fin_revenue type
                // 'Membership' for the city in Apr 2026. Denominator: total
                // MEMBER fills for the city in Apr 2026 (mdapi-derived
                // index, same source Field Ranking reads). Renders the
                // fallback string when the denominator is zero, which
                // includes cities with no recorded member spots yet AND
                // any future quarter where Apr 2026 falls out of the
                // loaded mdapi window.
                const aprMemberRev = data
                  ? cityMembershipRevenueFor(data, g.city, "Apr 2026")
                  : 0;
                const aprMemberSpots =
                  data?.mdapiMemberSpots.byCityMonth.get(
                    `${g.city}|Apr 2026`,
                  )?.member ?? 0;
                const aprBenchmarkLabel =
                  aprMemberSpots > 0
                    ? `April benchmark: ~$${(aprMemberRev / aprMemberSpots).toFixed(2)}/member spot (${fmtUsd(aprMemberRev)} ÷ ${aprMemberSpots} spots)`
                    : "April benchmark: no member spots recorded";
                return (
                  <tbody key={g.city}>
                    <tr className="border-t-2 border-cream-line bg-cream-soft/50">
                      <td
                        colSpan={12}
                        className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green"
                      >
                        {g.city}
                        <span className="ml-2 font-normal text-deep-green/55">
                          · {sub.matches} match{sub.matches === 1 ? "" : "es"} ·
                          Paid {sub.paidSpots} · DPP Rev{" "}
                          {fmtUsd(sub.gross)} · Member spots{" "}
                          {sub.memberSpots} · Member Rev{" "}
                          {fmtUsd(sub.memberRev)} · Credit{" "}
                          {fmtUsd(sub.credit)} · Total{" "}
                          {fmtUsd(sub.gross + sub.memberRev)} · cost{" "}
                          {fmtUsd(sub.cost)} · net{" "}
                          <span
                            className={`font-bold ${
                              sub.net > 10
                                ? "text-mint-hover"
                                : sub.net < -10
                                  ? "text-coral"
                                  : "text-deep-green/55"
                            }`}
                          >
                            {fmtSig(sub.net)}
                          </span>
                          {sub.losses > 0 && (
                            <>
                              {" "}
                              ·{" "}
                              <span className="font-bold text-coral">
                                {sub.losses}
                              </span>{" "}
                              loss{sub.losses === 1 ? "" : "es"}
                            </>
                          )}
                        </span>
                        <div className="mt-0.5 font-normal normal-case italic tracking-normal text-deep-green/45">
                          {aprBenchmarkLabel}
                        </div>
                      </td>
                    </tr>
                    <ColumnHeadersRow
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onClick={toggleSort}
                    />
                    {g.rows.map((r) => (
                      <Row
                        key={`${r.venueId ?? r.venueRawName}|${r.matchStartIso}`}
                        row={r}
                        onJumpToConfig={onJumpToConfig}
                      />
                    ))}
                  </tbody>
                );
              })
            )}
          </table>
        </div>
      </div>

      {/* Main cards — mobile. One outer card per city group; each
          match becomes a tappable card with a 3-col Total/Cost/Net
          grid and an expandable secondary-metrics row. Mirrors the
          Field Ranking mobile pattern. */}
      <div className="md:hidden space-y-3">
        {activeRows === null ? (
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white px-3 py-8 text-center text-sm text-deep-green/55 shadow-md shadow-deep-green/10">
            Loading match P&L…
          </div>
        ) : cityGroups.length === 0 ? (
          <div className="rounded-2xl border-[1.5px] border-cream-line bg-white px-3 py-8 text-center text-sm text-deep-green/55 shadow-md shadow-deep-green/10">
            No matches with cost data this week.
            {missingCost.length > 0 &&
              ` (${missingCost.length} matches without cost set — see below.)`}
          </div>
        ) : (
          cityGroups.map((g) => {
            const sub = citySubtotal(g.rows);
            const aprMemberRev = data
              ? cityMembershipRevenueFor(data, g.city, "Apr 2026")
              : 0;
            const aprMemberSpots =
              data?.mdapiMemberSpots.byCityMonth.get(
                `${g.city}|Apr 2026`,
              )?.member ?? 0;
            const aprBenchmarkLabel =
              aprMemberSpots > 0
                ? `April benchmark: ~$${(aprMemberRev / aprMemberSpots).toFixed(2)}/member spot`
                : "April benchmark: no member spots recorded";
            return (
              <div
                key={g.city}
                className="rounded-2xl border-[1.5px] border-cream-line bg-white p-3 shadow-md shadow-deep-green/10"
              >
                <MobileCityHeader
                  city={g.city}
                  sub={sub}
                  aprBenchmarkLabel={aprBenchmarkLabel}
                />
                <div className="mt-3 space-y-2">
                  {g.rows.map((r) => {
                    const key = `${r.venueId ?? r.venueRawName}|${r.matchStartIso}`;
                    return (
                      <MobileMatchCard
                        key={key}
                        row={r}
                        expanded={mobileExpanded.has(key)}
                        onToggle={() => toggleMobileExpanded(key)}
                        onJumpToConfig={onJumpToConfig}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Missing-cost section — same shape as the main table but
          rendered separately so they don't pollute the loss/profit
          sort. */}
      {missingCost.length > 0 && (
        <div className="hidden md:block overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
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

      {/* Missing-cost cards — mobile. */}
      {missingCost.length > 0 && (
        <div className="md:hidden rounded-2xl border-[1.5px] border-cream-line bg-white p-3 shadow-md shadow-deep-green/10">
          <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
            No cost set ({missingCost.length})
          </div>
          <div className="mt-3 space-y-2">
            {missingCost
              .slice()
              .sort(
                (a, b) =>
                  a.venueDisplayName.localeCompare(b.venueDisplayName) ||
                  a.matchStart.getTime() - b.matchStart.getTime(),
              )
              .map((r) => {
                const key = `${r.venueId ?? r.venueRawName}|${r.matchStartIso}`;
                return (
                  <MobileMatchCard
                    key={key}
                    row={r}
                    expanded={mobileExpanded.has(key)}
                    onToggle={() => toggleMobileExpanded(key)}
                    onJumpToConfig={onJumpToConfig}
                  />
                );
              })}
          </div>
        </div>
      )}

      {/* Canceled-matches section — sunk cost (you paid the venue)
          even though the match never ran and earned $0. Sorted city
          then time. Limitation: only canceled matches that had at
          least one registration appear; zero-registration cancellations
          aren't visible from match_registrations alone. */}
      {canceledSorted.length > 0 && (
        <div className="hidden md:block overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-cream-line bg-cream-soft/60 px-4 py-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
              Canceled Matches
            </div>
            <div className="text-[11px] text-deep-green/65">
              <span className="font-bold tabular-nums text-deep-green">
                {canceledSummary.totalMatches}
              </span>{" "}
              match{canceledSummary.totalMatches === 1 ? "" : "es"} ·{" "}
              <span className="font-mono font-bold tabular-nums text-deep-green">
                {fmtUsd(canceledSummary.sunkCost)}
              </span>{" "}
              in fixed field costs
              {canceledSummary.matchesWithoutCost > 0 &&
                ` · ${canceledSummary.matchesWithoutCost} missing cost`}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                {canceledSorted.map((r) => (
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

      {/* Canceled cards — mobile. */}
      {canceledSorted.length > 0 && (
        <div className="md:hidden rounded-2xl border-[1.5px] border-cream-line bg-white p-3 shadow-md shadow-deep-green/10">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
              Canceled Matches
            </div>
            <div className="text-[11px] text-deep-green/65">
              <span className="font-bold tabular-nums text-deep-green">
                {canceledSummary.totalMatches}
              </span>{" "}
              · sunk{" "}
              <span className="font-mono font-bold tabular-nums text-deep-green">
                {fmtUsd(canceledSummary.sunkCost)}
              </span>
              {canceledSummary.matchesWithoutCost > 0 &&
                ` · ${canceledSummary.matchesWithoutCost} no cost`}
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {canceledSorted.map((r) => {
              const key = `${r.venueId ?? r.venueRawName}|${r.matchStartIso}`;
              return (
                <MobileMatchCard
                  key={key}
                  row={r}
                  expanded={mobileExpanded.has(key)}
                  onToggle={() => toggleMobileExpanded(key)}
                  onJumpToConfig={onJumpToConfig}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Sortable column headers rendered as a <tr>. Lives inside each
// city's <tbody> rather than a single top-of-table <thead> so the
// labels stay visible while scrolling past long city sections.
// Sort state + handler are threaded in so each repeated row still
// drives the same global sort.
function ColumnHeadersRow({
  sortKey,
  sortDir,
  onClick,
}: {
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
}) {
  return (
    <tr className="bg-cream-soft text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
      <SortHeader k="match" label="Match" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="left" />
      <SortHeader k="city" label="City" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="left" />
      <SortHeader k="spotsSold" label="Spots Booked" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader
        k="paidSpots"
        label="Paid Spots"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Count of DAILY PAID fills at this match. Excludes MEMBER, FREE_NON_MEMBER, and PROMOCODE."
      />
      <SortHeader k="grossRevenue" label="DPP Rev" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader
        k="memberSpots"
        label="Member Spots"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Count of MEMBER fills at this match (subscription-joined). Pairs with Member Rev valued at the April benchmark rate."
      />
      <SortHeader
        k="memberRev"
        label="Member Rev"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Member play valued at the city's April benchmark rate (memberSpots × April $/spot). Not collected membership revenue; that lives on /finance Cities."
      />
      <SortHeader
        k="credit"
        label="Credit"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="Portion of DPP Rev paid via account credit (already included in DPP Rev, not additive)."
      />
      <SortHeader
        k="total"
        label="Total"
        sortKey={sortKey}
        sortDir={sortDir}
        onClick={onClick}
        align="right"
        tooltip="DPP + Member. The actual gross revenue for the match (cash spots + allocated membership share)."
      />
      <SortHeader k="fieldCost" label="Field Cost" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader k="net" label="Net" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="right" />
      <SortHeader k="status" label="Status" sortKey={sortKey} sortDir={sortDir} onClick={onClick} align="left" />
    </tr>
  );
}

function SortHeader({
  k,
  label,
  sortKey,
  sortDir,
  onClick,
  align,
  tooltip,
}: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: SortDir;
  onClick: (k: SortKey) => void;
  align: "left" | "right";
  tooltip?: string;
}) {
  const active = sortKey === k;
  const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={`px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onClick(k)}
        title={tooltip}
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
  onJumpToConfig?: (venueId: number) => void;
}) {
  return (
    <tr className="border-t border-cream-line/60">
      <td className="px-3 py-2 align-top">
        <div className="flex items-center gap-1.5">
          <span className="font-bold text-deep-green">{row.venueDisplayName}</span>
          {row.isTournament && <TournamentBadge />}
        </div>
        <div className="text-[11px] text-deep-green/55">
          {row.dayLabel}, {fmtMonthDay(row.matchStart)} · {row.timeLabel}
        </div>
      </td>
      <td className="px-3 py-2 align-top text-deep-green/75">{row.city}</td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.status === "canceled" ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          <>
            {row.spotsSold}
            {row.freeNonMemberSpots > 0 && (
              <span className="ml-1 text-[10px] font-normal text-deep-green/45">
                (+{row.freeNonMemberSpots} free)
              </span>
            )}
          </>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.status === "canceled" ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          row.paidSpots
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {fmtUsd(row.grossRevenue)}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.status === "canceled" ? (
          <span className="text-deep-green/35">—</span>
        ) : (
          row.memberSpots
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {fmtUsd(row.allocatedMemberRev)}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums text-deep-green">
        {row.credit > 0 ? fmtUsd(row.credit) : (
          <span className="text-deep-green/35">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-right align-top font-mono tabular-nums font-bold text-deep-green">
        {fmtUsd(row.grossRevenue + row.allocatedMemberRev)}
      </td>
      <td className="px-3 py-2 text-right align-top">
        {row.fieldCost === null ? (
          row.venueId !== null && onJumpToConfig ? (
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
              $? — set in Field Costs
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

// Mobile-only city header. Compact subtitle wraps across multiple
// lines rather than running off the right edge of the screen.
function MobileCityHeader({
  city,
  sub,
  aprBenchmarkLabel,
}: {
  city: string;
  sub: {
    matches: number;
    gross: number;
    memberRev: number;
    memberSpots: number;
    paidSpots: number;
    credit: number;
    cost: number;
    net: number;
    losses: number;
  };
  aprBenchmarkLabel: string;
}) {
  const netClass =
    sub.net > 10
      ? "text-mint-hover"
      : sub.net < -10
        ? "text-coral"
        : "text-deep-green/55";
  return (
    <div className="border-b border-cream-line/60 pb-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-deep-green">
          {city}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
          {sub.matches} {sub.matches === 1 ? "match" : "matches"}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-deep-green/65">
        <span>
          Total{" "}
          <span className="font-mono font-bold tabular-nums text-deep-green">
            {fmtUsd(sub.gross + sub.memberRev)}
          </span>
        </span>
        <span>
          Cost{" "}
          <span className="font-mono tabular-nums text-deep-green">
            {fmtUsd(sub.cost)}
          </span>
        </span>
        <span>
          Net{" "}
          <span className={`font-mono font-bold tabular-nums ${netClass}`}>
            {fmtSig(sub.net)}
          </span>
        </span>
        {sub.losses > 0 && (
          <span>
            <span className="font-bold tabular-nums text-coral">
              {sub.losses}
            </span>{" "}
            loss{sub.losses === 1 ? "" : "es"}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-[10px] italic text-deep-green/45">
        {aprBenchmarkLabel}
      </div>
    </div>
  );
}

// Mobile-only match card. Used in all three sections (active by city,
// no-cost, canceled). Adapts to each status:
//   active           → spots populated, net colored
//   canceled         → spots show "—" (match never ran)
//   missing-cost     → cost cell renders the "$? — set in Field Costs"
//                      affordance, net shows "—"
function MobileMatchCard({
  row,
  expanded,
  onToggle,
  onJumpToConfig,
}: {
  row: MatchPnLRow;
  expanded: boolean;
  onToggle: () => void;
  onJumpToConfig?: (venueId: number) => void;
}) {
  const isCanceled = row.status === "canceled";
  const totalRev = row.grossRevenue + row.allocatedMemberRev;
  const netClass =
    row.net === null
      ? ""
      : row.net > 10
        ? "text-mint-hover"
        : row.net < -10
          ? "text-coral"
          : "text-deep-green/75";
  return (
    <div className="rounded-xl border border-cream-line bg-white p-3 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-semibold text-deep-green">
              {row.venueDisplayName}
            </span>
            {row.isTournament && <TournamentBadge />}
          </div>
          <div className="mt-0.5 text-[11px] text-deep-green/55">
            {row.dayLabel}, {fmtMonthDay(row.matchStart)} · {row.timeLabel}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_PILL[row.status]}`}
        >
          {STATUS_LABEL[row.status]}
        </span>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Total
          </span>
          <span className="font-mono font-bold tabular-nums text-deep-green">
            {fmtUsd(totalRev)}
          </span>
        </div>
        <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Cost
          </span>
          {row.fieldCost === null ? (
            row.venueId !== null && onJumpToConfig ? (
              <button
                type="button"
                onClick={() => onJumpToConfig(row.venueId as number)}
                className="text-left font-mono italic text-coral underline-offset-2 hover:underline"
              >
                $?
              </button>
            ) : (
              <span className="font-mono italic text-deep-green/45">$?</span>
            )
          ) : (
            <span className="font-mono tabular-nums text-deep-green">
              {fmtUsd(row.fieldCost)}
            </span>
          )}
        </div>
        <div className="flex flex-col rounded-md bg-cream-soft/50 px-2 py-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            Net
          </span>
          {row.net === null ? (
            <span className="font-mono text-deep-green/35">—</span>
          ) : (
            <span className={`font-mono font-bold tabular-nums ${netClass}`}>
              {fmtSig(row.net)}
            </span>
          )}
        </div>
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
          <InlineMetric
            label="Spots Booked"
            value={
              isCanceled
                ? "—"
                : row.freeNonMemberSpots > 0
                  ? `${row.spotsSold} (+${row.freeNonMemberSpots} free)`
                  : String(row.spotsSold)
            }
          />
          <InlineMetric
            label="Paid Spots"
            value={isCanceled ? "—" : String(row.paidSpots)}
          />
          <InlineMetric
            label="Member Spots"
            value={isCanceled ? "—" : String(row.memberSpots)}
          />
          <InlineMetric label="DPP Rev" value={fmtUsd(row.grossRevenue)} />
          <InlineMetric
            label="Member Rev"
            value={fmtUsd(row.allocatedMemberRev)}
          />
          <InlineMetric
            label="Credit"
            value={row.credit > 0 ? fmtUsd(row.credit) : "—"}
          />
        </div>
      )}
    </div>
  );
}

function InlineMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-deep-green/55">{label}</span>
      <span className="font-mono tabular-nums text-deep-green/85">{value}</span>
    </div>
  );
}

// Small chip next to a Soccer Central match's venue name when the
// row is on the Tournament leg ($120, two side-by-side 9v9 fields).
// Same pattern as the existing status pills — mint pill so it reads
// as informational rather than alarming.
function TournamentBadge() {
  return (
    <span
      title="Soccer Central tournament — two fields, $120"
      className="shrink-0 rounded-full bg-mint-soft px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-deep-green ring-1 ring-mint/40"
    >
      Tournament
    </span>
  );
}
