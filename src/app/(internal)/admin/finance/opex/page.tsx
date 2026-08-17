"use client";

// OPEX — the billing calendar, moved. Its "add an expense" affordance opened the Expenses editor
// by flipping page-level tab state; the editor is a Configure surface, so it now asks the shell to
// open that overlay instead. Same destination, same one click.
import OpExCalendarView from "@/components/OpExCalendarView";
import { useFinanceOverlay } from "../FinanceShell";

export default function FinanceOpExPage() {
  const { openExpenses } = useFinanceOverlay();
  return <OpExCalendarView onAddExpense={openExpenses} />;
}
