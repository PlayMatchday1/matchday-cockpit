"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import ManagerPayGrid from "@/components/ManagerPayGrid";

export default function FinanceManagerPayPage() {
  return (
    <PagePermissionGuard page="finance">
      <ManagerPayGrid />
    </PagePermissionGuard>
  );
}
