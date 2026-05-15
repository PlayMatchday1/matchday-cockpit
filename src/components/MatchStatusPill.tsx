// Pill rendering for the per-match status surfaced on the CRM right
// pane "Recent Matches" panel. Mirrors the StatusPill conventions
// (dot + label + ring + inset top highlight) but keeps a dedicated
// status union — overloading the goals StatusPill would couple two
// independent domains.
//
// Status derivation precedence (computed server-side in
// /api/crm/threads/[id]):
//   Canceled  ← mp.is_cancelled = true OR m.is_cancelled = true
//   No-show   ← mp.is_absent = true AND m.start_date < now
//   Played    ← m.start_date < now AND no flags
//   Upcoming  ← m.start_date >= now

export type MatchStatus = "Played" | "Upcoming" | "No-show" | "Canceled";

const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255_/_0.55)]";

const COLORS: Record<MatchStatus, { pill: string; dot: string }> = {
  // Past + attended → mint, matches StatusPill "On track" semantics.
  Played: {
    pill: "bg-mint-soft text-deep-green ring-mint/40",
    dot: "bg-mint",
  },
  // Future registration → blue, matches StatusPill "Done" semantics.
  Upcoming: {
    pill: "bg-blue-soft text-blue-info ring-blue-info/30",
    dot: "bg-blue-info",
  },
  // Registered + missed → pale amber. Deep-green text because gold
  // on gold-soft is too low-contrast (same trick StatusPill uses on
  // mint-soft).
  "No-show": {
    pill: "bg-gold-soft text-deep-green ring-gold/60",
    dot: "bg-gold",
  },
  // Cancelled by either side → muted gray (low signal, but present
  // so operators can see the cancellation pattern).
  Canceled: {
    pill: "bg-muted-soft text-muted ring-cream-line",
    dot: "bg-muted",
  },
};

export default function MatchStatusPill({ status }: { status: MatchStatus }) {
  const c = COLORS[status];
  return (
    <span className={`${PILL_BASE} ${c.pill}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {status}
    </span>
  );
}
