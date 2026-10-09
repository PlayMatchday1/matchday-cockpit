"use client";

/* THE MATCH P&L BY FIELD, LOADED ONCE PER WINDOW — for Slate Review and Finance › Revenue alike.
 *
 * SAME INPUTS ON BOTH PAGES, BY CONSTRUCTION. The finance data is the CURRENT quarter's, named
 * explicitly rather than read from useFinanceQuarter(): Finance wraps its pages in a provider that
 * follows the selected period, so the Revenue page set to September would otherwise value member
 * spots from a different load than Slate Review does. Slate has no provider and has always read
 * the current quarter; this is that, said out loud. The result is cached per window, so the second
 * page to ask costs nothing and cannot differ. */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinanceDataForQuarter } from "@/lib/useFinanceData";
import { getCurrentQuarter } from "@/lib/quarters";
import { fetchWeekMatchPnL } from "@/lib/matchPnL";
import { aggregateFieldPnL, completedWeeksWindow, fetchShareCosts, type FieldAgg, type PnLWindow } from "@/lib/fieldPnL";

const CACHE = new Map<string, Promise<FieldAgg[]>>();

export function useFieldPnL(weeks: number): { win: PnLWindow; fields: FieldAgg[] | null; error: string | null } {
  const quarter = useMemo(() => getCurrentQuarter(), []);
  const { data, loading } = useFinanceDataForQuarter(quarter);
  const win = useMemo(() => completedWeeksWindow(weeks), [weeks]);
  const [state, setState] = useState<{ key: string; fields: FieldAgg[] | null; error: string | null }>({ key: "", fields: null, error: null });
  const key = `${quarter.key}|${win.fromYmd}|${win.toYmd}`;

  useEffect(() => {
    if (loading || !data) return;
    let live = true;
    let p = CACHE.get(key);
    if (!p) {
      const now = new Date();
      p = Promise.all([
        fetchWeekMatchPnL(supabase, win.start, win.end, data),
        fetchShareCosts(supabase, data.venues, win, now),
      ]).then(([pnl, share]) => aggregateFieldPnL(pnl.active, new Map(data.venues.map((v) => [v.id, v])), share));
      CACHE.set(key, p);
      // A failed load is not cached: the next mount tries again.
      p.catch(() => CACHE.delete(key));
    }
    p.then((fields) => { if (live) setState({ key, fields, error: null }); },
      (e) => { if (live) setState({ key, fields: null, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  }, [key, data, loading, win]);

  return { win, fields: state.key === key ? state.fields : null, error: state.key === key ? state.error : null };
}
