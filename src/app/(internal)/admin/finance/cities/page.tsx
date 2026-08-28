"use client";

// CITIES — the landing section. CityPnlTable, moved. It carries its own period tabs and basis
// controls inside its gear popover; none of that changed.
import RevenueBasisNote from "@/components/RevenueBasisNote";
import CityPnlTable from "@/components/CityPnlTable";

export default function FinanceCitiesPage() {
  /* THE BASIS, ON SCREEN. Finance › Revenue and Cities are TAX-INCLUSIVE by design (money
   * collected, ties to Stripe gross volume); Cost is PRE-TAX because it divides into
   * roster-derived revenue. The ~8% between them is stated, not reconciled away. */
  return (
    <>
      <RevenueBasisNote basis="tax-inclusive" />
      <CityPnlTable />
    </>
  );
}
