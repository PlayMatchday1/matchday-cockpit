"use client";

/* ADS — paid acquisition by market: what we spent, what it bought, and what it cost.
 *
 * NO PERIOD BAR, and needsGrowthData is false. This page reads none of /api/lifecycle's payload —
 * it has its own route over the Meta tables and growth_acquisition_daily — so holding it behind a
 * 1.4-second payload it never touches would be waiting for nothing. It owns its own range control
 * and its own loading state, which is the contract SectionFrame states for that flag.
 *
 * THE OVERVIEW ONLY. Incrementality waits for the OKC control to accrue enough players for the
 * counterfactual to mean something (one control player currently moves it by 22.5), and Payback
 * waits for cohorts old enough to have a settled 90-day revenue figure.
 */

import AdsOverviewPanel from "@/components/growth/AdsOverviewPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";

export default function LifecycleAdsPage() {
  const g = useGrowth();
  return (
    <SectionFrame
      title="Ads"
      subtitle="Meta spend by market against the players it brought in. Set the range below; this page does not follow the time period."
      period={false}
      needsGrowthData={false}
    >
      <AdsOverviewPanel authHeaders={g.authHeaders} />
    </SectionFrame>
  );
}
