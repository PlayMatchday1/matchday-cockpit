"use client";

// Org goal card — home-v5 redesign. One ring carries number + progress + pace
// (replacing bar + tick + caption + chips). Colour encodes HEALTH not degree:
// green = ahead/on-pace (on-pace is the GOOD outcome, never grey), amber =
// behind, red = at risk. Trend renders only from >=4 real history rows — never
// synthesized. The note is a clickable door into the comment thread.

import type { Goal } from "@/lib/types";
import { htmlToPlainText } from "@/lib/text";
import { useGoalComments } from "@/lib/useGoalComments";
import {
  businessDateOf,
  computeGoalPace,
  todayBusinessDate,
  weeksLeftUntil,
} from "@/lib/goalPace";

type StatusKey = "ahead" | "pace" | "behind" | "risk";

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtHuman = (ymd: string) => {
  const [, m, d] = ymd.split("-").map(Number);
  return `${SHORT[m - 1]} ${d}`;
};
const TINTS = ["#dcefe4", "#f1e6d3", "#e3e7f1", "#f3e2dc", "#dfeaf0", "#e9e5f0", "#e7efdc"];
const tintOf = (n: string) => {
  let s = 0;
  for (let i = 0; i < n.length; i++) s = (s * 31 + n.charCodeAt(i)) >>> 0;
  return TINTS[s % TINTS.length];
};
const initials = (n: string) =>
  n.split(/\s+/).map((x) => x.charAt(0)).slice(0, 2).join("").toUpperCase();

// pct - pace → health. Green for ahead AND on pace (no grey path).
function statusOf(pct: number, pace: number): { k: StatusKey; label: string } {
  const d = pct - pace;
  if (d >= 5) return { k: "ahead", label: `+${Math.round(d)} pts ahead` };
  if (d >= -5) return { k: "pace", label: "On pace" };
  if (d >= -15) return { k: "behind", label: `${Math.round(-d)} pts behind` };
  return { k: "risk", label: `At risk · ${Math.round(-d)} pts behind` };
}

const R = 39;
const CIRC = 2 * Math.PI * R;

const CARD_CLR: Record<StatusKey, { glow: string }> = {
  ahead: { glow: "radial-gradient(circle,rgba(53,199,127,.20),transparent 68%)" },
  pace: { glow: "radial-gradient(circle,rgba(63,182,129,.16),transparent 68%)" },
  behind: { glow: "radial-gradient(circle,rgba(217,163,38,.17),transparent 68%)" },
  risk: { glow: "radial-gradient(circle,rgba(226,80,43,.15),transparent 68%)" },
};
const GRAD: Record<StatusKey, string> = {
  ahead: "url(#gAhead)",
  pace: "url(#gPace)",
  behind: "url(#gBehind)",
  risk: "url(#gRisk)",
};
const TREND_STROKE: Record<StatusKey, string> = {
  ahead: "#35c77f",
  pace: "#3fb681",
  behind: "#d9a326",
  risk: "#e2502b",
};
const CHIP: Record<StatusKey, { bg: string; fg: string; bd: string }> = {
  ahead: { bg: "#e0f2e7", fg: "#0f6b42", bd: "#c2e7d3" },
  pace: { bg: "#e0f2e7", fg: "#12764a", bd: "#c9e8d8" },
  behind: { bg: "#fdf1d0", fg: "#8a6300", bd: "#e3c369" },
  risk: { bg: "#fdeae4", fg: "#a8351a", bd: "#f2c3b5" },
};

