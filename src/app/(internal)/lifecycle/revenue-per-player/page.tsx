"use client";

// REVENUE PER PLAYER — ARPP, moved verbatim.
// FOLLOWS THE PERIOD. SHOWS THE START DATES: revenue is play-derived and begins at the play floor,
// so a period set earlier than that renders empty months which are "no data yet", not zero.

import ArppPanel from "@/components/growth/ArppPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleArppPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Revenue per Player"
      subtitle="What an active player is worth per month, and how that has moved."
    >
      {g.data && <ArppPanel data={g.data} />}
    </SectionFrame>
  );
}
