"use client";

// Org goals column on Home. Org goals only. Each card carries its latest
// goal_comment (for the note row) and derives status/pace (never stored). The
// section subtitle is a computed count. Cards are click-to-edit via the
// existing GoalEditDrawer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { Goal } from "@/lib/types";
import { computeGoalPace } from "@/lib/goalPace";
import OrgGoalCard, { type GoalComment } from "./OrgGoalCard";
import GoalEditDrawer, { type DrawerState } from "./GoalEditDrawer";

export default function HomeGoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [comments, setComments] = useState<Record<string, GoalComment>>({});
  const [drawer, setDrawer] = useState<DrawerState>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("scope", "org")
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true });
    const rows = (data ?? []) as Goal[];
    setGoals(rows);

    // Latest comment per goal for the note row (newest first → first wins).
    const ids = rows.map((g) => g.id);
    if (ids.length > 0) {
      const { data: cRows } = await supabase
        .from("goal_comments")
        .select("goal_id,body,author,author_email,created_at")
        .in("goal_id", ids)
        .order("created_at", { ascending: false });
      const latest: Record<string, GoalComment> = {};
      for (const c of (cRows ?? []) as GoalComment[]) {
        if (!latest[c.goal_id]) latest[c.goal_id] = c;
      }
      setComments(latest);
    } else {
      setComments({});
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Subtitle: "{N} goals · {M} off pace" (off pace = behind or risk).
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
            comment={comments[g.id] ?? null}
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
