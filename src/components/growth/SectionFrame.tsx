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
}: {
  title: string;
  subtitle: string;
  period?: boolean;
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
        <Head title={title} subtitle={subtitle} />
        <div className={`${styles.stateMsg} ${styles.errorMsg}`}>Could not load growth data: {g.error}</div>
      </div>
    );
  }
  if (needsGrowthData && (!g.data || !g.activePeriod)) {
    return (
      <div className={styles.dash}>
        <Head title={title} subtitle={subtitle} />
        <div className={styles.stateMsg}>Loading growth analytics…</div>
      </div>
    );
  }

  return (
    <div className={styles.dash} data-testid="growth-section" data-section={title}>
      <Head title={title} subtitle={subtitle} />
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

function Head({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className={styles.header}>
      <h1 className={styles.title} data-testid="growth-title">{title}</h1>
      <p className={styles.subtitle} data-testid="growth-subtitle">{subtitle}</p>
    </div>
  );
}
