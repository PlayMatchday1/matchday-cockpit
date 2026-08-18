"use client";

// Expenses — moved out of the Configure overlay into its own route. It was reachable only by
// opening a strip that replaced whichever section you were on; the rail names it directly now.
// Same component, unchanged.
import ExpenseAdminView from "@/components/ExpenseAdminView";

export default function Page() {
  return <ExpenseAdminView />;
}
