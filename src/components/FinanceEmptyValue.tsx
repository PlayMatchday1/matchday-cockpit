// Shared empty-state render for Finance value slots. Used by hero
// cards (and any other surface) when the active quarter has no data
// to display — instead of $0 / NaN / a missing card, render a muted
// em-dash with the same dimensions so layout doesn't shift.
//
// Pattern: callers pass `isEmpty` (e.g. computed from data lookups)
// and an optional `label`. Defaults match Field Ranking's "—".

export function FinanceEmptyValue({
  label = "—",
  size = "lg",
}: {
  label?: string;
  size?: "sm" | "lg";
}) {
  const cls =
    size === "lg"
      ? "text-3xl font-extrabold tabular-nums text-deep-green/30"
      : "text-sm font-bold tabular-nums text-deep-green/35";
  return <span className={cls}>{label}</span>;
}
