"use client";

// Mobile section nav for the Match Ops SECTION pages (below the 900px rail
// breakpoint, where the desktop icon rail is hidden). A compact sticky APP BAR —
// the current section's name + ▾ — tapped to open the shared screen picker
// (MatchOpsSectionSheet). This is the same pattern Gameday Ops carries in its own
// header; here it stands in for every other section page.
//
// It replaces the old horizontal pill scroller (still used by the chat consoles,
// which render MatchOpsMobileStrip themselves): eleven destinations is a list you
// read once in a sheet, not a strip you drag sideways through hunting for a
// truncated label.
//
// Container-agnostic: it does NOT break itself out of any padding. The layout
// makes the whole section content column full-bleed on a phone, so this bar just
// fills its container and spans edge to edge for free.

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { visibleSections } from "./sections";
import MatchOpsSectionSheet from "./MatchOpsSectionSheet";

export default function MatchOpsMobileBar() {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  const items = useMemo(() => visibleSections(appUser), [appUser]);
  const current = items.find((s) => pathname === s.href || pathname.startsWith(s.href + "/"));

  return (
    <div className="min-[900px]:hidden">
      {/* sticky app bar — pays var(--sat) so the label clears the iOS status band */}
      <div
        className="sticky top-0 z-[12] flex items-center border-b px-3"
        style={{ background: "#f8faf9", borderColor: "#e6ebe8", paddingTop: "calc(6px + var(--sat))", paddingBottom: "6px", minHeight: "44px" }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${current?.label ?? "Match Ops"} — change screen`}
          data-testid="mo-screen-picker"
          className="flex min-h-[36px] items-center gap-1.5 rounded-md pr-1 text-[17px] font-[760] tracking-[-0.02em]"
          style={{ color: "#12241d" }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#42594e" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span>{current?.label ?? "Match Ops"}</span>
          <span className="text-[12px]" style={{ color: "#5c7168" }} aria-hidden>▾</span>
        </button>
      </div>
      <MatchOpsSectionSheet open={open} onClose={() => setOpen(false)} />
    </div>
  );
}
