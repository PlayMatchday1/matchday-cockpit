"use client";

// REVENUE — see src/components/finance/RevenueSection.tsx. The page reads fin_txn and states its own
// basis in the "How we count revenue" popover, so the old TAX-INCLUSIVE banner is gone: it is no
// longer true here (net revenue is after sales tax). Cost and Cities keep their own banners.
import RevenueSection from "@/components/finance/RevenueSection";

export default function FinanceRevenuePage() {
  return <RevenueSection />;
}
