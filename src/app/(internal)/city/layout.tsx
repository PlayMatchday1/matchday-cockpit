"use client";

// THE CITY-MANAGER SHELL. Same chrome as the rest of the app: the fixed left rail on desktop, the
// sticky app bar + screen sheet on a phone, content offset by the rail's width. It mounts the SAME
// components Match Ops mounts (ChatsRail, MatchOpsMobileBar) with a different list — see
// citySections. There is no second rail implementation, and there must not be one.
//
// WHAT IS DELIBERATELY ABSENT:
//   • The Daily Ops / Back Office switch — one section, so a switch over halves is a control that
//     looks live and goes nowhere. showSwitch={false}, not CSS.
//   • CrmConversationProvider and the docked chat. Those are the Match Ops chat layer; this tier
//     holds no chats grant and every CRM route refuses it. Mounting the provider here would open a
//     realtime channel for data the account cannot read.
//   • Rail collapse persistence is shared with Match Ops on purpose? NO — it is its own key. An
//     account that only ever sees this rail should not have its preference decided by a section it
//     cannot open, and the two lists are different lengths.
//
// The rail is mounted HERE rather than inside each page for the same reason Match Ops does it:
// mounting it in the layout keeps its bounding box identical across the three routes instead of
// re-rendering at a different y per page.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import ChatsRail from "../match-ops/ChatsRail";
import MatchOpsMobileBar from "../match-ops/MatchOpsMobileBar";
import { CITY_SECTIONS } from "./citySections";

const COLLAPSE_KEY = "city:rail-collapsed";

export default function CityLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  // Gameday Ops carries its OWN app bar (the board wraps the shared bar in its header so the
  // refresh control and freshness stamp sit in the same 44px band). Rendering the layout's bar
  // there too would stack two navs on a phone — the exact thing Match Ops suppresses for the same
  // route, for the same reason.
  const ownsBar = pathname.startsWith("/city/gameday");
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

  const railW = collapsed ? "60px" : "212px";

  return (
    <>
      <div
        className="fixed left-0 z-30 hidden lg:block"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
          height: "calc(100dvh - env(safe-area-inset-top, 0px) - 4rem)",
          width: railW,
          transition: "width .18s ease-out",
        }}
      >
        <ChatsRail collapsed={collapsed} onToggle={toggle} items={CITY_SECTIONS} showSwitch={false} label="City" />
      </div>
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        // Full-bleed on a phone, rail-offset on desktop — the same treatment the Match Ops section
        // pages get, so the two do not sit at different insets.
        className="lg:pl-[var(--mo-rail-w)] max-[899px]:w-screen max-[899px]:ml-[calc(50%-50vw)]"
      >
        {!ownsBar && <MatchOpsMobileBar items={CITY_SECTIONS} sheetTitle="City" showSwitch={false} />}
        {children}
      </div>
    </>
  );
}
