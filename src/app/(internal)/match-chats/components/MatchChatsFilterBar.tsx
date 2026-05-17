"use client";

// City pill row for /match-chats. Mirrors /chats Players FilterBar
// exactly in styling, ordering, and behavior — cities are multi-
// select via a Set<string>, empty set means "all cities" (no explicit
// All pill). Differences vs /chats:
//   - No status pills (All / Unassigned / Mine) and no separator —
//     match-chats has no assignment concept.
//   - The same KNOWN_CITY_CODES + UNKNOWN_CITY source is used so the
//     two surfaces can never drift in city list or order.

import { KNOWN_CITY_CODES } from "@/lib/cityNormalization";
import { UNKNOWN_CITY } from "@/lib/cityColors";

const ALL_CITY_CODES: readonly string[] = [...KNOWN_CITY_CODES, UNKNOWN_CITY];

export default function MatchChatsFilterBar({
  cities,
  onChange,
}: {
  cities: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const toggleCity = (code: string) => {
    const next = new Set(cities);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  };

  return (
    <div className="min-w-0 shrink-0 overflow-hidden border-b border-cream-line bg-cream-soft">
      <div className="scrollbar-hide flex flex-nowrap items-center gap-1.5 overflow-x-auto px-3 py-2 pr-4 sm:px-4">
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

// Same shape and colors as /chats FilterPill so the two surfaces
// look identical pill-by-pill.
function FilterPill({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ touchAction: "manipulation" }}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition ${
        active
          ? "bg-deep-green text-cream"
          : "border border-deep-green/20 bg-transparent text-deep-green/70 hover:bg-cream-soft"
      }`}
    >
      {label}
    </button>
  );
}
