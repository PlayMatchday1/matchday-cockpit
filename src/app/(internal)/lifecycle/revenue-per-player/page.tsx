"use client";

// REVENUE PER PLAYER — redesigned 2026-11-05 (Figma "Revenue per Player", frames 15:3 and 16:2).
// NO PERIOD BAR: the preset bubbles were the first thing Miguel asked to lose (Sep 17), and the bar's
// period never reached this page anyway. The panel owns a From / To month range of its own, read
// against the month-by-month series in data.arppCard.series.

import RevenuePerPlayerPanel from "@/components/growth/RevenuePerPlayerPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleArppPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Revenue per Player"
      subtitle="What a paying player is worth each month"
      period={false}
    >
      {g.data && <RevenuePerPlayerPanel data={g.data} />}
    </SectionFrame>
  );
}
