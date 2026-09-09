"use client";

/* CASH FLOW. The monthly P&L table IS this page.
 *
 * IT USED TO BE THREE LAYERS: this route file rendered CashFlowTabContent, which rendered a sticky
 * three-pill lens nav (Cash Flow / Insights / Trend) and one of three views. Insights and Trend
 * are gone, so Cash Flow was the only lens left and the nav was chrome holding a single pill that
 * was always active. CashFlowTabContent's whole body was then one child, so it went too — a
 * component that wraps exactly one component is a layer, not a boundary.
 *
 * This route file stays because Next.js requires it; shell -> page -> table is as flat as the
 * router allows.
 *
 * THE THREE-CARD EXEC BANNER IS NOT HERE and has not moved: FinanceShell renders it, gated on this
 * pathname, because it is route-conditional rather than tab-conditional. Same for the period bar. */
import FinanceMonthlyPL from "@/components/FinanceMonthlyPL";

export default function FinanceCashFlowPage() {
  return <div className="mb-12"><FinanceMonthlyPL /></div>;
}
