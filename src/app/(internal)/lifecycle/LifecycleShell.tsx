"use client";

// THE PLAYER LIFECYCLE SHELL for /lifecycle/* — the app's own rail, mounted as Finance, Match Ops and
// /city mount theirs.
//
// The section was ONE SCROLLING PAGE: seven cards with three different time behaviours stacked under a
// single global period bar, which is why that bar needed an "applies to 4 of 7 cards" line and a
// three-dot legend to explain itself. Splitting the sections into routes removes the reason those
// existed — a page either follows the period or says in its own subtitle that it does not.
//
// NOTHING WAS REIMPLEMENTED. Every panel is the existing component, imported and routed. The rail,
// the collapse and the mobile sheet are the SAME components Match Ops and /city use.
//
// THE ROUTE NOW AGREES WITH THE LABEL. It said /growth for months while the section read "Player
// Lifecycle" on screen, which was survivable until a SECOND thing called growth arrived. The old
// paths are 308'd from next.config.ts, enumerated rather than wildcarded so /growth is free.
//
// THE RAIL CHROME LIVES IN LifecycleRail — /membership mounts the same rail under its own
// permission, and the two must not drift.
//
// The data provider is mounted HERE, not per page: this layout does not remount between /lifecycle/*
// routes, so the two aggregates are fetched once and section switching is instant. It stays out of
// LifecycleRail because /membership does not read those aggregates.

import { usePathname } from "next/navigation";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import GrowthDataProvider from "@/components/growth/GrowthDataProvider";
import LifecycleRail from "./LifecycleRail";
import { LIFECYCLE_SECTIONS } from "./lifecycleSections";

export default function LifecycleShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  // The city-detail pages (/lifecycle/[city]) are their own thing and predate this split — they are
  // reached from a link, not the rail, so they render without it rather than showing a list none
  // of which is the page you are on.
  const isSection = LIFECYCLE_SECTIONS.some((s) => pathname === s.href || pathname.startsWith(s.href + "/"));

  if (!isSection) return <PagePermissionGuard page="lifecycle">{children}</PagePermissionGuard>;

  return (
    <PagePermissionGuard page="lifecycle">
      <LifecycleRail>
        <GrowthDataProvider>{children}</GrowthDataProvider>
      </LifecycleRail>
    </PagePermissionGuard>
  );
}
