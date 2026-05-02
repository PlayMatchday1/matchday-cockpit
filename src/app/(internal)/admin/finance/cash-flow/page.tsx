"use client";

import { useState } from "react";
import Link from "next/link";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import CashFlowExecHero from "@/components/CashFlowExecHero";
import CashFlowLensNav, { type CashFlowLens } from "@/components/CashFlowLensNav";
import FinanceInsightsGrid from "@/components/FinanceInsightsGrid";
import FinanceMonthlyPL from "@/components/FinanceMonthlyPL";
import FinanceTrendChart from "@/components/FinanceTrendChart";
import RevenuePerMatchCard from "@/components/RevenuePerMatchCard";

export default function FinanceCashFlowPage() {
  return (
    <PagePermissionGuard page="finance">
      <FinanceCashFlowContent />
    </PagePermissionGuard>
  );
}

function FinanceCashFlowContent() {
  const [lens, setLens] = useState<CashFlowLens>("cash-flow");

  return (
    <>
      <div className="mb-6 text-sm">
        <Link
          href="/admin/finance"
          className="text-deep-green/60 transition hover:text-deep-green"
        >
          ← Back to Finance
        </Link>
      </div>

      <div className="mb-8">
        <h1 className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          Cash Flow
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-deep-green/65">
          Monthly P&amp;L, revenue trend, and operational financial detail.
        </p>
      </div>

      <div className="mb-8">
        <CashFlowExecHero />
      </div>

      <CashFlowLensNav value={lens} onChange={setLens} />

      {lens === "cash-flow" && <CashFlowLensView />}
      {lens === "insights" && <InsightsLensView />}
      {lens === "trend" && <TrendLensView />}
    </>
  );
}

function CashFlowLensView() {
  // Headline view of this lens — render expanded permanently. No
  // collapse toggle; the lens-tab pattern already gates visibility.
  return (
    <div className="mb-12">
      <FinanceMonthlyPL />
    </div>
  );
}

function InsightsLensView() {
  return (
    <div className="space-y-8">
      <FinanceInsightsGrid />
      <RevenuePerMatchCard />
    </div>
  );
}

function TrendLensView() {
  return (
    <div className="mb-12">
      <FinanceTrendChart />
    </div>
  );
}
