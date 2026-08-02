"use client";

// Match Ops → Partner Dashboards (moved out of Finance). Viewing requires a
// Clubhouse session; the data API is admin-gated and mutations stay on
// app_users.is_admin (RLS), unchanged. The public tokenised route
// (/partners/<slug>) is separate and needs no login.

import PagePermissionGuard from "@/components/PagePermissionGuard";
import PartnerDashboardsIndex from "./PartnerDashboardsIndex";

export const dynamic = "force-dynamic";

export default function PartnerDashboardsPage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <PartnerDashboardsIndex />
    </PagePermissionGuard>
  );
}
