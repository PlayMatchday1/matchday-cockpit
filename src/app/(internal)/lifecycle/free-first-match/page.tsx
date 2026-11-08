"use client";

/* FREE FIRST MATCH — is the automatic free first match (app 1.89, 2026-11-05) working: more new
 * sign-ups playing a first match, and paying players at a cost we accept. Its own page because it is
 * about one method; the other Player Lifecycle pages are untouched. No period bar and needsGrowthData
 * false: the page owns its window toggle and reads only /api/lifecycle/free-first-match. */

import FreeFirstMatchView, { FreeFirstMatchInfo } from "@/components/growth/FreeFirstMatchView";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleFreeFirstMatchPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Free first match"
      subtitle="Live since Nov 5 for new players"
      period={false}
      needsGrowthData={false}
      titleTestId="ffm-title"
      titleAccessory={<FreeFirstMatchInfo />}
    >
      <FreeFirstMatchView authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
