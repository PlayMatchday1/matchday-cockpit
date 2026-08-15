"use client";

// Mobile section nav for the Match Ops SECTION pages (below the 900px rail
// breakpoint, where the desktop icon rail is hidden). A compact sticky APP BAR —
// the current section's name + ▾ — tapped to open the shared screen picker
// (MatchOpsSectionSheet). This is the same pattern Gameday Ops carries in its own
// header; here it stands in for every other section page.
//
// It replaced the old horizontal pill scroller (MatchOpsMobileStrip, now deleted —
// the chat consoles render THIS): eleven destinations is a list you read once in a
// sheet, not a strip you drag sideways through hunting for a truncated label.
//
// Container-agnostic: it does NOT break itself out of any padding. The layout
// makes the whole section content column full-bleed on a phone, so this bar just
// fills its container and spans edge to edge for free.

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import { visibleSections, tabForPath, type RailItem } from "./sections";
import MatchOpsSectionSheet from "./MatchOpsSectionSheet";

// THE ONE Match Ops mobile header. Every page below the rail breakpoint uses THIS — Gameday Ops,
// the chat consoles, and every non-chat section page. Before this there were three: this bar, the
// picker Gameday Ops built into its own header, and the Daily/Back segmented control plus a
// horizontally-scrolling pill rail on Chats that clipped "Player" mid-word with no scroll
// affordance. Two navigation systems on two pages of one section is how they drift; a third copy
// is how it happens again.
//
// `actions` is the page's own right-hand controls (Gameday's refresh + freshness stamp, a chat
// screen's own buttons). The bar owns the title + section sheet and nothing else.
// ONE BAR, TWO CALLERS — see ChatsRail. `items`/`sheetTitle`/`showSwitch` omitted keeps the
// original Match Ops behaviour exactly.
export default function MatchOpsMobileBar({ actions, title, leading, items: itemsProp, sheetTitle, showSwitch = true }: { actions?: React.ReactNode; title?: string; leading?: React.ReactNode; items?: RailItem[]; sheetTitle?: string; showSwitch?: boolean } = {}) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);

  // Phase 24 — only the CURRENT tab's items. The tab is derived from the route; there is no
  // tab state to fall out of sync with where the operator actually is.
  const items: RailItem[] = useMemo(() => itemsProp ?? visibleSections(appUser, tabForPath(pathname)), [itemsProp, appUser, pathname]);
  const current = items.find((s) => pathname === s.href || pathname.startsWith(s.href + "/"));

  return (
    <div className="min-[900px]:hidden" data-testid="mo-mobile-header">
      {/* sticky app bar — pays var(--sat) so the label clears the iOS status band */}
      <div
        className="sticky top-0 z-[12] flex items-center border-b px-3"
        // No vertical padding: `minHeight` already sets the 44px band, and a page whose `actions`
        // carry a proper 44px touch target (Gameday's refresh) would otherwise be padded to 56 —
        // three stacked bands is a budget, and this one spent 12px on nothing.
        style={{ background: "#f8faf9", borderColor: "#e6ebe8", paddingTop: "var(--sat)", minHeight: "44px" }}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${title ?? current?.label ?? "Match Ops"} — change screen`}
          data-testid="mo-screen-picker"
          className="flex min-h-[36px] items-center gap-1.5 rounded-md pr-1 text-[17px] font-[760] tracking-[-0.02em]"
          style={{ color: "#12241d" }}
        >
          {/* `leading` is for a page's own status mark (Gameday's PRODUCTION dot). It sits before
              the title, which is where the pattern puts it: "● Gameday Ops ▾". */}
          {leading}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#42594e" strokeWidth={2.2} strokeLinecap="round" aria-hidden>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          <span>{title ?? current?.label ?? "Match Ops"}</span>
          <span className="text-[12px]" style={{ color: "#5c7168" }} aria-hidden>▾</span>
        </button>
        {actions && <span className="ml-auto flex items-center gap-1.5" data-testid="mo-header-actions">{actions}</span>}
      </div>
      <MatchOpsSectionSheet open={open} onClose={() => setOpen(false)} items={itemsProp} title={sheetTitle} showSwitch={showSwitch} />
    </div>
  );
}
