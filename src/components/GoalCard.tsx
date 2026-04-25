"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import type { Goal, Status } from "@/lib/types";
import { GROUP_KIND_LABEL, lookupOwner } from "@/lib/org";
import { useOrgDirectory } from "@/lib/useOrgDirectory";
import StatusPill from "./StatusPill";

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
  onFocus,
  isFocused,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}: {
  goal: Goal;
  onFocus: () => void;
  isFocused: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const dir = useOrgDirectory();
  const lookup = lookupOwner(goal.owner, dir);

  return (
    <div
      className={`relative box-border flex flex-col overflow-hidden rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10 transition-all duration-200 ${
        isFocused
          ? "ring-2 ring-mint/60"
          : "hover:-translate-y-1 hover:shadow-xl hover:shadow-deep-green/20"
      }`}
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] ${STRIPE[goal.status]}`}
      />

      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onFocus}
          className="min-w-0 flex-1 text-left"
          aria-label={`Open ${goal.title}`}
        >
          <h3 className="text-base font-bold leading-snug text-deep-green transition-colors hover:text-mint-hover">
            {goal.title}
          </h3>
        </button>
        <div className="flex shrink-0 items-start gap-1.5">
          <StatusPill status={goal.status} />
          <div className="flex items-center gap-0.5">
            <IconBtn
              onClick={onMoveUp}
              disabled={!canMoveUp}
              label={`Move ${goal.title} up`}
            >
              <ChevronUp className="h-4 w-4" />
            </IconBtn>
            <IconBtn
              onClick={onMoveDown}
              disabled={!canMoveDown}
              label={`Move ${goal.title} down`}
            >
              <ChevronDown className="h-4 w-4" />
            </IconBtn>
            <IconBtn onClick={onFocus} label={`Open ${goal.title}`}>
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </IconBtn>
          </div>
        </div>
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

      <div className="mt-3 flex items-center gap-3">
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
    </div>
  );
}

function IconBtn({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded p-1 text-deep-green/40 transition hover:bg-cream-line hover:text-deep-green disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-deep-green/40"
    >
      {children}
    </button>
  );
}
