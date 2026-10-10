"use client";

// COST — new. See src/components/finance/CostSection.tsx.
import RevenueBasisNote from "@/components/RevenueBasisNote";
import CostSection from "@/components/finance/CostSection";

export default function FinanceCostPage() {
  /* THE BASIS, ON SCREEN: net revenue, the Revenue page's own (2026-10-10). Cost and Cities read
   * it through useNetRevenue, so Revenue, Cost and Cities agree to the cent. */
  return (
    <>
      <RevenueBasisNote basis="net" />
      <CostSection />
    </>
  );
}
