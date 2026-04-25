"use client";

import { useEffect, useMemo } from "react";
import type { Goal, Status } from "@/lib/types";
import { formatGoalDate, isTargetPastDue } from "@/lib/goals";
import { formatActivityDate, getGoalActivity } from "@/lib/goalActivity";
import { GROUP_KIND_LABEL, lookupOwner } from "@/lib/org";
import { useOrgDirectory } from "@/lib/useOrgDirectory";
import { useGoalComments } from "@/lib/useGoalComments";
import StatusPill from "./StatusPill";
import CardComments from "./CardComments";

const FILL: Record<Status, string> = {
  "Not started": "bg-muted",
  "On track": "bg-gradient-to-b from-mint to-mint-hover",
  "In progress": "bg-gradient-to-b from-mint to-mint-hover",
  "At risk": "bg-gradient-to-b from-coral to-coral-hover",
  Done: "bg-gradient-to-b from-blue-info to-blue-info-hover",
};

export default function GoalFocusZone({
  goal,
  onClose,
  onEdit,
}: {
  goal: Goal;
  onClose: () => void;
  onEdit: () => void;
}) {
  const dir = useOrgDirectory();
  const lookup = lookupOwner(goal.owner, dir);

  const { comments } = useGoalComments();
  const activity = useMemo(
    () => getGoalActivity(goal, comments),
    [goal, comments],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="focus-slide-in mb-6 rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-lg shadow-deep-green/15 md:p-7">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-2xl font-bold leading-snug tracking-tight text-deep-green md:text-3xl">
            {goal.title}
          </h3>
          {activity.isActive && (
            <span className="mt-2 inline-flex rounded-full bg-mint px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green">
              Active this week
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill status={goal.status} />
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-deep-green/40 transition hover:bg-cream-line hover:text-deep-green"
            aria-label="Close"
          >
            <svg
              className="h-5 w-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CardComments goalId={goal.id} />
        </div>
        <aside className="space-y-5 lg:border-l lg:border-cream-line/60 lg:pl-6">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              Owner
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-base font-semibold text-deep-green">
                {goal.owner || (
                  <span className="italic text-deep-green/40">Unassigned</span>
                )}
              </span>
              {lookup.kind === "person" && lookup.person.title && (
                <span className="text-xs text-deep-green/55">
                  {lookup.person.title}
                </span>
              )}
              {lookup.kind === "group" && (
                <span className="inline-flex rounded-full bg-cream-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/60 ring-1 ring-inset ring-cream-line">
                  {GROUP_KIND_LABEL[lookup.group.kind]}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-1 text-xs text-deep-green/60">
            <div>
              <span className="text-deep-green/45">Created · </span>
              {formatGoalDate(goal.created_at)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {goal.target_date ? (
                <>
                  <span>
                    <span className="text-deep-green/45">Target · </span>
                    {formatGoalDate(goal.target_date)}
                  </span>
                  {isTargetPastDue(goal.target_date) &&
                    goal.status !== "Done" && (
                      <span className="inline-flex rounded-full bg-coral-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-coral ring-1 ring-inset ring-coral/40">
                        Past due
                      </span>
                    )}
                </>
              ) : (
                <span className="italic text-deep-green/40">
                  No target date
                </span>
              )}
            </div>
            {activity.lastCommentAt && (
              <div>
                <span className="text-deep-green/45">Last comment · </span>
                {formatActivityDate(activity.lastCommentAt)}
              </div>
            )}
            {activity.lastProgressChangeAt && (
              <div>
                <span className="text-deep-green/45">Last progress · </span>
                {formatActivityDate(activity.lastProgressChangeAt)}
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
              Progress
            </div>
            <div className="mt-2 flex items-center gap-3">
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-mint-soft shadow-[inset_0_1px_2px_rgb(0_51_38_/_0.12)]">
                <div
                  className={`h-full rounded-full ${FILL[goal.status]}`}
                  style={{ width: `${goal.progress}%` }}
                />
              </div>
              <span className="text-sm font-bold tabular-nums text-deep-green">
                {goal.progress}%
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onEdit}
            className="w-full rounded-full bg-mint px-4 py-2 text-sm font-semibold text-deep-green transition hover:bg-mint-hover"
          >
            Edit goal
          </button>
        </aside>
      </div>
    </div>
  );
}
