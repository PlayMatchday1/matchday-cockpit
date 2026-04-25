import type { Goal, GoalComment } from "./types";

export type GoalActivity = {
  lastCommentAt: Date | null;
  lastProgressChangeAt: Date | null;
  isActive: boolean;
  isStale: boolean;
};

const DAY_MS = 86_400_000;

function maxDate(...dates: (Date | null)[]): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!max || d.getTime() > max.getTime()) max = d;
  }
  return max;
}

export function getGoalActivity(
  goal: Goal,
  comments: GoalComment[],
  now: Date = new Date(),
): GoalActivity {
  let lastCommentMs = -Infinity;
  for (const c of comments) {
    if (c.goal_id !== goal.id) continue;
    const t = new Date(c.created_at).getTime();
    if (t > lastCommentMs) lastCommentMs = t;
  }
  const lastCommentAt =
    lastCommentMs > -Infinity ? new Date(lastCommentMs) : null;

  const lastProgressChangeAt = goal.last_progress_change_at
    ? new Date(goal.last_progress_change_at)
    : null;
  const createdAt = new Date(goal.created_at);

  const mostRecent = maxDate(lastCommentAt, lastProgressChangeAt, createdAt);

  let isActive = false;
  let isStale = false;
  if (mostRecent) {
    const ageMs = now.getTime() - mostRecent.getTime();
    isActive = ageMs <= 7 * DAY_MS;
    isStale = ageMs >= 14 * DAY_MS;
  }

  return { lastCommentAt, lastProgressChangeAt, isActive, isStale };
}

export function formatActivityDate(d: Date, now: Date = new Date()): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - that.getTime()) / DAY_MS);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays <= 6) return `${diffDays} days ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
