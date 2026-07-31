"use client";

// Org goals column on Home. Org goals only. Each card derives status/pace and
// reads its latest comment from the shared useGoalComments store, so posting an
// update in the comments drawer refreshes the note row without a reload.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Goal } from "@/lib/types";
import { computeGoalPace } from "@/lib/goalPace";
import OrgGoalCard from "./OrgGoalCard";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";
import GoalCommentsDrawer from "./GoalCommentsDrawer";

export default function HomeGoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [commentsGoal, setCommentsGoal] = useState<Goal | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("scope", "org")
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    setGoals((data ?? []) as Goal[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Keep the comments drawer's goal reference current if the goal list reloads.
  const openComments = useCallback((g: Goal) => setCommentsGoal(g), []);

  const offPace = useMemo(
    () =>
      goals.filter((g) => {
        const k = computeGoalPace({
          progress: g.progress,
          startDate: g.start_date,
          createdAt: g.created_at,
          targetDate: g.target_date,
        }).status?.key;
        return k === "behind" || k === "risk";
      }).length,
    [goals],
  );

  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3 px-[2px]">
        <h2 className="text-[17px] font-bold tracking-[-0.012em] text-[#12241d]">
          Org goals
        </h2>
        <span className="text-[12.5px] text-[#6d7b74]">
          {goals.length} goal{goals.length === 1 ? "" : "s"} ·{" "}
          {offPace > 0 ? `${offPace} off pace` : "all on pace"}
        </span>
      </div>

      <div className="space-y-[14px]">
        {goals.map((g) => (
          <OrgGoalCard
            key={g.id}
            goal={g}
            onEdit={(goal) => setDrawer({ mode: "edit", goal })}
            onOpenComments={openComments}
          />
        ))}
        <button
          type="button"
          onClick={() => setDrawer({ mode: "create", scope: "org" })}
          className="w-full rounded-[12px] border border-dashed px-3 py-[13px] text-[13px] font-semibold transition"
          style={{ borderColor: "#d5cbb4", color: "#7b8a83" }}
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

      <GoalCommentsDrawer goal={commentsGoal} onClose={() => setCommentsGoal(null)} />
    </section>
  );
}
