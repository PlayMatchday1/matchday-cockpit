"use client";

import AdminGuard from "@/components/AdminGuard";
import ExpenseAdminView from "@/components/ExpenseAdminView";

export default function FinanceExpensesPage() {
  return (
    <AdminGuard>
      <ExpenseAdminView />
    </AdminGuard>
  );
}
