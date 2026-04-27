"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import FinanceImportView from "@/components/FinanceImportView";

export default function FinanceImportPage() {
  return (
    <PagePermissionGuard page="finance">
      <FinanceImportView />
    </PagePermissionGuard>
  );
}
