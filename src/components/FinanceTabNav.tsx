"use client";

// Two-row tab nav for /admin/finance. Row 1 = daily-use views;
// Row 2 = admin/maintenance views. Same pill styling for both rows
// (active = mint solid, inactive = white outline). Each row wraps
// independently on narrow screens.
//
// Controlled component — parent owns the active-tab state. Click
// dispatches via onChange, no URL change, no scroll.

export const FINANCE_TAB_IDS = [
  // Row 1 — daily-use
  "cities",
  "exec-summary",
  "revenue",
  "expenses",
  "manager-pay",
  "cash-flow",
  "projections",
  "match-pnl",
  "field-ranking",
  // Row 2 — admin / maintenance
  "check-ins",
  "partner-dashboards",
  "field-costs",
  "billing-schedule",
  "change-log",
] as const;

export type FinanceTabId = (typeof FINANCE_TAB_IDS)[number];

const ROW_1: { id: FinanceTabId; label: string }[] = [
  { id: "cities", label: "Cities" },
  { id: "exec-summary", label: "Exec Summary" },
  { id: "revenue", label: "Revenue" },
  { id: "expenses", label: "Expenses" },
  { id: "manager-pay", label: "Manager Pay" },
  { id: "cash-flow", label: "Cash Flow" },
  { id: "projections", label: "Projections" },
  { id: "match-pnl", label: "Match P&L" },
  { id: "field-ranking", label: "Field Ranking" },
];

const ROW_2: { id: FinanceTabId; label: string }[] = [
  { id: "check-ins", label: "Check-Ins" },
  { id: "partner-dashboards", label: "Partner Dashboards" },
  { id: "field-costs", label: "Field Costs" },
  { id: "billing-schedule", label: "Billing Schedule" },
  { id: "change-log", label: "Change Log" },
];

export default function FinanceTabNav({
  value,
  onChange,
}: {
  value: FinanceTabId;
  onChange: (next: FinanceTabId) => void;
}) {
  return (
    <nav
      aria-label="Finance views"
      className="sticky top-0 z-30 -mx-4 mb-8 border-y border-cream-line bg-cream-soft/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-cream-soft/80 sm:-mx-6 sm:px-6"
    >
      <Row tabs={ROW_1} value={value} onChange={onChange} />
      <div className="mt-2">
        <Row tabs={ROW_2} value={value} onChange={onChange} />
      </div>
    </nav>
  );
}

function Row({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: FinanceTabId; label: string }[];
  value: FinanceTabId;
  onChange: (next: FinanceTabId) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap items-center gap-2">
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={
              active
                ? "rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
                : "rounded-full border border-cream-line bg-white px-3 py-1.5 text-xs font-bold text-deep-green transition hover:bg-cream-soft"
            }
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
