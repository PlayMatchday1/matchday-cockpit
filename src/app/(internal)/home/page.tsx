"use client";

// Home page (home-v5). The body is HomeGoalsView: a full-bleed hero band, the
// org-goal deck, then This Week + P&D. HomeGoalsView owns its own 1280px inner
// container (Home is not tables) while the hero breaks out to full width;
// AuthGate's shared 1600px <main> is untouched, so every other route keeps 1600.

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import HomeGoalsView from "@/components/HomeGoalsView";
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
      <HomeGoalsView />
    </ClubhouseQuarterProvider>
  );
}
