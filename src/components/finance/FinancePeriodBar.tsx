"use client";

// THE FINANCE PERIOD BAR — one control, three grains, in the page frame above every section.
//
// It replaced two controls doing one job: a QUARTER dropdown here, and a MONTH segment inside the
// City P&L card that could only offer that quarter's three months. Both are gone.
//
// THE PARTIAL CHIP ONLY APPEARS WHEN IT IS LOAD-BEARING. A closed period carries no chip and its
// forward arrow is live; the ABSENCE of the chip is the signal that the number is final. Marking
// every period would make the mark invisible, which is the same as not having one.
//
// EACH GRAIN STATES ITS OWN DENOMINATOR — 17 of 31 for August, 48 of 92 for Q3, 229 of 365 for
// 2026. The figures are computed per grain in financePeriod.ts; none is borrowed from another.
//
// NO RUN RATE HERE. The chip states the elapsed fraction and stops. Extrapolating would answer a
// question the operator did not ask, using a denominator they cannot see.
//
// A SECTION MAY NOT SUPPORT EVERY GRAIN. OpEx is a day-grid calendar for one month and cannot
// render a quarter; those grains are DISABLED with the reason on the control, never silently
// ignored — a control that looks live and does nothing is the failure mode this codebase bans.

import type { Grain, FinancePeriod } from "@/lib/financePeriod";
import { GRAINS, GRAIN_LABEL, THIS_LABEL, RECORD_STARTS, canStepBack, canStepForward } from "@/lib/financePeriod";
import s from "./periodBar.module.css";

export default function FinancePeriodBar({
  period, now, onChangeGrain, onStep, onJumpToNow, supportedGrains, unsupportedReason, links,
}: {
  period: FinancePeriod;
  now: Date;
  onChangeGrain: (g: Grain) => void;
  onStep: (dir: -1 | 1) => void;
  onJumpToNow: () => void;
  supportedGrains: readonly Grain[];
  unsupportedReason: string;
  links: React.ReactNode;
}) {
  // Both bounds come from the model, not from arithmetic repeated here — the stepper and the
  // period must agree about where the record starts and where today is.
  const forwardOk = canStepForward(period, now);
  const backOk = canStepBack(period);

  return (
    <div className={s.bar} data-testid="finance-period-bar">
      <span className={s.lab}>Period</span>

      <div className={s.grain} role="group" aria-label="Period grain">
        {GRAINS.map((g) => {
          const off = !supportedGrains.includes(g);
          return (
            <button key={g} type="button" disabled={off}
              aria-pressed={period.grain === g}
              title={off ? unsupportedReason : undefined}
              className={period.grain === g ? s.on : ""}
              data-testid={`period-grain-${g}`}
              onClick={() => !off && onChangeGrain(g)}>
              {GRAIN_LABEL[g]}
            </button>
          );
        })}
      </div>

      <div className={s.stepper}>
        <button type="button" className={s.nav} aria-label="Previous period" disabled={!backOk}
          data-testid="period-prev" onClick={() => backOk && onStep(-1)}>‹</button>
        <span className={s.cur} data-testid="period-label">{period.label}</span>
        {/* DISABLED ON THE CURRENT PERIOD: there is no next period to look at. */}
        <button type="button" className={s.nav} aria-label="Next period" disabled={!forwardOk}
          data-testid="period-next" onClick={() => forwardOk && onStep(1)}>›</button>
      </div>

      {/* NEXT TO THE LABEL, not in a footnote: "2026" is not 2026 in this system, and the reader
          has to see that where they read the year — not further down the bar. */}
      {period.monthsOmitted > 0 && (
        <span className={s.note} data-testid="period-omitted">
          {period.monthsOmitted} month{period.monthsOmitted === 1 ? "" : "s"} before {RECORD_STARTS} not on record
        </span>
      )}

      {period.isCurrent && (
        <span className={s.partial} data-testid="period-partial">
          Partial · <b>{period.elapsedDays} of {period.totalDays} days</b>
        </span>
      )}
      {/* NOT STARTED IS NOT FINISHED. A closed period carries no chip, and that absence is what
          says its numbers are final — so a period that has not begun needs a mark of its own or it
          would borrow the wrong meaning. Reachable by URL only; the forward arrow is dead. */}
      {period.isFuture && (
        <span className={s.future} data-testid="period-future">
          Not started · <b>0 of {period.totalDays} days</b>
        </span>
      )}

      <button type="button" className={s.jump} data-testid="period-jump" onClick={onJumpToNow}>
        {THIS_LABEL[period.grain]}
      </button>


      <span className={s.spacer} />
      <span className={s.links}>{links}</span>
    </div>
  );
}
