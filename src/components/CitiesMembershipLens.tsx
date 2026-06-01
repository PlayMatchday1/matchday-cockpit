"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import MembershipActiveChart from "./MembershipActiveChart";
import MembershipByCityTable from "./MembershipByCityTable";
import MembershipHealthTable from "./MembershipHealthTable";
import MembershipMonthSelector from "./MembershipMonthSelector";
import MembershipSnapshot from "./MembershipSnapshot";
import MembershipTrendChart from "./MembershipTrendChart";
import {
  firstOfMonthIso,
  isoToMonthParam,
  monthLabelFromIso,
  monthParamToIso,
  useMembershipSnapshots,
  type MembershipMonthView,
} from "@/lib/useMembershipSnapshots";

// Top-down narrative: month selector → KPI snapshot → health by city →
// per-city Active/New/Cancelled → all-time line → 6-month bars.
//
// The selector switches the first three cards between the LIVE view
// (current calendar month, computed from mdapi_subscriptions) and a
// CAPTURED snapshot (any prior month, read from members_monthly_snapshots
// so the numbers don't drift as members cancel later). The two charts
// are already multi-month timelines and ignore the selector.
export default function CitiesMembershipLens() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { rows, loading } = useMembershipSnapshots();

  // Current calendar month is always the live view; everything else
  // reads its captured snapshot row. ?month=YYYY-MM deep-links a prior
  // month; junk / missing falls back to current.
  const currentIso = firstOfMonthIso(new Date());
  const selectedIso = monthParamToIso(searchParams.get("month")) ?? currentIso;
  const isCurrentMonth = selectedIso === currentIso;

  // Option list: every snapshot month plus the current month (in case
  // today's row hasn't been captured yet), newest first, de-duped.
  const monthOptions = useMemo(() => {
    const set = new Set<string>([currentIso, ...rows.map((r) => r.month)]);
    return [...set].sort((a, b) => (a < b ? 1 : -1));
  }, [rows, currentIso]);

  const snapshotRow = rows.find((r) => r.month === selectedIso) ?? null;

  const setMonth = useCallback(
    (iso: string) => {
      // Preserve the membership tab; only carry ?month= for a prior
      // month so the current-month view keeps a clean URL.
      const params = new URLSearchParams();
      params.set("tab", "membership");
      if (iso !== currentIso) params.set("month", isoToMonthParam(iso));
      router.replace(`/cities?${params.toString()}`, { scroll: false });
    },
    [router, currentIso],
  );

  const view: MembershipMonthView = {
    monthIso: selectedIso,
    monthLabel: monthLabelFromIso(selectedIso),
    isCurrentMonth,
    snapshotRow,
    snapshotLoading: loading,
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          <span>Membership · {view.monthLabel}</span>
          {!isCurrentMonth && (
            <span className="rounded-full bg-cream-soft px-2 py-0.5 text-[10px] tracking-wider text-deep-green/55 ring-1 ring-cream-line">
              captured snapshot
            </span>
          )}
        </div>
        <MembershipMonthSelector
          selectedIso={selectedIso}
          monthOptions={monthOptions}
          onChange={setMonth}
        />
      </div>

      <MembershipSnapshot view={view} />
      <MembershipHealthTable view={view} />
      <MembershipByCityTable view={view} />
      <MembershipActiveChart />
      <MembershipTrendChart />
    </div>
  );
}
