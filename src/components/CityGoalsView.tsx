"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { City, Goal } from "@/lib/types";
import GoalCard from "./GoalCard";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";

export default function CityGoalsView({ city }: { city: City }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("scope", "city")
      .eq("city", city)
      .order("created_at", { ascending: false });
    setGoals((data ?? []) as Goal[]);
  }, [city]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {goals.map((g) => (
          <GoalCard
            key={g.id}
            goal={g}
            onEdit={() => setDrawer({ mode: "edit", goal: g })}
            onChange={load}
          />
        ))}
        <button
          type="button"
          onClick={() => setDrawer({ mode: "create", scope: "city", city })}
          className="flex min-h-[180px] items-center justify-center rounded-xl border-2 border-dashed border-deep-green/20 bg-cream-soft/40 text-sm font-semibold text-deep-green/60 transition hover:border-deep-green/50 hover:bg-cream-soft hover:text-deep-green"
        >
          + Add goal
        </button>
      </div>
      <GoalEditDrawer
        state={drawer}
        onClose={() => setDrawer(null)}
        onSaved={() => {
          setDrawer(null);
          load();
        }}
      />
    </>
  );
}
