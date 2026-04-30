"use client";

import { useState } from "react";
import Link from "next/link";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import CashFlowExecHero from "@/components/CashFlowExecHero";
import CashFlowLensNav, { type CashFlowLens } from "@/components/CashFlowLensNav";
import FinanceMonthlyPL from "@/components/FinanceMonthlyPL";

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

      {lens === "cash-flow" && <CashFlowLens />}
      {lens === "insights" && <LensPlaceholder lens="Insights" phase="B" />}
      {lens === "trend" && <LensPlaceholder lens="Trend" phase="B" />}
    </>
  );
}

function CashFlowLens() {
  // Headline view of this lens — render expanded permanently. No
  // collapse toggle; the lens-tab pattern already gates visibility.
  return (
    <div className="mb-12">
      <FinanceMonthlyPL />
    </div>
  );
}

function LensPlaceholder({ lens, phase }: { lens: string; phase: string }) {
  return (
    <div className="rounded-2xl border-2 border-dashed border-cream-line bg-cream-soft/40 p-8 text-center text-sm text-deep-green/55">
      <div className="text-base font-bold text-deep-green/70">{lens} lens</div>
      <div className="mt-1">Wired in Phase {phase}.</div>
    </div>
  );
}
