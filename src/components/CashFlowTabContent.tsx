"use client";

import { useState } from "react";
import ExpenseForecastPanel from "@/components/ExpenseForecastPanel";
import CashFlowLensNav, { type CashFlowLens } from "@/components/CashFlowLensNav";
import FinanceInsightsGrid from "@/components/FinanceInsightsGrid";
import FinanceMonthlyPL from "@/components/FinanceMonthlyPL";
import FinanceTrendChart from "@/components/FinanceTrendChart";
import RevenuePerMatchCard from "@/components/RevenuePerMatchCard";

// Body-only Cash Flow tab content. Replaces the standalone page —
// drops the back-link + h1, keeps the looking-ahead hero + internal
// 3-lens nav (Cash Flow / Insights / Trend) + lens views.

export default function CashFlowTabContent() {
  const [lens, setLens] = useState<CashFlowLens>("cash-flow");

  return (
    <>
      <div className="mb-8">
        <ExpenseForecastPanel />
      </div>

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
