// Goal pace + status, DERIVED (never stored). A goal's status chip is computed
// from how its percent-complete compares to where linear pace says it should be
// today. Linear pace only — no milestone override (out of scope this round).
//
// Dates are handled as YYYY-MM-DD strings and differenced via Date.UTC on the
// explicit y/m/d parts, so there is no timezone drift (both endpoints are
// constructed the same way; only their difference is used). "Today" is the
// current calendar date in BUSINESS_TZ (America/Chicago).

import { BUSINESS_TZ } from "@/lib/businessHours";

// YYYY-MM-DD → integer day number (UTC epoch days). Only used for differences.
function epochDays(dateYmd: string): number {
  const [y, m, d] = dateYmd.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

// The calendar date in America/Chicago as YYYY-MM-DD (en-CA formats that way).
export function todayBusinessDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// A stored timestamptz (created_at) → its calendar date in America/Chicago.
// Used for the declared `coalesce(start_date, created_at::date)` fallback.
export function businessDateOf(timestamp: string): string {
  return todayBusinessDate(new Date(timestamp));
}

export type GoalStatusKey = "ahead" | "pace" | "behind" | "risk";

export type GoalPace = {
  hasTarget: boolean;
  pace: number | null; // % of the way to the deadline that today represents
  status: { key: GoalStatusKey; icon: string; label: string } | null;
  delta: string | null; // "+17 pts ahead" / "on pace" / "17 pts behind"
  startUsed: string; // the start date actually used (for reporting)
};

const clamp = (lo: number, hi: number, n: number) => Math.min(hi, Math.max(lo, n));

// statusOf / deltaLabel mirror public/mockups/home-goals-v3.html verbatim.
function statusOf(d: number): { key: GoalStatusKey; icon: string; label: string } {
  if (d >= 5) return { key: "ahead", icon: "▲", label: "Ahead of pace" };
  if (d >= -5) return { key: "pace", icon: "●", label: "On pace" };
  if (d >= -15) return { key: "behind", icon: "▼", label: "Behind pace" };
  return { key: "risk", icon: "▼", label: "At risk" };
}
function deltaLabel(d: number): string {
  const r = Math.round(d);
  if (r >= 5) return `+${r} pts ahead`;
  if (r >= -5) return "on pace";
  return `${Math.abs(r)} pts behind`;
}

export function computeGoalPace(input: {
  progress: number; // 0–100
  startDate: string | null; // goals.start_date (may be null)
  createdAt: string; // goals.created_at (timestamptz) — the declared fallback
  targetDate: string | null; // goals.target_date
  today?: string; // YYYY-MM-DD; defaults to today in BUSINESS_TZ
}): GoalPace {
  const startUsed = input.startDate ?? businessDateOf(input.createdAt);
  if (!input.targetDate) {
    // No deadline → no pace, no status chip. The card shows "no target date".
    return { hasTarget: false, pace: null, status: null, delta: null, startUsed };
  }
  const today = input.today ?? todayBusinessDate();
  const s = epochDays(startUsed);
  const t = epochDays(input.targetDate);
  const n = epochDays(today);
  const pace =
    t <= s ? (n >= t ? 100 : 0) : clamp(0, 100, (100 * (n - s)) / (t - s));
  const d = input.progress - pace;
  return {
    hasTarget: true,
    pace,
    status: statusOf(d),
    delta: deltaLabel(d),
    startUsed,
  };
}
