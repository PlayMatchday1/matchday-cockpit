"use client";

import { useState } from "react";
import Link from "next/link";
import PagePermissionGuard from "@/components/PagePermissionGuard";
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
  const [monthlyCollapsed, setMonthlyCollapsed] = useState(false);
  const [insightsCollapsed, setInsightsCollapsed] = useState(false);

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
          Monthly P&L, revenue trend, and operational financial detail.
        </p>
      </div>

      <div className="mb-8">
        <RevenuePerMatchCard />
      </div>

      <div className="mb-8">
        <FinanceInsightsGrid
          collapsed={insightsCollapsed}
          onToggle={() => setInsightsCollapsed((c) => !c)}
        />
      </div>

      <div className="mb-8">
        <FinanceTrendChart />
      </div>

      <div className="mb-12">
        <FinanceMonthlyPL
          collapsed={monthlyCollapsed}
          onToggle={() => setMonthlyCollapsed((c) => !c)}
        />
      </div>
    </>
  );
}
