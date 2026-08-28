"use client";

// COST — new. See src/components/finance/CostSection.tsx.
import RevenueBasisNote from "@/components/RevenueBasisNote";
import CostSection from "@/components/finance/CostSection";

export default function FinanceCostPage() {
  /* THE BASIS, ON SCREEN. Finance › Revenue and Cities are TAX-INCLUSIVE by design (money
   * collected, ties to Stripe gross volume); Cost is PRE-TAX because it divides into
   * roster-derived revenue. The ~8% between them is stated, not reconciled away. */
  return (
    <>
      <RevenueBasisNote basis="pre-tax" />
      <CostSection />
    </>
  );
}
