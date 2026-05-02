"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import CheckInsView from "@/components/CheckInsView";

export default function CheckInsPage() {
  return (
    <PagePermissionGuard page="finance">
      <CheckInsView />
    </PagePermissionGuard>
  );
}
