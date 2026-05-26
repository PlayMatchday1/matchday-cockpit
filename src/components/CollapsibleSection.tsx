"use client";

// Shared collapsible card used by the Slate Review tab and the
// shared Finance Actions section. Default open. Local open/closed
// state per instance — no persistence (operator collapses for focus
// on a single section, not for long-term layout).

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

export default function CollapsibleSection({
  title,
  defaultOpen = true,
  rightSlot,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  // Optional content rendered on the right side of the header
  // (e.g. a count badge). Stops click propagation so interactive
  // elements there don't toggle the section.
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white shadow-md shadow-deep-green/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-5 py-3 text-left transition hover:bg-cream-soft/40"
      >
        {open ? (
          <ChevronDown size={18} aria-hidden className="text-deep-green/55" />
        ) : (
          <ChevronRight size={18} aria-hidden className="text-deep-green/55" />
        )}
        <span className="text-lg font-bold tracking-tight text-deep-green">
          {title}
        </span>
        {rightSlot && (
          <span
            className="ml-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {rightSlot}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-cream-line/60 p-5">{children}</div>
      )}
    </section>
  );
}
