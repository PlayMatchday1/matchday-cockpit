"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import FieldCostsView from "@/components/FieldCostsView";

export default function FinanceFieldCostsPage() {
  return (
    <PagePermissionGuard page="finance">
      <FieldCostsView />
    </PagePermissionGuard>
  );
}
