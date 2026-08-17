"use client";

// HOW THE NUMBERS ARE MADE — every methodological statement on Growth, in one place.
//
// WHY IT IS HERE AND NOWHERE ELSE. These paragraphs used to sit above and below the charts they
// described: a green "three start dates" banner over three sections, a store-history sentence on
// the downloads card, and a footnote under the funnel table explaining the bar, the aggregate
// ratio and the Android-only gap. Prose above a number competes with the number; the same prose on
// three pages is the same fact maintained in three places. The Data Room is the page someone opens
// to ask HOW a figure is made, so all of it lives here and nothing on Growth repeats it.
//
// WHAT IS NOT HERE, deliberately: the per-row coverage marks inside the funnel table
// ("Android only", "Android only before Aug 2025"). Those label ONE row's number and travel with
// it — they are data labels, not explanation, and moving them would leave a number stating more
// than it can support.
//
// EVERY DATE IS READ FROM THE DATA. Nothing below is written into the copy, so a new store, a
// later Apple floor or a changed first-match month updates this page by itself.

import type { GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { monthLabel } from "./format";

export default function HowNumbersAreMade({ data }: { data: GrowthData }) {
  const ios = data.downloads.ios;
  const android = data.downloads.android;
  return (
    <div className={styles.card} data-testid="growth-methodology">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>How these numbers are made</div>
        </div>
      </div>

      <dl className={styles.methodList}>
        <dt>Three start dates, not one</dt>
        <dd>
          Registrations reach back to <b>{monthLabel(data.floors.registrations)}</b> and memberships to{" "}
          <b>{monthLabel(data.floors.memberships)}</b>, but every play-derived number — matches, spots, revenue,
          cohorts, retention, ARPP — begins <b>{monthLabel(data.floors.play)}</b>, the first month any matches exist.
          Empty regions before a series&rsquo; start mean &ldquo;no data yet&rdquo;, never zero.
        </dd>

        {(ios || android) && (
          <>
            <dt>App downloads have a fourth, and it is permanent</dt>
            <dd>
              {ios && (
                <>
                  Apple&rsquo;s monthly reports begin <b>{monthLabel(ios.earliest.slice(0, 7))}</b> and are retained for
                  one year only, so earlier iOS months do not exist and cannot be recovered — Apple keeps yearly
                  reports for ten years, but with no monthly granularity.{" "}
                </>
              )}
              {android && <>Google&rsquo;s reach back to <b>{monthLabel(android.earliest.slice(0, 7))}</b>. </>}
              A combined figure is therefore both stores only from {ios ? monthLabel(ios.earliest.slice(0, 7)) : "Apple's floor"} onward;
              rows in the funnel table that start earlier say so on the row itself.
            </dd>

            <dt>The two stores count differently</dt>
            <dd>
              Apple <b>App Units</b> are new downloads; Google <b>user-installs</b> are user-deduped. A combined total
              is a convenience, not a like-for-like figure.
            </dd>
          </>
        )}

        <dt>Downloads → Registrations is an aggregate ratio</dt>
        <dd>
          Not a per-user conversion. Store installs cannot be linked to a player — Apple and Google never reveal who
          installed — unlike every later step, which is a true cohort subset of the one before it.
        </dd>

        <dt>The funnel bars and the cohort</dt>
        <dd>
          Each bar is that stage as a share of the row&rsquo;s largest stage, so the funnel narrows left to right; the
          figure between two cells is the conversion from the left one to the right one, dashed whenever either side is
          unknown. Every row counts one period&rsquo;s sign-up cohort and how many went on to play that many
          non-cancelled matches <b>ever</b>, so each stage is a subset of the one before it.
        </dd>

        <dt>An open month</dt>
        <dd>
          The current month is part-elapsed and Apple&rsquo;s daily feed lags, so its denominator is still arriving. Its
          conversion is marked <b>so far</b> and is not comparable to the closed rows beneath it. It is never excluded
          or annualised.
        </dd>

        <dt>Fake players</dt>
        <dd>
          Excluded everywhere — {data.rowCounts.usersFake.toLocaleString()} fake users and{" "}
          {data.rowCounts.fakeLiveRows.toLocaleString()} live fake rows are removed before any figure is computed.
          Source is the live mdapi_* mirror plus fin_revenue, read-only.
        </dd>
      </dl>
    </div>
  );
}
