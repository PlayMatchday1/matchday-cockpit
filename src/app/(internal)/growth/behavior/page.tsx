"use client";

// PLAYER BEHAVIOR — the behaviour evolution section, moved verbatim.
// FOLLOWS THE PERIOD. SHOWS THE START DATES: it is a month-by-month series that begins at the play
// floor, so the leading empty months need the same explanation.

import BehaviorPanel from "@/components/growth/BehaviorPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function GrowthBehaviorPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Player Behavior"
      subtitle="How playing habits change month over month — how many play once, occasionally, or every week."
    >
      {g.data && g.activePeriod && <BehaviorPanel data={g.data} period={g.activePeriod} />}
    </SectionFrame>
  );
}
