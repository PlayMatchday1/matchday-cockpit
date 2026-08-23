"use client";

// PLAYER DATA ROOM — moved verbatim. Follows the period, as it did before.

import DataRoomPanel from "@/components/growth/DataRoomPanel";
import HowNumbersAreMade from "@/components/growth/HowNumbersAreMade";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleDataRoomPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Player Data Room"
      subtitle="The rows behind every number on the other five sections, and how each one is made."
    >
      <DataRoomPanel authHeaders={g.authHeaders} />
      {/* EVERY METHODOLOGICAL STATEMENT ON GROWTH, gathered here from the banner, the downloads
          card and the funnel footnote. This is the page for how a number is made. */}
      {g.data && <HowNumbersAreMade data={g.data} />}
    </SectionFrame>
  );
}
