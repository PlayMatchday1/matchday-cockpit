"use client";

// PLAYER DATA ROOM — moved verbatim. Follows the period, as it did before.

import DataRoomPanel from "@/components/growth/DataRoomPanel";
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
      /* IT READS NOTHING FROM g.data. The only consumer was HowNumbersAreMade, which is deleted;
       * the panel takes g.authHeaders and nothing else. It was waiting 2.6 s for a payload it never
       * touches, and a panel that has not mounted cannot start its own fetch. */
      needsGrowthData={false}
      title="Player Data Room"
      subtitle="The rows behind every number on the other five sections, and how each one is made. Set the window in the builder — this page does not follow the period bar."
    >
      {/* NOTHING BELOW THE TABLE — ON THE PAGE, not just on the card. A "How these numbers are
          made" card lived here and is deleted outright, component and all. Every fact it carried
          is in docs/matchday-api-facts.md under "How the Growth / Lifecycle numbers are made":
          the three start dates, Apple's Aug 2025 floor and its one-year retention, App Units vs
          user-installs, the aggregate ratio, the open month, and the 201 fake users / 33,809 fake
          rows. Those are properties of the data, not captions for a table. */}
      <DataRoomPanel authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
