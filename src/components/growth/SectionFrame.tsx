"use client";

// ONE FRAME FOR ALL SIX GROWTH SECTIONS — title, subtitle, the period bar where it applies, and
// the three-start-dates note where it applies.
//
// WHAT THIS REPLACED. A global PeriodBar with an "applies to 4 of 7 cards" line, a three-dot
// legend (follows / own filters / all time), and a start-dates banner shown once above everything.
// All three existed only because seven cards with three different time behaviours shared one
// scroll. Per page there is nothing to disambiguate: the bar is present or it is not, and a page
// that ignores the period says so in its own subtitle.
//
// `period: false` is therefore not "hidden" — the page genuinely does not follow it, and printing
// a control that changes nothing on screen is the thing this split exists to remove.

import styles from "./growth.module.css";
import { monthLabel } from "./format";
import PeriodBar from "./PeriodBar";
import { useGrowth } from "./GrowthDataProvider";

// NO BANNER, ON ANY SECTION. The three start dates, the store floors and the counted-differently
// caveat were explanatory prose sitting above the numbers; all of it moved to the Player Data Room,
// which is the page someone opens to ask how a number is made. Stating it there once beats stating
// it above three charts — and the `startDates`/`storeHistory` props are gone rather than defaulted
// to false, so there is no switch left to turn a banner back on by accident.
export default function SectionFrame({
  title, subtitle, period = true, needsGrowthData = true, children,
  titleTestId, titleAccessory,
}: {
  title: string;
  subtitle: string;
  period?: boolean;
  /* ── TWO ADDITIVE PROPS, BOTH OPTIONAL, BOTH UNSET EVERYWHERE BUT PLAYER ACTIVITY ───────────
   * `titleTestId` overrides the default `growth-title` so a page whose own spec names its title
   * can be asserted by that name. `titleAccessory` renders INSIDE the h1, after the text — Player
   * Activity hangs its assumptions "i" there, which has to sit beside the title rather than under
   * it. Omitted, the header is byte-identical to what every other section renders, which is why
   * this is a prop rather than an edit to Head. */
  titleTestId?: string;
  titleAccessory?: React.ReactNode;
  /* ── DOES THIS SECTION ACTUALLY NEED /api/lifecycle? ──────────────────────────────────────────
   * The frame held EVERY section behind `g.data && g.activePeriod`, so a section that reads
   * neither still waited for a 1.4-second payload before it could mount — and a panel that has not
   * mounted cannot start its own fetch. Measured on the Data Room: the panel appeared at 3,465 ms
   * on a run where its fact table was ALREADY WARM. All of that was waiting for data it never
   * touches.
   *
   * DEFAULT true, so every section that does read g.data is unchanged. A section sets this false
   * only when it genuinely reads neither g.data nor g.activePeriod — and then it must handle its
   * own loading state, because it will now render before anything has arrived. */
  needsGrowthData?: boolean;
  children: React.ReactNode;
}) {
  const g = useGrowth();

  if (g.error) {
    return (
      <div className={styles.dash}>
        <Head title={title} subtitle={subtitle} titleTestId={titleTestId} titleAccessory={titleAccessory} />
        <div className={`${styles.stateMsg} ${styles.errorMsg}`}>Could not load growth data: {g.error}</div>
      </div>
    );
  }
  if (needsGrowthData && (!g.data || !g.activePeriod)) {
    return (
      <div className={styles.dash}>
        <Head title={title} subtitle={subtitle} titleTestId={titleTestId} titleAccessory={titleAccessory} />
        <div className={styles.stateMsg}>Loading growth analytics…</div>
      </div>
    );
  }

  return (
    <div className={styles.dash} data-testid="growth-section" data-section={title}>
      <Head title={title} subtitle={subtitle} titleTestId={titleTestId} titleAccessory={titleAccessory} />
      {/* The period bar needs the payload even when the section does not, so it waits on its own
          rather than holding the whole page back. */}
      {period && g.data && g.activePeriod && (
        <div data-testid="growth-period">
          <PeriodBar
            months={g.months}
            period={g.activePeriod}
            setPeriod={g.setPeriod}
            generatedAt={g.data.generatedAt}
          />
        </div>
      )}
      {children}
    </div>
  );
}

function Head({ title, subtitle, titleTestId, titleAccessory }: {
  title: string; subtitle: string;
  titleTestId?: string; titleAccessory?: React.ReactNode;
}) {
  return (
    <div className={styles.header}>
      {/* THE ACCESSORY IS A SIBLING OF THE h1, NEVER A CHILD OF IT. Inside, it joins the title's
          textContent — an assertion reading the title as exactly "Player Activity" gets
          "Player Activityi" and fails on a change that is purely decorative. */}
      <div className={styles.titleRow}>
        <h1 className={styles.title} data-testid={titleTestId ?? "growth-title"}>{title}</h1>
        {titleAccessory}
      </div>
      <p className={styles.subtitle} data-testid="growth-subtitle">{subtitle}</p>
    </div>
  );
}
