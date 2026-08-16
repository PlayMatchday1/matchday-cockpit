"use client";

// THE GROWTH SECTION SHELL — the app's own rail, six flat items, city-manager-style mount.
//
// Growth was ONE SCROLLING PAGE: seven cards with three different time behaviours stacked under a
// single global period bar, which is why that bar needed an "applies to 4 of 7 cards" line and a
// three-dot legend to explain itself. Splitting the sections into routes removes the reason those
// existed — a page either follows the period or says in its own subtitle that it does not.
//
// NOTHING WAS REIMPLEMENTED. Every panel is the existing component, imported and routed. The rail,
// the collapse and the mobile sheet are the SAME components Match Ops and /city use.
//
// The data provider is mounted HERE, not per page: this layout does not remount between /growth/*
// routes, so the two aggregates are fetched once and section switching is instant.

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import ChatsRail from "../match-ops/ChatsRail";
import MatchOpsMobileBar from "../match-ops/MatchOpsMobileBar";
import GrowthDataProvider from "@/components/growth/GrowthDataProvider";
import { GROWTH_SECTIONS } from "./growthSections";

const COLLAPSE_KEY = "growth:rail-collapsed";

export default function GrowthShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
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

  const railW = collapsed ? "60px" : "212px";
  // The city-detail pages (/growth/[city]) are their own thing and predate this split — they are
  // reached from a link, not the rail, so they render without it rather than showing six items
  // none of which is the page you are on.
  const isSection = GROWTH_SECTIONS.some((s) => pathname === s.href || pathname.startsWith(s.href + "/"));

  if (!isSection) return <PagePermissionGuard page="growth">{children}</PagePermissionGuard>;

  return (
    <PagePermissionGuard page="growth">
      <div className="fixed left-0 z-30 hidden lg:block"
        style={{
          top: "calc(env(safe-area-inset-top, 0px) + 4rem)",
          height: "calc(100dvh - env(safe-area-inset-top, 0px) - 4rem)",
          width: railW, transition: "width .18s ease-out",
        }}>
        <ChatsRail collapsed={collapsed} onToggle={toggle} items={GROWTH_SECTIONS} showSwitch={false} label="Growth" />
      </div>
      <div
        style={{ "--mo-rail-w": railW } as React.CSSProperties}
        className="lg:pl-[var(--mo-rail-w)] max-[899px]:w-screen max-[899px]:ml-[calc(50%-50vw)]"
      >
        <MatchOpsMobileBar items={GROWTH_SECTIONS} sheetTitle="Growth" showSwitch={false} />
        <GrowthDataProvider>{children}</GrowthDataProvider>
      </div>
    </PagePermissionGuard>
  );
}
