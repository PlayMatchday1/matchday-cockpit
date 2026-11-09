"use client";

// PLAYER DATA ROOM — a campaign list builder: Played, Never played and Pivot (rebuilt 2026-11-09).
// The panel reads nothing from g.data and takes only the token, so it renders at once.

import DataRoomPanel from "@/components/growth/DataRoomPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleDataRoomPage() {
  const g = useGrowth();
  return (
    /* NO PERIOD BAR: every tab has its own months (Played between, Signed up in, the pivot's From). */
    <SectionFrame period={false} needsGrowthData={false} title="Player Data Room"
      subtitle="Lists of players for a campaign, ready for Klaviyo, and a pivot over the same data.">
      <DataRoomPanel authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
