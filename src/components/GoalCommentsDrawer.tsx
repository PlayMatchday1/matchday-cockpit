"use client";

// Comment thread + composer for a goal, in the same drawer shell as
// GoalEditDrawer. Reuses CardComments wholesale (the existing thread renderer +
// composer): CardComments renders the thread via CommentBody (DOMPurify rich
// text) and posts one goal_comments row — no second comment system, no second
// dangerouslySetInnerHTML, and it never touches goals.progress/status/history.

import type { Goal } from "@/lib/types";
import CardComments from "./CardComments";

export default function GoalCommentsDrawer({
  goal,
  onClose,
}: {
  goal: Goal | null;
  onClose: () => void;
}) {
  const open = goal != null;
  return (
    <div
      className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-deep-green/40 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <div
        className={`absolute inset-y-0 right-0 flex w-full max-w-[420px] flex-col bg-cream shadow-2xl transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={goal ? `Updates for ${goal.title}` : undefined}
      >
        {goal && (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-cream-line bg-white px-5 py-4">
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-deep-green/55">
                  Updates
                </div>
                <h2 className="mt-0.5 truncate text-base font-black tracking-tight text-deep-green">
                  {goal.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="shrink-0 rounded-full p-1.5 text-2xl leading-none text-deep-green/50 hover:bg-cream-soft hover:text-deep-green"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-5">
              <CardComments goalId={goal.id} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
