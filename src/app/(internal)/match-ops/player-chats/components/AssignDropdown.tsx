"use client";

// Operator-assignment dropdown rendered in the conversation header.
// Lifted from the original CrmClient (PR #24) without behavior
// changes — just hoisted into its own file so the new conversation
// header reads cleanly. The list is populated by /api/crm/operators
// (admin-only app_users); selecting an item PATCHes the thread's
// assigned_to_user_id; "Unassign" sets it null.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Assignee } from "@/components/AssigneeChip";

export default function AssignDropdown({
  current,
  operators,
  onAssign,
  trigger,
}: {
  current: Assignee | null;
  operators: Assignee[];
  onAssign: (userId: string | null) => void;
  // Render-prop for the trigger so the conversation header can use
  // whatever visual treatment fits (chip, pill, icon-only). Receives
  // open state so the trigger can show the caret direction.
  trigger: (args: { open: boolean }) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex"
      >
        {trigger({ open })}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-cream-line bg-white py-1 text-deep-green shadow-lg shadow-deep-green/20"
        >
          {operators.length === 0 && (
            <div className="px-3 py-1.5 text-xs text-deep-green/50">
              No operators loaded.
            </div>
          )}
          {operators.map((op) => {
            const active = current?.id === op.id;
            return (
              <button
                key={op.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onAssign(op.id);
                }}
                className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition hover:bg-cream-soft ${
                  active ? "bg-mint-soft font-bold" : ""
                }`}
              >
                <span className="truncate">
                  {op.full_name?.trim() || op.email}
                </span>
                {active && (
                  <span aria-hidden className="ml-2 text-xs text-mint-hover">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
          {operators.length > 0 && (
            <div aria-hidden className="my-1 h-px bg-cream-line" />
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAssign(null);
            }}
            disabled={current == null}
            className="block w-full px-3 py-1.5 text-left text-sm text-deep-green/75 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-40"
          >
            Unassign
          </button>
        </div>
      )}
    </div>
  );
}
