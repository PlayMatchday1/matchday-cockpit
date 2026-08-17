"use client";

// FINANCE DATA FOR A PERIOD, WHATEVER ITS GRAIN.
//
// The loader fetches ONE QUARTER at a time and caches by quarter key. A month sits inside one
// quarter; a quarter is one; a year is up to four. So this mounts a FIXED four loaders and merges
// what comes back — fixed because hooks cannot be called conditionally, and four because that is
// the widest a year can be.
//
// UNUSED SLOTS RESOLVE TO A QUARTER ALREADY BEING FETCHED, so a Month grain costs exactly one
// request: the cache is keyed by quarter, and asking for the same key three more times is three
// cache hits, not three fetches.
//
// THE MERGE IS BY MONTH OWNERSHIP, never concatenation. Each quarter's window is padded ±14 days,
// so the boundary fortnight appears in two fetches; concatenating would double-count it, and
// taking whichever arrived first would hand back a FRAGMENT of a month wearing the whole month's
// label. financeDataMerge.ts carries the full argument.

import { useMemo } from "react";
import { useFinanceDataForQuarter, type FinanceData } from "./useFinanceData";
import { mergeFinanceDataByMonth } from "./financeDataMerge";
import type { FinancePeriod } from "./financePeriod";
import type { Q2Month } from "./financeStats";

export type PeriodDataState = { data: FinanceData | null; loading: boolean; error: string | null };

export function useFinancePeriodData(period: FinancePeriod): PeriodDataState {
  const qs = period.quarters;
  const head = qs[0];
  // Same key => same cache entry => no extra request.
  const a = useFinanceDataForQuarter(head ?? qs[0]);
  const b = useFinanceDataForQuarter(qs[1] ?? head);
  const c = useFinanceDataForQuarter(qs[2] ?? head);
  const d = useFinanceDataForQuarter(qs[3] ?? head);

  return useMemo(() => {
    const slots = [a, b, c, d].slice(0, Math.max(1, qs.length));
    const loading = slots.some((s) => s.loading);
    const error = slots.find((s) => s.error)?.error ?? null;
    if (!a.data) return { data: null, loading, error };

    // Fold the later quarters in, each owning only ITS OWN months.
    let merged: FinanceData | null = a.data;
    for (let i = 1; i < qs.length; i++) {
      const src = slots[i]?.data;
      if (!src) continue;
      const own = new Set<Q2Month>(qs[i].months.map((m) => m.key));
      merged = mergeFinanceDataByMonth(merged, src, own);
    }
    return { data: merged, loading, error };
  }, [a, b, c, d, qs]);
}
