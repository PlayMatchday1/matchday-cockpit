"use client";

// Org goals column on Home — rebuilt to the mockup's card. Org goals only
// (company-wide, quarter-agnostic). Cards are click-to-edit via the existing
// GoalEditDrawer; status/pace is derived in OrgGoalCard, never stored.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Goal } from "@/lib/types";
import OrgGoalCard from "./OrgGoalCard";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";

export default function HomeGoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>(null);

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

  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3 px-[2px]">
        <h2 className="text-[17px] font-bold tracking-[-0.012em] text-[#12241d]">
          Org goals
        </h2>
        <span className="text-[12.5px] text-[#6d7b74]">
          Company-wide objectives
        </span>
      </div>

      <div className="space-y-[14px]">
        {goals.map((g) => (
          <OrgGoalCard
            key={g.id}
            goal={g}
            onEdit={(goal) => setDrawer({ mode: "edit", goal })}
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
    </section>
  );
}
