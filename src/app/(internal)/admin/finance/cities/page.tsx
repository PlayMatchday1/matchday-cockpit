"use client";

// CITIES — CityPnlTable. Since 2026-10-10 it draws its own page name and the shared pinned bar
// (FinancePageBar), with a City select and a small "Field cost: Per match | As billed" toggle.
import CityPnlTable from "@/components/CityPnlTable";

export default function FinanceCitiesPage() {
  /* THE BASIS IS IN THE REVENUE HOVERS (2026-10-10): net revenue, the Revenue page's own, read
   * through useNetRevenue — said in the info icon on every Revenue header and tile, not a line. */
  return (
    <>
      <CityPnlTable />
    </>
  );
}
