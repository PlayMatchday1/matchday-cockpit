"use client";

export type CashFlowLens = "cash-flow" | "insights" | "trend";

const LENSES: { value: CashFlowLens; label: string }[] = [
  { value: "cash-flow", label: "Cash Flow" },
  { value: "insights", label: "Insights" },
  { value: "trend", label: "Trend" },
];

// Sticky pill-tab nav. Active = mint solid, inactive = white outline.
// Same shape as CitiesLensNav.
export default function CashFlowLensNav({
  value,
  onChange,
}: {
  value: CashFlowLens;
  onChange: (next: CashFlowLens) => void;
}) {
  return (
    <nav
      aria-label="Cash flow lens"
      className="sticky top-0 z-30 -mx-4 mb-8 border-y border-cream-line bg-cream-soft/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-cream-soft/80 sm:-mx-6 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        {LENSES.map((l) => {
          const active = l.value === value;
          return (
            <button
              key={l.value}
              type="button"
              onClick={() => onChange(l.value)}
              aria-pressed={active}
              className={
                active
                  ? "rounded-full bg-mint px-4 py-1.5 text-xs font-bold text-deep-green transition hover:bg-mint-hover"
                  : "rounded-full border border-cream-line bg-white px-4 py-1.5 text-xs font-bold text-deep-green/65 transition hover:bg-cream-soft hover:text-deep-green"
              }
            >
              {l.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
