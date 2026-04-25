"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Stats = {
  total: number;
  onTrackPct: number;
  openQ2: number;
  cities: number;
};

export default function QuickStats() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [total, onTrack, openQ2] = await Promise.all([
        supabase.from("goals").select("*", { count: "exact", head: true }),
        supabase
          .from("goals")
          .select("*", { count: "exact", head: true })
          .eq("status", "On track"),
        supabase
          .from("goals")
          .select("*", { count: "exact", head: true })
          .eq("scope", "q2")
          .neq("status", "Done"),
      ]);
      if (cancelled) return;
      const t = total.count ?? 0;
      const ot = onTrack.count ?? 0;
      setStats({
        total: t,
        onTrackPct: t > 0 ? Math.round((ot / t) * 100) : 0,
        openQ2: openQ2.count ?? 0,
        cities: 8,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const items: { label: string; value: string | number }[] = stats
    ? [
        { label: "Total goals", value: stats.total },
        { label: "% on track", value: `${stats.onTrackPct}%` },
        { label: "Open Q2 goals", value: stats.openQ2 },
        { label: "Active cities", value: stats.cities },
      ]
    : [
        { label: "Total goals", value: "—" },
        { label: "% on track", value: "—" },
        { label: "Open Q2 goals", value: "—" },
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
