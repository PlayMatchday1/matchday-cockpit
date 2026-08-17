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
  title, subtitle, period = true, children,
}: {
  title: string;
  subtitle: string;
  period?: boolean;
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
  if (!g.data || !g.activePeriod) {
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
      {period && (
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
