"use client";

// GROWTH'S RAIL CHROME — the fixed desktop rail, the mobile bar, and the content offset, in one
// place, using the SAME components Match Ops and Player Lifecycle use. Nothing here is a rebuild;
// a second copy of this markup would be a second thing to keep in step and the collapse state
// would be the first to drift.

import { useEffect, useState } from "react";
import ChatsRail from "../match-ops/ChatsRail";
import MatchOpsMobileBar from "../match-ops/MatchOpsMobileBar";
import { GROWTH_SECTIONS } from "./growthSections";

// Growth's own key. Collapsing a rail in one section must not collapse another's.
const COLLAPSE_KEY = "growth:rail-collapsed";

const LABEL = "Growth";

export default function GrowthRail({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1"); } catch { /* private mode */ }
  }, []);
  const toggle = () =>
    setCollapsed((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });

  // EVERY ITEM HERE IS GATED ON `growth` AND NOTHING ELSE, so the shell's guard has already decided
  // and there is no per-item filter to get wrong. When a Growth page needs its own permission, it
  // gets filtered here the way LifecycleRail filters Membership — not by hiding it somewhere else.
  const railW = collapsed ? "60px" : "212px";

  return (
    <>
      <div className="fixed left-0 z-30 hidden lg:block"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + var(--nav-h))",
          height: "calc(100dvh - env(safe-area-inset-top, 0px) - var(--nav-h))",
          width: railW, transition: "width .18s ease-out",
        }}>
        <ChatsRail collapsed={collapsed} onToggle={toggle} items={GROWTH_SECTIONS} showSwitch={false} label={LABEL} />
      </div>
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        className="lg:pl-[var(--mo-rail-w)] max-[899px]:w-screen max-[899px]:ml-[calc(50%-50vw)]"
      >
        <MatchOpsMobileBar items={GROWTH_SECTIONS} sheetTitle={LABEL} showSwitch={false} />
        {children}
      </div>
    </>
  );
}
