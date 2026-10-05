"use client";

/* ACQUISITION — where downloads and new players come from (Ryan, 2026-10-04). Replaces the Ads
 * page, which redirects here. No period bar and needsGrowthData false: the page owns its own date
 * bar and reads its own routes (/api/lifecycle/acquisition and /api/lifecycle/ads), none of
 * /api/lifecycle's payload. */

import AcquisitionView from "@/components/growth/AcquisitionView";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleAcquisitionPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Acquisition"
      subtitle="Where new players come from."
      period={false}
      needsGrowthData={false}
    >
      <AcquisitionView authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
