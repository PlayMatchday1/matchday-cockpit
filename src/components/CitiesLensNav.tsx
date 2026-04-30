"use client";

export type CityLens = "overview" | "membership" | "cancellations" | "reviews";

const LENSES: { value: CityLens; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "membership", label: "Membership" },
  { value: "cancellations", label: "Cancellations" },
  { value: "reviews", label: "Reviews" },
];

// Sticky pill-tab nav. Active tab = mint solid, inactive = white
// outline. Same shape as FinanceAnchorNav but as a stateful tab
// switcher rather than anchor links.
export default function CitiesLensNav({
  value,
  onChange,
}: {
  value: CityLens;
  onChange: (next: CityLens) => void;
}) {
  return (
    <nav
      aria-label="Cities lens"
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
