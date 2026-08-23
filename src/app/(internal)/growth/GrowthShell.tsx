"use client";

// THE GROWTH SHELL — the guard and the app's own rail, mounted as Finance, Player Lifecycle, Match
// Ops and /city mount theirs.
//
// IT EXISTS BECAUSE THE MOVE COST SOMETHING. Field Pipeline left /match-ops on 2026-08-23 and lost
// that layout's rail, its 212px content offset and its mobile screen-picker bar; the push that
// moved it asserted the loss rather than hiding it. This restores all three under Growth's own
// permission.
//
// ONE ITEM IS STILL A RAIL. A single entry looks thin, but the alternative is a bare page whose
// chrome changes shape the moment City Launches lands — and the offset and the mobile bar are what
// the board actually lost.
//
// THE GUARD LIVES HERE, NOT ON EACH PAGE, so a new Growth page cannot ship ungated by forgetting a
// wrapper. It is a CLIENT guard and it is chrome: every route under it is refused server-side on
// its own gate. See the Push C report for the one place that is not yet true.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import GrowthRail from "./GrowthRail";

export default function GrowthShell({ children }: { children: React.ReactNode }) {
  return (
    <PagePermissionGuard page="growth">
      <GrowthRail>{children}</GrowthRail>
    </PagePermissionGuard>
  );
}
