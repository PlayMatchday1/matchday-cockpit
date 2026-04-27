"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import BillingScheduleView from "@/components/BillingScheduleView";

export default function FinanceBillingSchedulePage() {
  return (
    <PagePermissionGuard page="finance">
      <BillingScheduleView />
    </PagePermissionGuard>
  );
}
