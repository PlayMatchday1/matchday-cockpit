"use client";

import { useState } from "react";
import CashFlowLensNav, { type CashFlowLens } from "@/components/CashFlowLensNav";
import FinanceInsightsGrid from "@/components/FinanceInsightsGrid";
import FinanceMonthlyPL from "@/components/FinanceMonthlyPL";
import FinanceTrendChart from "@/components/FinanceTrendChart";
import RevenuePerMatchCard from "@/components/RevenuePerMatchCard";

// Body-only Cash Flow tab content. Replaces the standalone page — drops the back-link + h1,
// keeps the internal 3-lens nav (Cash Flow / Insights / Trend) + lens views.
//
// THE EXPENSE FORECAST CARD IS GONE, wrapper and all, so the lens nav is the first thing on the
// page and there is no empty container or doubled gap where the card used to sit. Its whole
// computation went with it — see the commit; expensesByCategory and expenseCategoryChildren
// survive because monthOverMonthDeltas still calls them.

export default function CashFlowTabContent() {
  const [lens, setLens] = useState<CashFlowLens>("cash-flow");

  return (
    <>
      <CashFlowLensNav value={lens} onChange={setLens} />

      {lens === "cash-flow" && (
        <div className="mb-12">
          <FinanceMonthlyPL />
        </div>
      )}
      {lens === "insights" && (
        <div className="space-y-8">
          <FinanceInsightsGrid />
          <RevenuePerMatchCard />
        </div>
      )}
      {lens === "trend" && (
        <div className="mb-12">
          <FinanceTrendChart />
        </div>
      )}
    </>
  );
}
