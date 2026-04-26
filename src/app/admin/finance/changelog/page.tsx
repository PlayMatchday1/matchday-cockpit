"use client";

import AdminGuard from "@/components/AdminGuard";
import ChangeLogView from "@/components/ChangeLogView";

export default function FinanceChangeLogPage() {
  return (
    <AdminGuard>
      <ChangeLogView />
    </AdminGuard>
  );
}