export default function OrgGoalCard({
  goal,
  history,
  onEdit,
  onOpenComments,
}: {
  goal: Goal;
  history: number[]; // real goal_progress_history progress values, chronological
  onEdit: (g: Goal) => void;
  onOpenComments: (g: Goal) => void;
}) {
  const { comments: all } = useGoalComments();
  const mine = all
    .filter((c) => c.goal_id === goal.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = mine.length ? mine[mine.length - 1] : null;
  const count = mine.length;

  const today = todayBusinessDate();
  const p = computeGoalPace({
    progress: goal.progress,
    startDate: goal.start_date,
    createdAt: goal.created_at,
    targetDate: goal.target_date,
    today,
  });
  const hasPace = p.pace != null;
  const pace = p.pace ?? 0;
  const st = hasPace ? statusOf(goal.progress, pace) : null;
  const k: StatusKey = st?.k ?? "pace";

  const meta: string[] = [goal.owner].filter(Boolean) as string[];
  if (goal.target_date) {
    const wl = weeksLeftUntil(goal.target_date, today);
    meta.push(`${fmtHuman(businessDateOf(goal.created_at))} → ${fmtHuman(goal.target_date)}`);
    meta.push(`${wl} week${wl === 1 ? "" : "s"} left`);
  }

  const dash = (Math.max(0, Math.min(100, goal.progress)) / 100) * CIRC;
  const ang = (Math.max(0, Math.min(100, pace)) / 100) * 360;

  return (
    <div
      className="relative overflow-hidden rounded-[16px] border p-[22px] transition hover:-translate-y-[2px]"
      style={{
        background: "linear-gradient(178deg,#fffefc 0%, #fffdf7 62%)",
        borderColor: "#efe9dc",
        boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 18px 40px -26px rgba(7,42,32,.55)",
      }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute right-[-40px] top-[-40px] h-[160px] w-[160px] rounded-full"
        style={{ background: st ? CARD_CLR[k].glow : "transparent" }}
      />

      {/* Top: ring + name/meta/chip */}
      <div className="relative flex items-center gap-[18px]">
        <div className="relative h-[86px] w-[86px] flex-none">
          <svg viewBox="0 0 86 86" width="86" height="86" aria-hidden style={{ transform: "rotate(-90deg)" }}>
            <circle cx="43" cy="43" r={R} fill="none" stroke="#e8e2d4" strokeWidth="8" />
            <circle
              cx="43" cy="43" r={R} fill="none" strokeWidth="8" strokeLinecap="round"
              stroke={GRAD[k]} strokeDasharray={`${dash.toFixed(1)} ${CIRC.toFixed(1)}`}
            />
            {hasPace && (
              <g transform={`rotate(${ang.toFixed(1)} 43 43)`}>
                <line x1="43" y1={43 - R - 5.5} x2="43" y2={43 - R + 5.5} stroke="#22423a" strokeWidth="2.4" strokeLinecap="round" />
              </g>
            )}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-[22px] font-[750] leading-none tracking-[-0.035em] text-[#12241d]">
              {goal.progress}
              <i className="ml-px text-[13px] font-[650] not-italic text-[#8a978f]">%</i>
            </div>
            <div className="text-[8.5px] font-bold uppercase tracking-[0.1em] text-[#a2ada8]">done</div>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onEdit(goal)}
            aria-label={`Edit goal ${goal.title}`}
            className="rounded text-left text-[16px] font-[720] leading-[1.28] tracking-[-0.013em] text-[#12241d] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f]"
          >
            {goal.title}
          </button>
          <div className="mt-[5px] flex flex-wrap items-center gap-[7px] text-[11.5px] text-[#6d7b74]">
            {meta.map((m, i) => (
              <span key={i} className="flex items-center gap-[7px]">
                {i > 0 && <span className="inline-block h-[3px] w-[3px] flex-none rounded-full bg-[#c9d2cd]" />}
                {m}
              </span>
            ))}
          </div>
          <div className="mt-[11px] flex flex-wrap items-center gap-[9px]">
            {st ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border px-[9px] py-[3px] text-[11px] font-bold"
                style={{ background: CHIP[k].bg, color: CHIP[k].fg, borderColor: CHIP[k].bd }}
              >
                {st.label}
              </span>
            ) : (
              <span className="rounded-full border border-[#e4ddcc] bg-[#f7f4ec] px-[9px] py-[3px] text-[11px] font-semibold text-[#9aa5a0]">
                no target date
              </span>
            )}
            {hasPace && (
              <span className="text-[11.5px] text-[#8b978f]">
                <b className="font-[650] text-[#54655d]">{Math.round(pace)}%</b> expected today
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Trend — real history only */}
      <Trend history={history} k={k} />

      {/* Note — the door */}
      <button
        type="button"
        onClick={() => onOpenComments(goal)}
        aria-label={
          latest
            ? `${count} update${count === 1 ? "" : "s"} on ${goal.title}, open thread`
            : `Add the first update on ${goal.title}`
        }
        className={`block w-full rounded-[11px] border px-[14px] py-[11px] text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#35c77f] ${
          latest ? "border-[#e7dfcc] bg-[#faf6ec] hover:bg-[#f4f0e3]" : "border-dashed border-[#d5cbb4] bg-transparent"
        }`}
      >
        <div className="flex items-baseline gap-3">
          <span
            className={`min-w-0 flex-1 line-clamp-2 text-[13px] ${latest ? "font-semibold text-[#2f453c]" : "font-medium text-[#9aa5a0]"}`}
          >
            {latest ? htmlToPlainText(latest.body) : "Add the first update"}
          </span>
          <span className="flex-none text-[11.5px] font-bold text-[#5f7d6f]">
            {latest ? `${count} update${count === 1 ? "" : "s"} ›` : "›"}
          </span>
        </div>
        {latest && (
          <div className="mt-[7px] flex items-center gap-[6px] text-[11px] text-[#98a49e]">
            <Avatar name={latest.author || latest.author_email || "Unknown"} />
            <span>{latest.author || latest.author_email || "Unknown"}</span>
            <span>·</span>
            <span>{fmtHuman(businessDateOf(latest.created_at))}</span>
          </div>
        )}
      </button>
    </div>
  );
}

function Trend({ history, k }: { history: number[]; k: StatusKey }) {
  if (!history || history.length < 4) {
    return (
      <div className="my-[16px] text-[11.5px] italic leading-[1.5] text-[#a8b2ad]">
        No history yet — a trend line appears once this goal has four or more updates.
      </div>
    );
  }
  const w = 210, h = 44, pad = 4;
  const mn = Math.min(...history), mx = Math.max(...history), rng = mx - mn || 1;
  const pts = history.map((v, i) => [
    pad + (i * (w - pad * 2)) / (history.length - 1),
    h - pad - ((v - mn) / rng) * (h - pad * 2),
  ]);
  const d = pts.map((pt, i) => `${i ? "L" : "M"}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(" ");
  const area = `${d} L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`;
  const last = pts[pts.length - 1];
  const c = TREND_STROKE[k];
  return (
    <div className="relative my-[18px]">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="56" style={{ overflow: "visible" }} aria-hidden>
        <path d={area} fill={c} opacity="0.16" />
        <path d={d} fill="none" stroke={c} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="3" fill={c} stroke="#fffdf7" strokeWidth="2" />
      </svg>
      <div className="absolute right-0 top-[-13px] text-[9.5px] uppercase tracking-[0.09em] text-[#a2ada8]">
        last {history.length} updates
      </div>
    </div>
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
