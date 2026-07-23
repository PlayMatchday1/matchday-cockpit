"use client";

// One horizontal-scroll row of ticket-style status views — mutually
// exclusive, single-select: Open / Awaiting reply / Mine / Starred /
// Closed. City filtering was removed as noise (the per-row city tag
// still gives at-a-glance context); counts are global.
//
// Views:
//   Open          — status = open (the main inbox, default)
//   Awaiting reply — open threads where the customer spoke last
//   Mine          — open threads assigned to the viewer
//   Starred       — the viewer's starred threads, open or closed
//   Closed        — status = closed
//
// "Mine" is disabled when the viewer has no app_user id (vanishingly
// unlikely past AdminGuard but defended).

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

export default function FilterBar({
  view,
  counts,
  onChange,
  canFilterMine,
}: {
  view: StatusFilter;
  counts: ViewCounts;
  onChange: (next: { view: StatusFilter }) => void;
  canFilterMine: boolean;
}) {
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
