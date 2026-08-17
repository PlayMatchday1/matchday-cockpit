"use client";

// PLAYER FUNNEL — the landing view for Growth. The four cards (App Downloads, Registrations,
// Played 1 Match, Played 5 Matches) and the funnel comparison table, both moved verbatim.
//
// FOLLOWS THE PERIOD: both panels did on the old single-scroll page.
// SHOWS THE START DATES: this is the one page that plots registration-era series (downloads,
// registrations) NEXT TO play-era ones (played 1, played 5), so the empty region before the play
// floor is visible here and would read as zero without the note.

import KpiRow from "@/components/growth/KpiRow";
import PlayerFunnel from "@/components/growth/PlayerFunnel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function GrowthFunnelPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Player Funnel"
      subtitle="Download to registration to a fifth match — where players arrive and where they fall away."
      startDates
      storeHistory
    >
      {g.data && g.activePeriod && (
        <>
          <KpiRow data={g.data} period={g.activePeriod} />
          <PlayerFunnel data={g.data} period={g.activePeriod} />
        </>
      )}
    </SectionFrame>
  );
}
