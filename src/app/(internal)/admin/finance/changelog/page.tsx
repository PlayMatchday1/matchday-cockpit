"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import ChangeLogView from "@/components/ChangeLogView";

export default function FinanceChangeLogPage() {
  return (
    <PagePermissionGuard page="finance">
      <ChangeLogView />
    </PagePermissionGuard>
  );
}
