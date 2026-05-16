"use client";

// One horizontal-scroll row of pills. Assignment first (All /
// Unassigned / Mine), then city codes (multi-select). Empty city
// selection is treated as "all cities" implicitly, so there's no
// separate "all cities" pill in the row.
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
  const toggleCity = (code: string) => {
    const next = new Set(cities);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange({ cities: next });
  };

  return (
    <div className="min-w-0 border-b border-cream-line bg-cream">
      <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-2 sm:px-4">
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
        <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-deep-green/15" />
        {ALL_CITY_CODES.map((code) => (
          <FilterPill
            key={code}
            active={cities.has(code)}
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
      style={{ touchAction: "manipulation" }}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-40 ${
        active
          ? "bg-deep-green text-cream"
          : "border border-deep-green/20 bg-transparent text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {label}
    </button>
  );
}
