"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import PartnerDashboardsAdmin from "@/components/PartnerDashboardsAdmin";

export default function FinancePartnersPage() {
  return (
    <PagePermissionGuard page="finance">
      <PartnerDashboardsAdmin />
    </PagePermissionGuard>
  );
}
