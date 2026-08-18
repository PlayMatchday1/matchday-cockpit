"use client";

// THE PLAYER LIFECYCLE RAIL CHROME — the fixed desktop rail, the mobile bar, and the content
// offset, in ONE place.
//
// WHY IT IS EXTRACTED. This rail now mounts on two routes that are not nested: /growth/* under
// GrowthShell, and /membership under MembershipShell. Those two must render the SAME rail — same
// items, same width, same collapse key — or the section visibly changes shape when you click
// Membership. Two copies of this markup would be two things to keep in step, and the collapse
// state would be the first to drift.
//
// WHAT STAYS OUT OF HERE. The permission guard and the data provider: they are exactly what the
// two shells do NOT share. /growth guards on `growth` and mounts GrowthDataProvider; /membership
// guards on `membership` and mounts nothing — it must not pull the growth aggregates to render a
// members table that does not read them.

import { useEffect, useState } from "react";
import ChatsRail from "../match-ops/ChatsRail";
import MatchOpsMobileBar from "../match-ops/MatchOpsMobileBar";
import { canAccess, useAuth } from "@/lib/useAuth";
import { GROWTH_SECTIONS, SECTION_PAGE } from "./growthSections";

// SHARED WITH /growth ON PURPOSE. Collapsing the rail on a report and clicking through to
// Membership must not un-collapse it — it is one rail, so it is one key.
const COLLAPSE_KEY = "growth:rail-collapsed";

const LABEL = "Player Lifecycle";

export default function LifecycleRail({ children }: { children: React.ReactNode }) {
  const { appUser } = useAuth();
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

  // A link the user cannot open is not navigation. The six reports and Membership are separate
  // permissions, so each item is shown only to someone its guard would let through.
  const items = GROWTH_SECTIONS.filter((it) => canAccess(appUser, SECTION_PAGE[it.key] ?? "growth"));

  const railW = collapsed ? "60px" : "212px";

  return (
    <>
      <div className="fixed left-0 z-30 hidden lg:block"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
          height: "calc(100dvh - env(safe-area-inset-top, 0px) - 4rem)",
          width: railW, transition: "width .18s ease-out",
        }}>
        <ChatsRail collapsed={collapsed} onToggle={toggle} items={items} showSwitch={false} label={LABEL} />
      </div>
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        className="lg:pl-[var(--mo-rail-w)] max-[899px]:w-screen max-[899px]:ml-[calc(50%-50vw)]"
      >
        <MatchOpsMobileBar items={items} sheetTitle={LABEL} showSwitch={false} />
        {children}
      </div>
    </>
  );
}
