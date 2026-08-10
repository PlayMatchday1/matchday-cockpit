"use client";

// Match Ops section shell. ONE rail component (ChatsRail) renders on EVERY Match
// Ops route — mounted once here, position:fixed, full-bleed against the viewport
// left edge and flush under the top nav, running the full remaining viewport
// height. Mounting it here (not inside each console) is what makes the rail's
// bounding box byte-identical across the chat 100dvh shells and the centered
// canvas pages: an inline rail would sit at a different y on each.
//
// Content is nudged right of the rail by the --mo-rail-w custom property (which
// also drives the rail's own width), so collapse animates both in lockstep. The
// centered non-chat canvas and the full-bleed chat consoles are otherwise
// untouched — only offset.
//
// Collapse is owned here: React state persists across Match Ops navigation (this
// layout does not remount between its routes) and localStorage restores it after
// a reload. One key for every route — collapse a rail on Chats and it stays
// collapsed on Master Schedule and after F5.
//
// Below the rail breakpoint the desktop rail is hidden and MatchOpsMobileStrip
// carries navigation; the chat consoles render that strip themselves, so we add
// it here only for the non-chat routes.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/useAuth";
import ChatsRail from "./ChatsRail";
import MatchOpsMobileStrip from "./MatchOpsMobileStrip";
import { visibleSections } from "./sections";

const COLLAPSE_KEY = "matchops:rail-collapsed";

export default function MatchOpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { appUser } = useAuth();
  const pathname = usePathname() ?? "";
  // The full-bleed 100dvh treatment is for the chat CONSOLES only. The
  // /match-ops/match-chats/automation config page is a normal scrolling page and
  // must get the rail offset like every other route, so it is excluded here.
  const isChat =
    (pathname.startsWith("/match-ops/match-chats") ||
      pathname.startsWith("/match-ops/player-chats")) &&
    !pathname.startsWith("/match-ops/match-chats/automation");
  // Gameday Ops carries its OWN in-page screen picker (the "Gameday Ops ▾" title
  // button + bottom sheet), so the shared horizontal tab strip is suppressed there —
  // otherwise the phone would show two navs, and a horizontal nav scroller the
  // redesign exists to kill. Every other non-chat route still gets the strip.
  const isGameday = pathname === "/match-ops/gameday";

  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* private mode */
    }
  }, []);
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* private mode */
      }
      return next;
    });

  const hasRail = visibleSections(appUser).length > 0;
  const railW = collapsed ? "60px" : "212px";

  return (
    <>
      {hasRail && (
        <div
          className="fixed left-0 z-30 hidden lg:block"
          style={{
            top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
            height: "calc(100dvh - env(safe-area-inset-top, 0px) - 4rem)",
            width: railW,
            transition: "width .18s ease-out",
          }}
        >
          <ChatsRail collapsed={collapsed} onToggle={toggle} />
        </div>
      )}
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        className={isChat ? undefined : "lg:pl-[var(--mo-rail-w)]"}
      >
        {/* Non-chat routes get the mobile section strip here; chat consoles
            render their own inside the inbox. */}
        {!isChat && !isGameday && hasRail && <MatchOpsMobileStrip />}
        {children}
      </div>
    </>
  );
}
