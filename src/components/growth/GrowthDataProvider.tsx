"use client";

// THE GROWTH DATA LAYER, MOUNTED ONCE IN THE SECTION LAYOUT.
//
// Growth used to be one scrolling page whose component fetched both aggregates and passed them
// down. Splitting it into six routes without moving the fetch would have made every rail click
// re-request /api/growth and /api/growth/retention — the same mistake as re-rendering a chart per
// page. The layout does not remount between /growth/* routes, so mounting the provider there means
// ONE pair of requests per visit and instant section switching. Same reason Match Ops mounts its
// conversation provider in its layout.
//
// THE PERIOD LIVES HERE TOO. It is shared state: set the period on Player Funnel, click Behavior,
// and it is still set. It used to be local to the dashboard component, which no longer exists.
//
// NOTHING WAS REIMPLEMENTED. The two fetches, the error/loading states and defaultPeriod are the
// dashboard's own, moved verbatim.

import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { CohortMatrixPayload } from "./retentionModel";
import { type Period } from "./GlobalPeriod";

export type GrowthCtx = {
  data: GrowthData | null;
  retention: CohortMatrixPayload | null;
  authHeaders: Record<string, string>;
  error: string | null;
  months: string[];
  period: Period | null;
  activePeriod: Period | null;
  setPeriod: (p: Period) => void;
};

const Ctx = createContext<GrowthCtx | null>(null);

export function useGrowth(): GrowthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useGrowth must be used within GrowthDataProvider");
  return c;
}

// PART 2a: open on the last 6 COMPLETED months (excludes the current partial month) so the panel
// doesn't default to a wall of correct-but-empty pre-2026 dashes. Moved verbatim.
function defaultPeriod(months: string[], nowMonth: string): Period {
  const completed = months.filter((m) => m < nowMonth);
  const last6 = completed.slice(-6);
  return { start: last6[0] ?? months[0], end: last6[last6.length - 1] ?? months[months.length - 1] };
}

export default function GrowthDataProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<GrowthData | null>(null);
  const [retention, setRetention] = useState<CohortMatrixPayload | null>(null);
  const [authHeaders, setAuthHeaders] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data: sess } = await supabase.auth.getSession();
        const token = sess.session?.access_token;
        if (!token) throw new Error("Not signed in");
        const headers = { Authorization: `Bearer ${token}` };
        if (alive) setAuthHeaders(headers);
        const [res, retRes] = await Promise.all([
          fetch("/api/growth", { headers }),
          fetch("/api/growth/retention", { headers }),
        ]);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Request failed (${res.status})`);
        }
        const json = (await res.json()) as GrowthData;
        if (alive) {
          setData(json);
          const ms = json.behaviorOverall.map((p) => p.m);
          if (ms.length) setPeriod(defaultPeriod(ms, json.generatedAt.slice(0, 7)));
        }
        if (retRes.ok && alive) setRetention((await retRes.json()) as CohortMatrixPayload);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => { alive = false; };
  }, []);

  const months = data ? data.behaviorOverall.map((p) => p.m) : [];
  const activePeriod: Period | null = data
    ? (period ?? defaultPeriod(months, data.generatedAt.slice(0, 7)))
    : null;

  return (
    <Ctx.Provider value={{ data, retention, authHeaders, error, months, period, activePeriod, setPeriod }}>
      {children}
    </Ctx.Provider>
  );
}
