"use client";

// PLAYER ACTIVITY — signups, bookings and returning players, as tables.
//
// ── NO PERIOD BAR ON THIS PAGE ───────────────────────────────────────────────────────────────
// `period={false}`. The page carries ONE time control — the same MonthRangeBar Player Funnel uses —
// and a second, differently-shaped selector above it was the thing making the window ambiguous.
// PeriodBar itself is untouched and still serves every page that renders it.
//
// The long note that used to live here explained why this page overrode the shared `defaultPeriod`
// to extend it onto the current month. That override is gone with the bar: the range control owns
// its own default (the last six months ending in the current business month) and does not read
// `defaultPeriod` at all, so there is nothing left to reconcile.
//
// ── THE ASSUMPTIONS ARE CHECKED AGAINST THE CODE, NOT AGAINST INTENT ─────────────────────────
// Each line below was verified in the route and the source views before it was written, and TWO OF
// THEM WERE CHANGED because the code does something else. See the note on each.

import PlayerActivityPanel from "@/components/growth/PlayerActivityPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";
import AssumptionsInfo from "@/components/growth/AssumptionsInfo";

export default function LifecycleBehaviorPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Player Activity"
      subtitle="Track signups, bookings and returning players."
      period={false}
      titleTestId="pa-title"
      titleAccessory={<AssumptionsInfo />}
    >
      {g.data && <PlayerActivityPanel data={g.data} months={g.months} />}
    </SectionFrame>
  );
}
