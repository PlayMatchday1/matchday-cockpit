"use client";

// Filter row above the inbox list. Two stacked axes:
//   1. Assignment: All / Mine / Unassigned (segmented pills)
//   2. City: All / 8 codes / Unknown (segmented pills)
//
// Desktop: stacked vertically with a thin divider. Mobile:
// horizontal scroll, both rows still present, more compact spacing.
//
// "Mine" is disabled when the viewer has no app_user id (vanishingly
// unlikely past AdminGuard but defended).

import { KNOWN_CITY_CODES } from "@/lib/cityNormalization";
import { UNKNOWN_CITY } from "@/lib/cityColors";

export type StatusFilter = "all" | "unassigned" | "mine";

const ALL_CITY_CODES: readonly string[] = [...KNOWN_CITY_CODES, UNKNOWN_CITY];

export default function FilterBar({
  cities,
  status,
  onChange,
  canFilterMine,
}: {
  cities: Set<string>;
  status: StatusFilter;
  onChange: (next: { cities?: Set<string>; status?: StatusFilter }) => void;
  canFilterMine: boolean;
}) {
  const allCitiesActive = cities.size === 0;

  const toggleCity = (code: string) => {
    if (allCitiesActive) {
      onChange({ cities: new Set([code]) });
      return;
    }
    const next = new Set(cities);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange({ cities: next });
  };

  return (
    <div className="border-b border-cream-line bg-cream-soft">
      {/* Assignment row */}
      <div className="flex items-center gap-1 overflow-x-auto px-3 py-2 sm:px-4">
        <FilterPill
          active={status === "all"}
          onClick={() => onChange({ status: "all" })}
          label="All"
        />
        <FilterPill
          active={status === "unassigned"}
          onClick={() => onChange({ status: "unassigned" })}
          label="Unassigned"
        />
        <FilterPill
          active={status === "mine"}
          onClick={() => onChange({ status: "mine" })}
          label="Mine"
          disabled={!canFilterMine}
        />
      </div>
      {/* City row */}
      <div className="flex items-center gap-1 overflow-x-auto border-t border-cream-line/60 px-3 py-2 sm:px-4">
        <FilterPill
          active={allCitiesActive}
          onClick={() => onChange({ cities: new Set() })}
          label="All"
        />
        {ALL_CITY_CODES.map((code) => (
          <FilterPill
            key={code}
            active={!allCitiesActive && cities.has(code)}
            onClick={() => toggleCity(code)}
            label={code}
          />
        ))}
      </div>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  label,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 ${
        active
          ? "bg-deep-green text-mint"
          : "border border-cream-line bg-white text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {label}
    </button>
  );
}
