"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import RevenueAdminView from "@/components/RevenueAdminView";

export default function FinanceRevenuePage() {
  return (
    <PagePermissionGuard page="finance">
      <RevenueAdminView />
    </PagePermissionGuard>
  );
}
