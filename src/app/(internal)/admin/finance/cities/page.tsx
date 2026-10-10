"use client";

// CITIES — the landing section. CityPnlTable, moved. It carries its own period tabs and basis
// controls inside its gear popover; none of that changed.
import RevenueBasisNote from "@/components/RevenueBasisNote";
import CityPnlTable from "@/components/CityPnlTable";

export default function FinanceCitiesPage() {
  /* THE BASIS, ON SCREEN: net revenue, the Revenue page's own (2026-10-10). Cost and Cities read
   * it through useNetRevenue, so Revenue, Cost and Cities agree to the cent. */
  return (
    <>
      <RevenueBasisNote basis="net" />
      <CityPnlTable />
    </>
  );
}
