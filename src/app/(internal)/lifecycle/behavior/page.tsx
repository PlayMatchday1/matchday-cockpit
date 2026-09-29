"use client";

// PLAYER ACTIVITY — signups, bookings and returning players, as tables.
//
// ── THE CURRENT MONTH IS A COLUMN HERE, AND ONLY HERE ────────────────────────────────────────
// GrowthDataProvider.defaultPeriod filters to `m < nowMonth` - COMPLETED MONTHS ONLY - and that is
// deliberate, not a bug: a part-elapsed month beside five full ones reads as a collapse every
// month, which is the defect that bit the Daily Matches page.
//
// OVERRIDDEN HERE RATHER THAN CHANGED GLOBALLY, for two reasons and the second decided it:
//
//   1. The global default's purpose still holds wherever the bar appears. This page only earns the
//      current month because its change column compares a MATCHED WINDOW (see weekBuckets
//      matchedMonthWindow). Nothing else has that, so nothing else has earned it.
//
//   2. revenue-per-player RENDERS PeriodBar AND ArppPanel NEVER RECEIVES A PERIOD - see
//      src/app/(internal)/lifecycle/revenue-per-player/page.tsx:18, which passes `data` only and
//      does not read useGrowth itself. That control already changes nothing on its own page.
//      Widening defaultPeriod globally would alter the SEED of an inert control: a change with no
//      visible effect and no test, which is the worst kind to make in passing.
//
// Traced before deciding: defaultPeriod's only functional consumer is this page. SectionFrame uses
// it to seed PeriodBar, and only `behavior` and `revenue-per-player` still render that bar; the
// other five Lifecycle pages pass period={false}.

import { useMemo } from "react";
import BehaviorPanel from "@/components/growth/BehaviorPanel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";
import { businessMonthKey } from "@/lib/funnelMonth";

export default function LifecycleBehaviorPage() {
  const g = useGrowth();
  /* THE CURRENT BUSINESS MONTH, EXTENDED ONTO THE END OF WHATEVER THE BAR SAYS. Extending rather
   * than replacing keeps the bar meaningful: move it and this follows, it simply never stops short
   * of the month we are in. BUSINESS_TZ and not UTC, because on the 1st a UTC runtime is already in
   * the new month while Chicago is not - one wrong day a month, the hardest kind to notice. */
  const period = useMemo(() => {
    if (!g.activePeriod) return null;
    const now = businessMonthKey();
    const available = g.months.filter((m) => m <= now);
    const latest = available[available.length - 1] ?? g.activePeriod.end;
    return g.activePeriod.end >= latest
      ? g.activePeriod
      : { start: g.activePeriod.start, end: latest };
  }, [g.activePeriod, g.months]);

  return (
    <SectionFrame
      title="Player Activity"
      subtitle="Track signups, bookings and returning players."
    >
      {g.data && period && <BehaviorPanel data={g.data} period={period} authHeaders={g.authHeaders} />}
    </SectionFrame>
  );
}
