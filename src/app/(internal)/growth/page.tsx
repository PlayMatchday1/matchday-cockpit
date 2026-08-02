"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import GrowthDashboard from "@/components/growth/GrowthDashboard";

// The Growth tab. Formerly a Cities dashboard with Overview / Users /
// Cancellations lenses — those were removed on 2026-08-02 and the tab now hosts
// the growth analytics dashboard (KPIs, funnel, player behavior, ARPP,
// retention cohorts, churn, player data room), all fed by one read-only
// /api/growth call. Access is still gated on the "cities" permission.
export default function GrowthPage() {
  return (
    <PagePermissionGuard page="cities">
      <GrowthDashboard />
    </PagePermissionGuard>
  );
}
