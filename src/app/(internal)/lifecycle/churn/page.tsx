"use client";

// CHURN — players who stopped playing, and who to win back (rebuilt 2026-11-09, Figma sl6PTy5LhCVj1gF0HvGmuF 32:3).
// NO PERIOD BAR: the page's own sentence filter sets the window. Reads only /api/lifecycle/churn.

import ChurnView from "@/components/growth/ChurnView";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleChurnPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Churn"
      subtitle="Players who stopped playing, and who to win back"
      period={false}
      needsGrowthData={false}
    >
      <ChurnView authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
