"use client";

import AdminGuard from "@/components/AdminGuard";
import FieldCostsView from "@/components/FieldCostsView";

export default function FinanceFieldCostsPage() {
  return (
    <AdminGuard>
      <FieldCostsView />
    </AdminGuard>
  );
}
