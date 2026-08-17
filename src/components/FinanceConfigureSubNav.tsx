"use client";

// Sub-strip rendered when the Configure secondary nav item is active. Four admin surfaces that
// are not sections: they are reachable from wherever you are in Finance, and the shell renders
// them over the routed section. Same visual style as the old Field Costs sub-toggle.
//
// The id union used to be Extract<FinanceTabId, …> — a narrowing of the old page's nine-tab enum.
// That enum described a page that no longer exists (the four daily views are routes now, and
// FinanceTabNav went with them), so the four ids are declared here directly rather than carved
// out of a type whose other members had no meaning left.

export type ConfigureSubTabId =
  | "revenue"
  | "expenses"
  | "field-costs"
  | "change-log";

export const CONFIGURE_TAB_IDS: readonly ConfigureSubTabId[] = [
  "revenue",
  "expenses",
  "field-costs",
  "change-log",
] as const;

const ITEMS: { id: ConfigureSubTabId; label: string }[] = [
  { id: "revenue", label: "Revenue" },
  { id: "expenses", label: "Expenses" },
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
