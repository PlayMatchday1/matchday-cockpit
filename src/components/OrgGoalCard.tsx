"use client";

// Org goal card — matches public/mockups/home-goals-v3.html. Status is DERIVED
// from linear pace (never stored): colored left rail + icon+label chip. Percent
// only, so the number reads "N%" + "complete" with the delta badge inline. A
// labeled pace tick sits on the track; the "On pace" grey fill/rail is
// deliberate. No sparkline (no history yet). Every card ends with a .gnote —
// the latest goal_comment, or the "no update" empty state (the empty state is
// the point). Palette + avatar tint/initials taken verbatim from the mockup.

import type { Goal } from "@/lib/types";
import { htmlToPlainText } from "@/lib/text";
import {
  businessDateOf,
  computeGoalPace,
  todayBusinessDate,
  weeksLeftUntil,
  type GoalStatusKey,
} from "@/lib/goalPace";

export type GoalComment = {
  goal_id: string;
  body: string;
  author: string | null;
  author_email: string | null;
  created_at: string;
};

const SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function fmtHuman(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${SHORT[m - 1]} ${d}`;
}

// Deterministic avatar tint + initials — verbatim from the mockup (av/tintOf).
const TINTS = ["#dcefe4", "#f1e6d3", "#e3e7f1", "#f3e2dc", "#dfeaf0", "#e9e5f0", "#e7efdc"];
function tintOf(n: string): string {
  let s = 0;
  for (let i = 0; i < n.length; i++) s = (s * 31 + n.charCodeAt(i)) >>> 0;
  return TINTS[s % TINTS.length];
}
function initials(n: string): string {
  return n
    .split(/\s+/)
    .map((x) => x.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const C: Record<
  GoalStatusKey,
  { rail: string; chipBg: string; chipText: string; chipBorder: string; fill: string }
> = {
  ahead: { rail: "#35c77f", chipBg: "#e0f2e7", chipText: "#0f6b42", chipBorder: "#bfe6d0", fill: "linear-gradient(90deg,#5fd79a,#35c77f)" },
  pace: { rail: "#8fa79b", chipBg: "#eef1ef", chipText: "#455a51", chipBorder: "#dde3e0", fill: "linear-gradient(90deg,#a3b3ac,#7f8f88)" },
  behind: { rail: "#d9a326", chipBg: "#fdf1d0", chipText: "#8a6300", chipBorder: "#e3c369", fill: "linear-gradient(90deg,#e8c163,#d9a326)" },
  risk: { rail: "#e2502b", chipBg: "#fdeae4", chipText: "#a8351a", chipBorder: "#f2c3b5", fill: "linear-gradient(90deg,#ef8163,#e2502b)" },
};

export default function OrgGoalCard({
  goal,
  comment,
  onEdit,
}: {
  goal: Goal;
  comment: GoalComment | null;
  onEdit: (g: Goal) => void;
}) {
  const today = todayBusinessDate();
  const p = computeGoalPace({
    progress: goal.progress,
    startDate: goal.start_date,
    createdAt: goal.created_at,
    targetDate: goal.target_date,
    today,
  });
  const c = p.status ? C[p.status.key] : null;
  const railColor = c?.rail ?? "#c3ccc7";
  const fill = c?.fill ?? "linear-gradient(90deg,#c9d2cd,#aeb8b3)";

  // Meta line: owner · target Mon D · N weeks left  (owner alone if no target).
  const metaBits: string[] = [];
  if (goal.owner) metaBits.push(goal.owner);
  if (goal.target_date) {
    metaBits.push(`target ${fmtHuman(goal.target_date)}`);
    const wl = weeksLeftUntil(goal.target_date, today);
    metaBits.push(`${wl} week${wl === 1 ? "" : "s"} left`);
  }

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
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: railColor, opacity: 0.9 }} />

      {/* Header: name + meta line, chip on the right */}
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0">
          <div className="text-[15.5px] font-bold leading-tight tracking-[-0.011em] text-[#12241d]">
            {goal.title}
          </div>
          {metaBits.length > 0 && (
            <div className="mt-[3px] text-[11.5px] text-[#6d7b74]">
              {metaBits.join(" · ")}
            </div>
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

      {/* Number + inline delta (delta sits inside .num, after the number) */}
      <div className="mb-[15px] flex flex-wrap items-baseline gap-2">
        <span className="text-[38px] font-bold leading-[0.94] tracking-[-0.032em] tabular-nums text-[#12241d]">
          {goal.progress}%
        </span>
        <span className="text-[11.5px] text-[#6d7b74]">complete</span>
        {p.delta && c && (
          <span
            className="self-center whitespace-nowrap rounded-md px-2 py-[3px] text-[11px] font-bold"
            style={{ background: c.chipBg, color: c.chipText }}
          >
            {p.delta}
          </span>
        )}
      </div>

      {/* Track with labeled pace tick */}
      <div className="relative mb-[11px] pb-[19px]">
        <div className="relative h-[9px] rounded-full" style={{ background: "#e8e2d4" }}>
          <div className="absolute left-0 top-0 h-[9px] rounded-full" style={{ width: `${Math.min(100, goal.progress)}%`, background: fill }} />
          {p.pace != null && (
            <>
              <span aria-hidden className="absolute top-[-5px] w-[2px] rounded-[1px]" style={{ left: `${p.pace}%`, height: "19px", background: "#12241d", boxShadow: "0 0 0 2px #fffdf7" }} />
              <span className="absolute top-[15px] -translate-x-1/2 whitespace-nowrap text-[10px] font-[650] uppercase tracking-[0.05em] text-[#5b6b64]" style={{ left: `${p.pace}%` }}>
                {Math.round(p.pace)}% expected today
              </span>
            </>
          )}
        </div>
      </div>

      {/* Read row: Started Mon D ........ target Mon D */}
      <div className="flex justify-between gap-3 pt-[2px] text-[12px] text-[#6d7b74]">
        <span>Started {fmtHuman(p.startUsed)}</span>
        {goal.target_date && <span>{fmtHuman(goal.target_date)}</span>}
      </div>

      {/* Note row — latest comment, or the "no update" empty state */}
      <div className="mt-3 border-t border-dashed pt-3 text-[12.5px] leading-[1.55]" style={{ borderColor: "#e4ddcc" }}>
        {comment ? (
          <div style={{ color: "#3f544b" }}>
            {/* Stored body is rich-text HTML; render a plain-text preview
                (no dangerouslySetInnerHTML) clamped to 2 lines. Result goes
                through normal React escaping. */}
            <div className="line-clamp-2">{htmlToPlainText(comment.body)}</div>
            <div className="mt-[6px] flex items-center gap-[6px] text-[11px] text-[#9aa5a0]">
              <Avatar name={comment.author || comment.author_email || "Unknown"} />
              <span>{comment.author || comment.author_email || "Unknown"}</span>
              <span>·</span>
              <span>{fmtHuman(businessDateOf(comment.created_at))}</span>
            </div>
          </div>
        ) : (
          <div className="italic" style={{ color: "#9aa5a0" }}>
            No update since this goal was set
          </div>
        )}
      </div>
    </button>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="inline-flex h-[20px] w-[20px] items-center justify-center rounded-full text-[8px] font-[750]"
      style={{ background: tintOf(name), color: "#2c4a3e", boxShadow: "0 0 0 1.5px #fffdf7" }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}
