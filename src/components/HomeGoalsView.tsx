"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { swapGoalSortOrder } from "@/lib/goals";
import type { Goal, Scope } from "@/lib/types";
import GoalsSection from "./GoalsSection";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";

export default function HomeGoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("goals")
      .select("*")
      .in("scope", ["org", "q2", "monthly"])
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    setGoals((data ?? []) as Goal[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function moveGoal(goal: Goal, direction: "up" | "down") {
    const peers = goals.filter((g) => g.scope === goal.scope);
    const idx = peers.findIndex((g) => g.id === goal.id);
    if (idx === -1) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= peers.length) return;
    const target = peers[targetIdx];
    if (goal.sort_order === null || target.sort_order === null) return;

    const original = goals;
    const newGoals = goals
      .map((g) => {
        if (g.id === goal.id) return { ...g, sort_order: target.sort_order };
        if (g.id === target.id) return { ...g, sort_order: goal.sort_order };
        return g;
      })
      .sort(sortGoals);
    setGoals(newGoals);

    const { error } = await swapGoalSortOrder(goal, target);
    if (error) {
      setGoals(original);
      alert(error);
    }
  }

  const sections: { scope: Scope; title: string; subtitle: string }[] = [
    { scope: "org", title: "Org goals", subtitle: "Company-wide objectives" },
    {
      scope: "q2",
      title: "Q2 goals",
      subtitle: "What we're shipping this quarter",
    },
    {
      scope: "monthly",
      title: "Monthly goals",
      subtitle: "This month's focus",
    },
  ];

  return (
    <>
      <div className="space-y-12">
        {sections.map((s) => (
          <GoalsSection
            key={s.scope}
            title={s.title}
            subtitle={s.subtitle}
            goals={goals.filter((g) => g.scope === s.scope)}
            onEdit={(g) => setDrawer({ mode: "edit", goal: g })}
            onAdd={() => setDrawer({ mode: "create", scope: s.scope })}
            onChange={load}
            onMove={moveGoal}
          />
        ))}
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

function sortGoals(a: Goal, b: Goal): number {
  const aSort = a.sort_order ?? Number.POSITIVE_INFINITY;
  const bSort = b.sort_order ?? Number.POSITIVE_INFINITY;
  if (aSort !== bSort) return aSort - bSort;
  return a.created_at.localeCompare(b.created_at);
}
