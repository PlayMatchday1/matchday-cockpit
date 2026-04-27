"use client";

import PagePermissionGuard from "@/components/PagePermissionGuard";
import ExpenseAdminView from "@/components/ExpenseAdminView";

export default function FinanceExpensesPage() {
  return (
    <PagePermissionGuard page="finance">
      <ExpenseAdminView />
    </PagePermissionGuard>
  );
}
