"use client";

// PLAYER DATA ROOM — moved verbatim. Follows the period, as it did before.

import DataRoomPanel from "@/components/growth/DataRoomPanel";
import HowNumbersAreMade from "@/components/growth/HowNumbersAreMade";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleDataRoomPage() {
  const g = useGrowth();
  return (
    /* NO PERIOD BAR. The panel has never read it — it has always had its own Window control — so
     * the page was printing a period bar that changed nothing below it. That was invisible until
     * the Total column started naming the window it covers: the bar read "Feb 2026 – Jul 2026"
     * while the total beside it read "Apr 2023 – Sep 2026", two period controls on one screen
     * disagreeing. SectionFrame's own rule is that `period: false` means the page genuinely does
     * not follow it, and "printing a control that changes nothing on screen is the thing this split
     * exists to remove". The Window in the builder is the one control, and the total names it. */
    <SectionFrame
      period={false}
      title="Player Data Room"
      subtitle="The rows behind every number on the other five sections, and how each one is made. Set the window in the builder — this page does not follow the period bar."
    >
      <DataRoomPanel authHeaders={g.authHeaders} />
      {/* EVERY METHODOLOGICAL STATEMENT ON GROWTH, gathered here from the banner, the downloads
          card and the funnel footnote. This is the page for how a number is made. */}
      {g.data && <HowNumbersAreMade data={g.data} />}
    </SectionFrame>
  );
}
