"use client";

// THE PLAYER LIFECYCLE SHELL for /growth/* — the app's own rail, mounted as Finance, Match Ops and
// /city mount theirs.
//
// Growth was ONE SCROLLING PAGE: seven cards with three different time behaviours stacked under a
// single global period bar, which is why that bar needed an "applies to 4 of 7 cards" line and a
// three-dot legend to explain itself. Splitting the sections into routes removes the reason those
// existed — a page either follows the period or says in its own subtitle that it does not.
//
// NOTHING WAS REIMPLEMENTED. Every panel is the existing component, imported and routed. The rail,
// the collapse and the mobile sheet are the SAME components Match Ops and /city use.
//
// THE SECTION IS NAMED "Player Lifecycle" NOW; the route, this file and every symbol still say
// growth. That is deliberate: renaming the path would 308 every bookmark to buy a tidier URL.
//
// THE RAIL CHROME LIVES IN LifecycleRail — /membership mounts the same rail under its own
// permission, and the two must not drift.
//
// The data provider is mounted HERE, not per page: this layout does not remount between /growth/*
// routes, so the two aggregates are fetched once and section switching is instant. It stays out of
// LifecycleRail because /membership does not read those aggregates.

import { usePathname } from "next/navigation";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import GrowthDataProvider from "@/components/growth/GrowthDataProvider";
import LifecycleRail from "./LifecycleRail";
import { GROWTH_SECTIONS } from "./growthSections";

export default function GrowthShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  // The city-detail pages (/growth/[city]) are their own thing and predate this split — they are
  // reached from a link, not the rail, so they render without it rather than showing a list none
  // of which is the page you are on.
  const isSection = GROWTH_SECTIONS.some((s) => pathname === s.href || pathname.startsWith(s.href + "/"));

  if (!isSection) return <PagePermissionGuard page="growth">{children}</PagePermissionGuard>;

  return (
    <PagePermissionGuard page="growth">
      <LifecycleRail>
        <GrowthDataProvider>{children}</GrowthDataProvider>
      </LifecycleRail>
    </PagePermissionGuard>
  );
}
