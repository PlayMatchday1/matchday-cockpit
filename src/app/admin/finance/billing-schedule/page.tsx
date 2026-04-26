"use client";

import AdminGuard from "@/components/AdminGuard";
import BillingScheduleView from "@/components/BillingScheduleView";

export default function FinanceBillingSchedulePage() {
  return (
    <AdminGuard>
      <BillingScheduleView />
    </AdminGuard>
  );
}
