"use client";

// Home page. Field Pipeline and Tech Roadmap moved out to Match Ops / Tech, so
// the in-page tab strip is gone — Home is the mission banner plus the goals /
// calendar / P&D layout (built in the Home-rebuild commit). This commit keeps
// the banner + org goals working after the relocation.

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import HeroMessage from "@/components/HeroMessage";
import HomeGoalsView from "@/components/HomeGoalsView";
import CalendarPanel from "@/components/CalendarPanel";
import PdSchedulePanel from "@/components/PdSchedulePanel";
import PagePermissionGuard from "@/components/PagePermissionGuard";
import { ClubhouseQuarterProvider } from "@/lib/clubhouseQuarter";
import { resolveQuarterFromUrl, type QuarterInfo } from "@/lib/quarters";

export default function HomePage() {
  return (
    <PagePermissionGuard page="clubhouse">
      <Suspense fallback={null}>
        <HomeContent />
      </Suspense>
    </PagePermissionGuard>
  );
}

function HomeContent() {
  const sp = useSearchParams();
  // Quarter still resolves from ?q= and is provided as context so goal editing
  // keeps working; there is no quarter selector UI on Home.
  const quarter = useMemo<QuarterInfo>(
    () => resolveQuarterFromUrl(sp?.get("q") ?? null, new Date()),
    [sp],
  );

  return (
    <ClubhouseQuarterProvider quarter={quarter}>
      <HeroMessage />
      {/* Goals column fluid; right rail (calendar + P&D) fixed at 420px so the
          panels stay readable. Collapses to one column below 1080px. */}
      <div className="grid grid-cols-1 items-start gap-[26px] min-[1080px]:grid-cols-[minmax(0,1fr)_420px]">
        <HomeGoalsView />
        <div className="space-y-[18px]">
          <CalendarPanel />
          <PdSchedulePanel />
        </div>
      </div>
    </ClubhouseQuarterProvider>
  );
}
