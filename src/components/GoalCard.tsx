"use client";

import type { Goal, Status } from "@/lib/types";
import { GROUP_KIND_LABEL, lookupOwner } from "@/lib/org";
import { useOrgDirectory } from "@/lib/useOrgDirectory";
import StatusPill from "./StatusPill";
import CardComments from "./CardComments";

const STRIPE: Record<Status, string> = {
  "Not started": "bg-muted",
  "On track": "bg-mint",
  "In progress": "bg-mint",
  "At risk": "bg-coral",
  Done: "bg-blue-info",
};

const FILL: Record<Status, string> = {
  "Not started": "bg-muted",
  "On track": "bg-gradient-to-b from-mint to-mint-hover",
  "In progress": "bg-gradient-to-b from-mint to-mint-hover",
  "At risk": "bg-gradient-to-b from-coral to-coral-hover",
  Done: "bg-gradient-to-b from-blue-info to-blue-info-hover",
};

export default function GoalCard({
  goal,
  onEdit,
}: {
  goal: Goal;
  onEdit: () => void;
  onChange: () => void;
}) {
  const dir = useOrgDirectory();
  const lookup = lookupOwner(goal.owner, dir);

  return (
    <div className="relative box-border flex flex-col overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 transition-all duration-200 hover:-translate-y-1 hover:shadow-xl hover:shadow-deep-green/20">
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] ${STRIPE[goal.status]}`}
      />
      <button
        type="button"
        onClick={onEdit}
        className="text-left"
        aria-label={`Edit ${goal.title}`}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-bold leading-snug text-deep-green">
            {goal.title}
          </h3>
          <StatusPill status={goal.status} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-sm font-semibold text-deep-green">
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
        <div className="mt-4 flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-mint-soft shadow-[inset_0_1px_2px_rgb(0_51_38_/_0.12)]">
            <div
              className={`h-full rounded-full ${FILL[goal.status]}`}
              style={{ width: `${goal.progress}%` }}
            />
          </div>
          <span className="text-xs font-bold tabular-nums text-deep-green/70">
            {goal.progress}%
          </span>
        </div>
      </button>
      <div className="mt-5 border-t border-cream-line/50 pt-4">
        <CardComments goalId={goal.id} />
      </div>
    </div>
  );
}
