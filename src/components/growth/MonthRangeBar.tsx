"use client";

/* THE ONE MONTH-RANGE CONTROL, SHARED BY PLAYER FUNNEL AND PLAYER ACTIVITY.
 *
 * ── WHY IT IS A COMPONENT NOW ────────────────────────────────────────────────────────────────
 * This markup lived inline in lifecycle/funnel/page.tsx. Player Activity's rebuild needed THE SAME
 * control — same two month inputs, same "lo/hi rather than trusting the order" clamp, same resolved
 * echo reading "Apr 2026 to Sep 2026" — and copying it would have produced two controls that look
 * identical until one of them is fixed. Extracted rather than forked, which is the instruction.
 *
 * FUNNEL'S RENDERED OUTPUT IS UNCHANGED. Same classes, same element order, same `data-testid`s
 * (they are props, and funnel passes the ones it always had), same aria labels. This is a move, not
 * a redesign: the funnel suites read `funnel-range-start` / `funnel-range-end` / `funnel-range-echo`
 * and still find them.
 *
 * ── WHAT IS DELIBERATELY *NOT* IN HERE ───────────────────────────────────────────────────────
 * The DEFAULT. Funnel opens on the last six months; Activity opens on the last six months ending in
 * the current business month, and Activity's Daily grain collapses the range to one month. Those are
 * page decisions about what the range MEANS, and a shared control that tried to own them would grow
 * a mode flag per caller. The control owns the two inputs, the clamp and the echo; the caller owns
 * the value and what it does with it.
 */

import styles from "./growth.module.css";
import { monthLabel } from "./format";

export type MonthRange = { start: string; end: string };

/** Lo/hi rather than trusting the order — two month inputs can be set either way round. */
export function orderRange(a: string, b: string): MonthRange {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

export default function MonthRangeBar({
  range, min, max, onStart, onEnd,
  label = "Range",
  testId, startTestId, endTestId, echoTestId,
  startDisabled = false,
  /** Rendered after the echo. Activity puts its "Daily shows one month" note here. */
  note,
  /** Replaces the "<start> to <end>" echo when the range collapses to one month (Daily). */
  echoOverride,
}: {
  range: MonthRange;
  min: string;
  max: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  label?: string;
  testId: string;
  startTestId: string;
  endTestId: string;
  echoTestId: string;
  /* DISABLED, NOT HIDDEN. A control that vanishes leaves the reader wondering whether the range is
   * still in force; a greyed one that still shows its value says "this is the month, you just
   * cannot move this end of it". The note beside it says why. */
  startDisabled?: boolean;
  note?: React.ReactNode;
  echoOverride?: string;
}) {
  const labelId = `${testId}-label`;
  return (
    <div className={styles.funnelRangeBar} data-testid={testId}>
      <span className={styles.fieldLabel} id={labelId}>{label}</span>
      <div role="group" aria-labelledby={labelId} className={styles.funnelRangeInputs}>
        <input type="month" aria-label="Range start" data-testid={startTestId}
          className={styles.control} min={min} max={max} disabled={startDisabled}
          value={range.start} onChange={(e) => onStart(e.target.value)} />
        <span className={styles.funnelRangeDash} aria-hidden="true">to</span>
        <input type="month" aria-label="Range end" data-testid={endTestId}
          className={styles.control} min={min} max={max}
          value={range.end} onChange={(e) => onEnd(e.target.value)} />
      </div>
      <span className={styles.funnelRangeEcho} data-testid={echoTestId}>
        {echoOverride ?? `${monthLabel(range.start)} to ${monthLabel(range.end)}`}
      </span>
      {note}
    </div>
  );
}
