"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useClubhouseQuarter } from "@/lib/clubhouseQuarter";

type Stats = {
  total: number;
  onTrackPct: number;
  openQuarter: number;
  cities: number;
};

export default function QuickStats() {
  const quarter = useClubhouseQuarter();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The four KPI cards on the Clubhouse Goals view. All three
      // goal counts are scoped to "what's visible on this view" —
      // org goals (company-wide, quarter-agnostic) plus quarter +
      // monthly goals for the selected quarter. Active cities is
      // unchanged at 8 (not quarter-scoped).
      const quarterOrOrgFilter = `scope.eq.org,quarter_key.eq.${quarter.key}`;
      const [total, onTrack, openQuarter] = await Promise.all([
        supabase
          .from("goals")
          .select("*", { count: "exact", head: true })
          .or(quarterOrOrgFilter),
        supabase
          .from("goals")
          .select("*", { count: "exact", head: true })
          .or(quarterOrOrgFilter)
          .eq("status", "On track"),
        supabase
          .from("goals")
          .select("*", { count: "exact", head: true })
          .eq("scope", "q2")
          .eq("quarter_key", quarter.key)
          .neq("status", "Done"),
      ]);
      if (cancelled) return;
      const t = total.count ?? 0;
      const ot = onTrack.count ?? 0;
      setStats({
        total: t,
        onTrackPct: t > 0 ? Math.round((ot / t) * 100) : 0,
        openQuarter: openQuarter.count ?? 0,
        cities: 8,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [quarter.key]);

  const items: { label: string; value: string | number }[] = stats
    ? [
        { label: "Total goals", value: stats.total },
        { label: "% on track", value: `${stats.onTrackPct}%` },
        { label: `Open ${quarter.label.split(" ")[0]} goals`, value: stats.openQuarter },
        { label: "Active cities", value: stats.cities },
      ]
    : [
        { label: "Total goals", value: "—" },
        { label: "% on track", value: "—" },
        { label: `Open ${quarter.label.split(" ")[0]} goals`, value: "—" },
        { label: "Active cities", value: "—" },
      ];

  return (
    <div className="mb-12 grid grid-cols-2 divide-x divide-cream-line rounded-xl border border-cream-line bg-cream-soft py-5 shadow-sm sm:grid-cols-4">
      {items.map((item) => (
        <div key={item.label} className="px-4 text-center">
          <div className="text-3xl font-extrabold tabular-nums tracking-tight text-deep-green md:text-4xl">
            {item.value}
          </div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-wider text-deep-green/60">
            {item.label}
          </div>
        </div>
      ))}
    </div>
  );
}
