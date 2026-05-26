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
} from "@/lib/matchPnL";
import {
  mostRecentCompletedWeekMonday,
  sundayEndOf,
  sundayOf,
} from "@/lib/weekWindow";
import {
  citySubtotal,
  ColumnHeadersRow,
  compareRows,
  defaultSortDirFor,
  fmtMonthDay,
  fmtSig,
  fmtUsd,
  MobileCityHeader,
  MobileMatchCard,
  Row,
  type SortDir,
  type SortKey,
} from "@/components/matchPnLParts";

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
      setSortDir(defaultSortDirFor(k));
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
    const cmp = (a: MatchPnLRow, b: MatchPnLRow) =>
      compareRows(a, b, sortKey, sortDir);
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

