"use client";

// Org goal card — rebuilt to match public/mockups/home-goals-v3.html. Status is
// DERIVED from pace (never stored): a colored left rail + an icon+label chip.
// goals store a percent only, so the number reads "N%" + "complete" with a
// delta badge; a labeled 2px pace tick sits on the track. No sparkline (no
// history table). A goal with no target_date shows no chip and no tick — just
// "no target date" where the chip would be. Palette taken verbatim from the
// mockup.

import type { Goal } from "@/lib/types";
import { computeGoalPace, type GoalStatusKey } from "@/lib/goalPace";

const C: Record<
  GoalStatusKey,
  { rail: string; chipBg: string; chipText: string; chipBorder: string; fill: string }
> = {
  ahead: {
    rail: "#35c77f",
    chipBg: "#e0f2e7",
    chipText: "#0f6b42",
    chipBorder: "#bfe6d0",
    fill: "linear-gradient(90deg,#5fd79a,#35c77f)",
  },
  pace: {
    rail: "#8fa79b",
    chipBg: "#eef1ef",
    chipText: "#455a51",
    chipBorder: "#dde3e0",
    fill: "linear-gradient(90deg,#a3b3ac,#7f8f88)",
  },
  behind: {
    rail: "#d9a326",
    chipBg: "#fdf1d0",
    chipText: "#8a6300",
    chipBorder: "#e3c369",
    fill: "linear-gradient(90deg,#e8c163,#d9a326)",
  },
  risk: {
    rail: "#e2502b",
    chipBg: "#fdeae4",
    chipText: "#a8351a",
    chipBorder: "#f2c3b5",
    fill: "linear-gradient(90deg,#ef8163,#e2502b)",
  },
};

export default function OrgGoalCard({
  goal,
  onEdit,
}: {
  goal: Goal;
  onEdit: (g: Goal) => void;
}) {
  const p = computeGoalPace({
    progress: goal.progress,
    startDate: goal.start_date,
    createdAt: goal.created_at,
    targetDate: goal.target_date,
  });
  const c = p.status ? C[p.status.key] : null;
  const railColor = c?.rail ?? "#c3ccc7";
  const fill = c?.fill ?? "linear-gradient(90deg,#c9d2cd,#aeb8b3)";

  return (
    <button
      type="button"
      onClick={() => onEdit(goal)}
      className="group relative block w-full overflow-hidden rounded-[14px] border text-left transition"
      style={{
        background: "#fffdf7",
        borderColor: "#efe9dc",
        padding: "18px 20px 16px",
        boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
      }}
    >
      {/* Left status rail */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: railColor, opacity: 0.9 }}
      />

      {/* Header: name + owner, chip on the right */}
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0">
          <div className="text-[15.5px] font-bold leading-tight tracking-[-0.011em] text-[#12241d]">
            {goal.title}
          </div>
          {goal.owner && (
            <div className="mt-[3px] text-[11.5px] text-[#6d7b74]">{goal.owner}</div>
          )}
        </div>
        {p.status && c ? (
          <span
            className="ml-auto inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-full border px-[10px] py-[5px] text-[11px] font-bold tracking-[0.02em]"
            style={{ background: c.chipBg, color: c.chipText, borderColor: c.chipBorder }}
          >
            <span className="text-[9px] leading-none">{p.status.icon}</span>
            {p.status.label}
          </span>
        ) : (
          <span className="ml-auto shrink-0 whitespace-nowrap rounded-full border border-[#e4ddcc] bg-[#f7f4ec] px-[10px] py-[5px] text-[11px] font-semibold text-[#9aa5a0]">
            no target date
          </span>
        )}
      </div>

      {/* Number + delta */}
      <div className="mb-[15px] flex items-end gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-[38px] font-bold leading-[0.94] tracking-[-0.032em] tabular-nums text-[#12241d]">
            {goal.progress}%
          </span>
          <span className="text-[11.5px] text-[#6d7b74]">complete</span>
        </div>
        {p.delta && c && (
          <span
            className="ml-auto self-center whitespace-nowrap rounded-md px-2 py-[3px] text-[11px] font-bold"
            style={{ background: c.chipBg, color: c.chipText }}
          >
            {p.delta}
          </span>
        )}
      </div>

      {/* Track with labeled pace tick */}
      <div className="relative mb-[11px] pb-[19px]">
        <div className="relative h-[9px] rounded-full" style={{ background: "#e8e2d4" }}>
          <div
            className="absolute left-0 top-0 h-[9px] rounded-full"
            style={{ width: `${Math.min(100, goal.progress)}%`, background: fill }}
          />
          {p.pace != null && (
            <>
              <span
                aria-hidden
                className="absolute top-[-5px] w-[2px] rounded-[1px]"
                style={{
                  left: `${p.pace}%`,
                  height: "19px",
                  background: "#12241d",
                  boxShadow: "0 0 0 2px #fffdf7",
                }}
              />
              <span
                className="absolute top-[15px] -translate-x-1/2 whitespace-nowrap text-[10px] font-[650] uppercase tracking-[0.05em] text-[#5b6b64]"
                style={{ left: `${p.pace}%` }}
              >
                {Math.round(p.pace)}% expected today
              </span>
            </>
          )}
        </div>
      </div>

      {/* Read row */}
      <div className="flex justify-between gap-3 pt-[2px] text-[12px] text-[#6d7b74]">
        <span>
          <b className="font-bold text-[#12241d]">{goal.progress}%</b> complete
        </span>
        {goal.target_date && <span>Target {goal.target_date}</span>}
      </div>
    </button>
  );
}
