"use client";

/* FREE FIRST MATCH — does the automatic free first match (app 1.89, 2026-11-05) turn into paying
 * players at a cost we accept. Its own page because it is about one method; the other Player
 * Lifecycle pages are untouched. No period bar and needsGrowthData false: the page owns its own
 * range and city controls and reads only /api/lifecycle/free-first-match. */

import FreeFirstMatchView, { FreeFirstMatchInfo } from "@/components/growth/FreeFirstMatchView";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleFreeFirstMatchPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Free first match"
      subtitle="Players whose first match was free"
      period={false}
      needsGrowthData={false}
      titleTestId="ffm-title"
      titleAccessory={<FreeFirstMatchInfo />}
    >
      <FreeFirstMatchView authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
