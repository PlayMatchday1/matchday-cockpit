"use client";

// CASH FLOW — moved. The three-card exec banner above it is rendered by the shell, which is where
// it has to live now that it is route-conditional rather than tab-conditional.
import CashFlowTabContent from "@/components/CashFlowTabContent";

export default function FinanceCashFlowPage() {
  return <CashFlowTabContent />;
}
