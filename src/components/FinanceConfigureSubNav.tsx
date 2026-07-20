"use client";

// Sub-strip rendered when the Configure secondary nav item is
// active. Six tabs that used to live in the main pill nav's "admin
// / maintenance" row. Same visual style as the old Field Costs
// sub-toggle (rounded segments inside a cream-soft container).

import type { FinanceTabId } from "./FinanceTabNav";

export type ConfigureSubTabId = Extract<
  FinanceTabId,
  | "revenue"
  | "expenses"
  | "manager-pay"
  | "field-costs"
  | "change-log"
>;

export const CONFIGURE_TAB_IDS: readonly ConfigureSubTabId[] = [
  "revenue",
  "expenses",
  "manager-pay",
  "field-costs",
  "change-log",
] as const;

const ITEMS: { id: ConfigureSubTabId; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "expenses", label: "Expenses" },
  { id: "manager-pay", label: "Manager Pay" },
  { id: "field-costs", label: "Field Costs" },
  { id: "change-log", label: "Change Log" },
];

export function isConfigureSubTab(id: string): id is ConfigureSubTabId {
  return (CONFIGURE_TAB_IDS as readonly string[]).includes(id);
}

export default function FinanceConfigureSubNav({
  value,
  onChange,
}: {
  value: ConfigureSubTabId;
  onChange: (id: ConfigureSubTabId) => void;
}) {
  return (
    <div className="mb-5 inline-flex flex-wrap rounded-md border border-cream-line bg-cream-soft/60 p-0.5">
      {ITEMS.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.id)}
            className={`rounded px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition ${
              active
                ? "bg-white text-deep-green shadow-sm"
                : "text-deep-green/55 hover:text-deep-green"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
