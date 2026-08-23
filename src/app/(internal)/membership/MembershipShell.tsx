"use client";

// Membership inside the Player Lifecycle rail.
//
// SAME RAIL, DIFFERENT GUARD. LifecycleRail is the identical chrome /lifecycle/* renders, so clicking
// Membership does not change the shape of the page. What is NOT shared is the permission: this
// route is gated on `membership`, which was split out of the old Cities gate on 2026-08-02 and is
// held by people who cannot open the six reports. Mounting LifecycleShell here would have silently
// re-gated the page on `growth`.
//
// AND NO DATA PROVIDER. GrowthDataProvider fetches the two growth aggregates for the reports; this
// page reads members and does not touch them. Wrapping it would add a load to every visit for
// numbers nothing on screen shows.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import LifecycleRail from "../lifecycle/LifecycleRail";

export default function MembershipShell({ children }: { children: React.ReactNode }) {
  return (
    <PagePermissionGuard page="membership">
      <LifecycleRail>{children}</LifecycleRail>
    </PagePermissionGuard>
  );
}
