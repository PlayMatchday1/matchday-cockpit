"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
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
      .order("created_at", { ascending: false });
    setGoals((data ?? []) as Goal[]);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const sections: { scope: Scope; title: string; subtitle: string }[] = [
    { scope: "org", title: "Org goals", subtitle: "Company-wide objectives" },
    { scope: "q2", title: "Q2 goals", subtitle: "What we're shipping this quarter" },
    { scope: "monthly", title: "Monthly goals", subtitle: "This month's focus" },
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
