"use client";

// PLAYER FUNNEL — the landing view for Growth. The four cards (App Downloads, Registrations,
// Played 1 Match, Played 5 Matches) and the funnel comparison table.
//
// ── ONE RANGE, DRIVING BOTH PANELS ───────────────────────────────────────────────────────────
// Ryan: "We don't need time periods at top because there's already a custom range for the last row."
//
// The period BUBBLES are gone from this page (SectionFrame period={false}), and the range that used
// to live inside the funnel table now lives HERE and drives the cards as well.
//
// REMOVING THE BUBBLES ALONE WOULD HAVE ORPHANED THE CARDS. KpiRow filters everything on
// period.start / period.end, so with no selector it would have frozen on whatever default the
// provider handed it and silently stopped responding to anything. That is why the range moved UP
// rather than the bubbles simply being deleted: one control, both panels, nothing left reading a
// period nobody can change.
//
// PeriodBar ITSELF IS UNTOUCHED and still drives BehaviorPanel. `period={false}` is a prop
// SectionFrame already had, documented as "the page genuinely does not follow it".
//
// THE RANGE IS CLAMPED TO THE BUSINESS MONTH, so its end cannot be a month there can be no data
// for. See lib/funnelMonth: the axis runs into the future because growth_play_dims carries BOOKED
// matches, and an end month you cannot have data for is not a choice.

import { useMemo, useState } from "react";
import KpiRow from "@/components/growth/KpiRow";
import PlayerFunnel from "@/components/growth/PlayerFunnel";
import SectionFrame from "@/components/growth/SectionFrame";
import { useGrowth } from "@/components/growth/GrowthDataProvider";
import { clampMonthsToNow } from "@/lib/funnelMonth";
import MonthRangeBar from "@/components/growth/MonthRangeBar";

export default function LifecycleFunnelPage() {
  const g = useGrowth();
  /* THE SAME CLAMP THE TABLE USES, from the same helper. The provider's month list is the axis, so
   * it carries the future months too, and the picker must not offer them. */
  const months = useMemo(() => clampMonthsToNow(g.months), [g.months]);
  const first = months[0] ?? "";
  const last = months[months.length - 1] ?? "";
  /* ── THE DEFAULT IS THE LAST SIX MONTHS, WHICH IS WHAT THE REMOVED BUBBLE DID ──────────────
   * So the page says the same thing on load as it did before the bubbles came out. Replacing a
   * control with a wider default would have read as the numbers changing when only the window did.
   *
   * THE PICKERS STILL OFFER THE WHOLE AXIS, Mar 2023 through the current month, so anyone can widen
   * to all time in one click. They simply do not OPEN there.
   *
   * THE UPPER CLAMP IS UNCHANGED: `last` is the current business month, never a booked future one. */
  const DEFAULT_SPAN = 6;
  const defaultStart = months[Math.max(0, months.length - DEFAULT_SPAN)] ?? first;
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");
  const range = useMemo(() => {
    const s = start || defaultStart;
    const e = end || last;
    // LO/HI RATHER THAN TRUSTING THE ORDER. Two month inputs can be set either way round.
    return { start: s <= e ? s : e, end: s <= e ? e : s };
  }, [start, end, defaultStart, last]);

  return (
    <SectionFrame
      title="Player Funnel"
      subtitle="Track player conversion and drop-off from download to fifth match."
      period={false}
    >
      {g.data && months.length > 0 && (
        <>
          {/* THE ONE RANGE CONTROL ON THIS PAGE. Above both panels because it drives both.
              MOVED INTO MonthRangeBar so Player Activity uses this control rather than a copy of
              it. The markup, the classes and all three `data-testid`s are unchanged — this page
              renders exactly what it rendered before. */}
          <MonthRangeBar
            range={range} min={first} max={last}
            onStart={setStart} onEnd={setEnd}
            testId="funnel-range" startTestId="funnel-range-start"
            endTestId="funnel-range-end" echoTestId="funnel-range-echo"
          />
          <KpiRow data={g.data} period={range} />
          <PlayerFunnel data={g.data} period={range} />
        </>
      )}
    </SectionFrame>
  );
}
