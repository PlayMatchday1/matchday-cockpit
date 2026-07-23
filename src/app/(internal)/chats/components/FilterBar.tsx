"use client";

// One horizontal-scroll row of pills. Ticket-style status views first
// (Open / Mine / Starred / Closed — mutually exclusive, single-select),
// then city codes (multi-select). Empty city selection is treated as
// "all cities" implicitly, so there's no separate "all cities" pill.
//
// Views:
//   Open    — status = open (the main inbox, default)
//   Mine    — open threads assigned to the viewer
//   Starred — the viewer's starred threads, open or closed
//   Closed  — status = closed
//
// Each status chip shows a "(N)" count for the current city selection.
// "Mine" is disabled when the viewer has no app_user id (vanishingly
// unlikely past AdminGuard but defended).

import { KNOWN_CITY_CODES, HIDDEN_CITY_CODES } from "@/lib/cityNormalization";
import { UNKNOWN_CITY } from "@/lib/cityColors";

export type StatusFilter =
  | "open"
  | "awaiting"
  | "mine"
  | "starred"
  | "closed";

export type ViewCounts = {
  open: number;
  mine: number;
  starred: number;
  closed: number;
  // Open threads where the customer sent the last message.
  awaiting: number;
};

const ALL_CITY_CODES: readonly string[] = [
  ...KNOWN_CITY_CODES.filter((c) => !HIDDEN_CITY_CODES.has(c)),
  UNKNOWN_CITY,
];

export default function FilterBar({
  cities,
  view,
  counts,
  onChange,
  canFilterMine,
}: {
  cities: Set<string>;
  view: StatusFilter;
  counts: ViewCounts;
  onChange: (next: { cities?: Set<string>; view?: StatusFilter }) => void;
  canFilterMine: boolean;
}) {
  const toggleCity = (code: string) => {
    const next = new Set(cities);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange({ cities: next });
  };

  return (
    <div className="min-w-0 overflow-hidden border-b border-cream-line bg-cream">
      <div className="scrollbar-hide flex flex-nowrap items-center gap-1.5 overflow-x-auto px-3 py-2 pr-4 sm:px-4">
        <FilterPill
          active={view === "open"}
          onClick={() => onChange({ view: "open" })}
          label="Open"
          count={counts.open}
        />
        <FilterPill
          active={view === "awaiting"}
          onClick={() => onChange({ view: "awaiting" })}
          label="Awaiting reply"
          count={counts.awaiting}
          tone="alert"
        />
        <FilterPill
          active={view === "mine"}
          onClick={() => onChange({ view: "mine" })}
          label="Mine"
          count={counts.mine}
          disabled={!canFilterMine}
        />
        <FilterPill
          active={view === "starred"}
          onClick={() => onChange({ view: "starred" })}
          label="Starred"
          count={counts.starred}
        />
        <FilterPill
          active={view === "closed"}
          onClick={() => onChange({ view: "closed" })}
          label="Closed"
          count={counts.closed}
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
  count,
  tone = "default",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  // When provided and > 0, rendered as a "(N)" suffix (capped 99+).
  count?: number;
  // "alert" tints the pill red — used by Awaiting reply so an operator
  // driving the queue to zero can spot it. The count badge stays red
  // even when the pill is inactive, so the backlog reads at a glance.
  tone?: "default" | "alert";
}) {
  const showCount = typeof count === "number" && count > 0;
  const countLabel = showCount ? (count > 99 ? "99+" : String(count)) : null;
  const alert = tone === "alert";
  const base = alert
    ? active
      ? "bg-red-600 text-white"
      : "border border-red-300 bg-transparent text-red-700 hover:bg-red-50"
    : active
      ? "bg-deep-green text-cream"
      : "border border-deep-green/20 bg-transparent text-deep-green/70 hover:bg-cream-soft";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{ touchAction: "manipulation" }}
      className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-40 ${base}`}
    >
      {label}
      {countLabel && (
        <span
          className={`ml-1 tabular-nums ${
            alert && !active
              ? "rounded-full bg-red-100 px-1.5 text-red-700"
              : ""
          }`}
        >
          {alert && !active ? countLabel : `(${countLabel})`}
        </span>
      )}
    </button>
  );
}
