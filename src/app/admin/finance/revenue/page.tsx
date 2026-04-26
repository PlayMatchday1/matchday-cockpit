"use client";

import AdminGuard from "@/components/AdminGuard";
import RevenueAdminView from "@/components/RevenueAdminView";

export default function FinanceRevenuePage() {
  return (
    <AdminGuard>
      <RevenueAdminView />
    </AdminGuard>
  );
}
