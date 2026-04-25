import type { Status } from "@/lib/types";

const PILL_BASE =
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold ring-1 ring-inset shadow-[inset_0_1px_0_rgb(255_255_255_/_0.55)]";

const COLORS: Record<Status, { pill: string; dot: string }> = {
  "Not started": {
    pill: "bg-muted-soft text-muted ring-cream-line",
    dot: "bg-muted",
  },
  "On track": {
    pill: "bg-mint-soft text-deep-green ring-mint/40",
    dot: "bg-mint",
  },
  "In progress": {
    pill: "bg-mint-soft text-deep-green ring-mint/40",
    dot: "bg-mint",
  },
  "At risk": {
    pill: "bg-coral-soft text-coral ring-coral/40",
    dot: "bg-coral",
  },
  Done: {
    pill: "bg-blue-soft text-blue-info ring-blue-info/30",
    dot: "bg-blue-info",
  },
};

export default function StatusPill({ status }: { status: Status }) {
  const c = COLORS[status];
  return (
    <span className={`${PILL_BASE} ${c.pill}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {status}
    </span>
  );
}

const HEALTH_COLORS: Record<
  "Healthy" | "Building" | "At risk",
  { pill: string; dot: string }
> = {
  Healthy: {
    pill: "bg-mint-soft text-deep-green ring-mint/40",
    dot: "bg-mint",
  },
  Building: {
    pill: "bg-blue-soft text-blue-info ring-blue-info/30",
    dot: "bg-blue-info",
  },
  "At risk": {
    pill: "bg-coral-soft text-coral ring-coral/40",
    dot: "bg-coral",
  },
};

export function CityHealthPill({
  health,
}: {
  health: "Healthy" | "Building" | "At risk";
}) {
  const c = HEALTH_COLORS[health];
  return (
    <span className={`${PILL_BASE} ${c.pill}`}>
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {health}
    </span>
  );
}
