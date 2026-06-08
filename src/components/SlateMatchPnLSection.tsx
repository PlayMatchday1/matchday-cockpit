"use client";

// Slate Review's Match P&L section — same per-match table the Finance
// > Match P&L tab renders, scoped to one city for the last completed
// week. No prev/next nav; the week is whatever
// mostRecentCompletedWeekMonday() returns, matching the default the
// tab lands on. Canceled matches are excluded entirely — this is a
// realized-matches view per the Slate Review framing.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cityMembershipRevenueFor } from "@/lib/financeStats";
import { mostRecentCompletedMonth } from "@/lib/quarters";
import {
  fetchWeekMatchPnL,
  type MatchPnLRow,
} from "@/lib/matchPnL";
import {
  mostRecentCompletedWeekMonday,
  sundayEndOf,
  sundayOf,
} from "@/lib/weekWindow";
import { useFinanceData } from "@/lib/useFinanceData";
import type { City } from "@/lib/types";
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

export default function SlateMatchPnLSection({ city }: { city: City }) {
  const { data, loading: dataLoading } = useFinanceData();

  // Fixed to the last completed week — no navigation in this section.
  // Recomputed only if the component remounts (Slate Review doesn't
  // remount per tab switch, so this matches the week the Match P&L
  // tab opened to at page load).
  const weekStart = useMemo(() => mostRecentCompletedWeekMonday(), []);
  const weekEnd = useMemo(() => sundayEndOf(weekStart), [weekStart]);
  const weekLabel = useMemo(() => {
    const sun = sundayOf(weekStart);
    return `${fmtMonthDay(weekStart)} – ${fmtMonthDay(sun)}`;
  }, [weekStart]);

  const [activeRows, setActiveRows] = useState<MatchPnLRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("net");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
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

  useEffect(() => {
    let cancelled = false;
    if (dataLoading || !data) return;
    setActiveRows(null);
    setError(null);
    fetchWeekMatchPnL(supabase, weekStart, weekEnd, data)
      .then((result) => {
        if (cancelled) return;
        // Canceled rows are intentionally dropped — Slate Review's
        // Match P&L is a realized-only read. Missing-cost rows stay
        // in the table; their Field Cost cell renders the standard
        // "$? — set in Field Costs" affordance.
        setActiveRows(result.active);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [weekStart, weekEnd, data, dataLoading]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir(defaultSortDirFor(k));
    }
  }

  // City-scoped rows, sorted. One table, all non-canceled rows
  // (loss/breakeven/profit/missing-cost) together — Slate Review
  // doesn't split missing-cost into its own sub-section the way the
  // tab does.
  const rows = useMemo(() => {
    if (!activeRows) return null;
    return activeRows
      .filter((r) => r.city === city)
      .sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [activeRows, city, sortKey, sortDir]);

  const sub = useMemo(() => (rows ? citySubtotal(rows) : null), [rows]);

  // Benchmark rolls to the most recent completed month (May once we're in
  // June, June once we're in July, ...) with no manual edit.
  const benchmarkLabel = useMemo(() => {
    if (!data) return "";
    const { key: month, name } = mostRecentCompletedMonth();
    const memberRev = cityMembershipRevenueFor(data, city, month);
    const memberSpots =
      data.mdapiMemberSpots.byCityMonth.get(`${city}|${month}`)?.member ?? 0;
    return memberSpots > 0
      ? `${name} benchmark: ~$${(memberRev / memberSpots).toFixed(2)}/member spot (${fmtUsd(memberRev)} ÷ ${memberSpots} spots)`
      : `${name} benchmark: no member spots recorded`;
  }, [data, city]);

  const benchmarkLabelMobile = useMemo(() => {
    if (!data) return "";
    const { key: month, name } = mostRecentCompletedMonth();
    const memberRev = cityMembershipRevenueFor(data, city, month);
    const memberSpots =
      data.mdapiMemberSpots.byCityMonth.get(`${city}|${month}`)?.member ?? 0;
    return memberSpots > 0
      ? `${name} benchmark: ~$${(memberRev / memberSpots).toFixed(2)}/member spot`
      : `${name} benchmark: no member spots recorded`;
  }, [data, city]);

  if (error) {
    return (
      <div className="rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-xs text-coral">
        {error}
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="space-y-3">
        <WeekLine label={weekLabel} />
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white px-3 py-8 text-center text-sm text-deep-green/55 shadow-md shadow-deep-green/10">
          Loading match P&L…
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        <WeekLine label={weekLabel} />
        <div className="rounded-2xl border-[1.5px] border-cream-line bg-white px-3 py-8 text-center text-sm text-deep-green/55 shadow-md shadow-deep-green/10">
          No matches this week.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <WeekLine label={weekLabel} />

      {/* Desktop table — same shape as the Match P&L tab for a single
          city. City header summary line + column headers + per-match
          rows, all inside one <tbody>. */}
      {sub && (
        <div className="hidden md:block overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                <tr className="border-t-2 border-cream-line bg-cream-soft/50">
                  <td
                    colSpan={12}
                    className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-deep-green"
                  >
                    {city}
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
                      {benchmarkLabel}
                    </div>
                  </td>
                </tr>
                <ColumnHeadersRow
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onClick={toggleSort}
                />
                {rows.map((r) => (
                  <Row
                    key={`${r.venueId ?? r.venueRawName}|${r.matchStartIso}`}
                    row={r}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mobile cards — same per-city card pattern as the tab. */}
      {sub && (
        <div className="md:hidden rounded-2xl border-[1.5px] border-cream-line bg-white p-3 shadow-md shadow-deep-green/10">
          <MobileCityHeader
            city={city}
            sub={sub}
            benchmarkLabel={benchmarkLabelMobile}
          />
          <div className="mt-3 space-y-2">
            {rows.map((r) => {
              const key = `${r.venueId ?? r.venueRawName}|${r.matchStartIso}`;
              return (
                <MobileMatchCard
                  key={key}
                  row={r}
                  expanded={mobileExpanded.has(key)}
                  onToggle={() => toggleMobileExpanded(key)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function WeekLine({ label }: { label: string }) {
  return (
    <div className="text-[11px] text-deep-green/55">
      Week of{" "}
      <span className="font-mono font-bold tabular-nums text-deep-green/75">
        {label}
      </span>{" "}
      · last completed week
    </div>
  );
}
