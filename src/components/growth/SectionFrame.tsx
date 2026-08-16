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

export default function SectionFrame({
  title, subtitle, period = true, startDates = false, children,
}: {
  title: string;
  subtitle: string;
  period?: boolean;
  // THE THREE START DATES follow the pages that PLOT ACROSS THEM — see each page for why.
  startDates?: boolean;
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
      {startDates && (
        <div className={styles.calloutBanner} data-testid="growth-start-dates">
          This data has <b>three start dates</b>, not one. Registrations reach back to{" "}
          <b>{monthLabel(g.data.floors.registrations)}</b> and memberships to <b>{monthLabel(g.data.floors.memberships)}</b>,
          but every play-derived number begins <b>{monthLabel(g.data.floors.play)}</b>, the first month any matches
          exist. Empty regions before a series&rsquo; start mean &ldquo;no data yet&rdquo;, never zero.
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
