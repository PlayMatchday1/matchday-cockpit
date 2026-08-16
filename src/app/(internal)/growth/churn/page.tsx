"use client";

// CHURN — moved verbatim.
// NO PERIOD BAR: this panel has always had its own filters (inactive for, last played after) and
// never followed the global period. The subtitle states it rather than a legend dot.

import ChurnPanel from "@/components/growth/ChurnPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function GrowthChurnPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Churn"
      subtitle="Who has stopped playing — set your own inactivity window below; this page does not follow the time period."
      period={false}
    >
      {g.data && <ChurnPanel cities={g.data.cities} authHeaders={g.authHeaders} />}
    </SectionFrame>
  );
}
