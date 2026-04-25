"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { swapGoalSortOrder } from "@/lib/goals";
import type { City, Goal } from "@/lib/types";
import GoalCard from "./GoalCard";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";
import GoalFocusZone from "./GoalFocusZone";

export default function CityGoalsView({ city }: { city: City }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("scope", "city")
      .eq("city", city)
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    setGoals((data ?? []) as Goal[]);
  }, [city]);

  useEffect(() => {
    load();
  }, [load]);

  async function moveGoal(goal: Goal, direction: "up" | "down") {
    const idx = goals.findIndex((g) => g.id === goal.id);
    if (idx === -1) return;
    const targetIdx = direction === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= goals.length) return;
    const target = goals[targetIdx];
    if (goal.sort_order === null || target.sort_order === null) return;

    const original = goals;
    const newGoals = goals
      .map((g) => {
        if (g.id === goal.id) return { ...g, sort_order: target.sort_order };
        if (g.id === target.id) return { ...g, sort_order: goal.sort_order };
        return g;
      })
      .sort((a, b) => {
        const aSort = a.sort_order ?? Number.POSITIVE_INFINITY;
        const bSort = b.sort_order ?? Number.POSITIVE_INFINITY;
        if (aSort !== bSort) return aSort - bSort;
        return a.created_at.localeCompare(b.created_at);
      });
    setGoals(newGoals);

    const { error } = await swapGoalSortOrder(goal, target);
    if (error) {
      setGoals(original);
      alert(error);
    }
  }

  const focused = focusedId
    ? (goals.find((g) => g.id === focusedId) ?? null)
    : null;

  return (
    <>
      {focused && (
        <GoalFocusZone
          key={focused.id}
          goal={focused}
          onClose={() => setFocusedId(null)}
          onEdit={() => setDrawer({ mode: "edit", goal: focused })}
        />
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {goals.map((g, i) => (
          <GoalCard
            key={g.id}
            goal={g}
            onFocus={() => setFocusedId(g.id)}
            isFocused={focusedId === g.id}
            canMoveUp={i > 0}
            canMoveDown={i < goals.length - 1}
            onMoveUp={() => moveGoal(g, "up")}
            onMoveDown={() => moveGoal(g, "down")}
          />
        ))}
        <button
          type="button"
          onClick={() => setDrawer({ mode: "create", scope: "city", city })}
          className="flex min-h-[140px] items-center justify-center rounded-2xl border-2 border-dashed border-deep-green/20 bg-cream-soft/40 text-sm font-semibold text-deep-green/60 transition hover:border-deep-green/50 hover:bg-cream-soft hover:text-deep-green"
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
