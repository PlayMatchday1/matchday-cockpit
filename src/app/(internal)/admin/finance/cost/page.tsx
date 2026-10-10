"use client";

// COST — new. See src/components/finance/CostSection.tsx.
import CostSection from "@/components/finance/CostSection";

export default function FinanceCostPage() {
  /* THE BASIS IS IN THE REVENUE HOVERS (2026-10-10): net revenue, the Revenue page's own, read
   * through useNetRevenue — said in the info icon on every Revenue header and tile, not a line. */
  return (
    <>
      <CostSection />
    </>
  );
}
