"use client";

// Primary pill nav for /admin/finance. Six daily-use views; admin /
// maintenance views moved into the secondary nav (Configure group)
// at the top-right of the hero. Same green-pill styling as before.
//
// Controlled component — parent owns the active-tab state. Click
// dispatches via onChange.

export const FINANCE_TAB_IDS = [
  // Primary pills (this component)
  "cities",
  "cash-flow",
  "field-ranking",
  "match-pnl",
  "exec-summary",
  "projections",
  // Configure group (rendered via FinanceConfigureSubNav when the
  // Configure secondary nav item is active)
  "revenue",
  "expenses",
  "manager-pay",
  "field-costs",
  "billing-schedule",
  "change-log",
  // Standalone secondary-nav items
  "check-ins",
  "partner-dashboards",
] as const;

export type FinanceTabId = (typeof FINANCE_TAB_IDS)[number];

const PRIMARY: { id: FinanceTabId; label: string }[] = [
  { id: "cities", label: "Cities" },
  { id: "cash-flow", label: "Cash Flow" },
  { id: "field-ranking", label: "Field Ranking" },
  { id: "match-pnl", label: "Match P&L" },
  { id: "exec-summary", label: "Exec Summary" },
  { id: "projections", label: "Projections" },
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
      <div role="tablist" className="flex flex-wrap items-center gap-2">
        {PRIMARY.map((t) => {
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
    </nav>
  );
}
