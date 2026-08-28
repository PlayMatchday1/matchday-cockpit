"use client";

// REVENUE — new. See src/components/finance/RevenueSection.tsx.
import RevenueBasisNote from "@/components/RevenueBasisNote";
import RevenueSection from "@/components/finance/RevenueSection";

export default function FinanceRevenuePage() {
  /* THE BASIS, ON SCREEN. Finance › Revenue and Cities are TAX-INCLUSIVE by design (money
   * collected, ties to Stripe gross volume); Cost is PRE-TAX because it divides into
   * roster-derived revenue. The ~8% between them is stated, not reconciled away. */
  return (
    <>
      <RevenueBasisNote basis="tax-inclusive" />
      <RevenueSection />
    </>
  );
}
