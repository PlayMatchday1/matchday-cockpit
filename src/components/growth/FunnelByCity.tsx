"use client";

/* FUNNEL BY CITY (Ryan, 2026-10-10, from Miguel's feedback) — one row per active city, then the
 * cities outside them combined, then All cities, for ONE signup month.
 *
 * THE SAME COHORT AS THE COMPARISON ABOVE: players who completed signup in the month, and how many of
 * them have since played 1, 3, 5 and 10 non-cancelled matches (growth funnelByMonthCity, summed by
 * PlayerFunnel's own sumCohortCity). The All cities row is the comparison's own sumCohort over the
 * same month, so the two blocks cannot disagree; the city rows sum to it (checked below, loudly).
 * Fake and @matchday.com accounts are already out of both arrays, as on the rest of the page.
 *
 * THE SAME ROW DESIGN: renderRowCells, from Registrations on — there is no Downloads column,
 * because the stores report country and region, never city. Under each conversion, its change
 * against the previous month in points. */
import { useMemo, useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import { CANONICAL_CITIES } from "@/lib/growthAnalytics";
import { canonCity } from "@/lib/reviewsDerive";
import { clampMonthsToNow, currentFunnelMonth } from "@/lib/funnelMonth";
import { monthLabel } from "./format";
import { STAGES, renderRowCells, sumCohort, sumCohortCity, type Cohort } from "./PlayerFunnel";
import styles from "./growth.module.css";

const OUTSIDE = "Outside active cities";
const ALL = "All cities";
// Fleet cities that are not running. "Running" is not a fact the data carries, so it is a list —
// the same one PlayerFunnel kept for its chips (El Paso).
const NOT_RUNNING = new Set(["El Paso"].map((c) => canonCity(c)));

type SortKey = "reg" | "c1" | "c3" | "c5" | "c10";
const SORTS: { k: SortKey; label: string }[] = [
  { k: "reg", label: "Registrations" },
  { k: "c1", label: "Registration to 1 match" },
  { k: "c3", label: "1 to 3 matches" },
  { k: "c5", label: "3 to 5 matches" },
  { k: "c10", label: "5 to 10 matches" },
];

const ZERO: Cohort = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 };
const add = (a: Cohort, b: Cohort): Cohort => ({
  registrations: a.registrations + b.registrations, played1: a.played1 + b.played1, played3: a.played3 + b.played3,
  played5: a.played5 + b.played5, played10: a.played10 + b.played10,
});
const valsOf = (c: Cohort) => [c.registrations, c.played1, c.played3, c.played5, c.played10];
/** The four conversions, as fractions; null where the earlier stage is 0. */
const convs = (c: Cohort): (number | null)[] => {
  const v = valsOf(c);
  return [1, 2, 3, 4].map((i) => (v[i - 1] > 0 ? v[i] / v[i - 1] : null));
};

export default function FunnelByCity({ data }: { data: GrowthData }) {
  const months = useMemo(() => clampMonthsToNow(data.behaviorOverall.map((p) => p.m)), [data.behaviorOverall]);
  const current = currentFunnelMonth(data.behaviorOverall.map((p) => p.m));
  // THE DEFAULT IS THE LAST FULL MONTH: the one before the month in progress.
  const lastFull = useMemo(() => {
    const i = current ? months.indexOf(current) : -1;
    return i > 0 ? months[i - 1] : months[months.length - 1] ?? "";
  }, [months, current]);
  const [picked, setPicked] = useState<string>("");
  const month = picked || lastFull;
  const idx = months.indexOf(month);
  const prevMonth = idx > 0 ? months[idx - 1] : null;
  const [sort, setSort] = useState<SortKey>("reg");
  const [asc, setAsc] = useState(false);

  // Active cities and the ones outside them — the comparison's own split, from the same rows.
  const { active, outside } = useMemo(() => {
    const fleet = new Set((CANONICAL_CITIES as readonly string[]).map((c) => canonCity(c)));
    const all = [...new Set(data.funnelByMonthCity.map((r) => canonCity(r.city)))].sort();
    const isOutside = (c: string) => !fleet.has(c) || NOT_RUNNING.has(c);
    return { active: all.filter((c) => !isOutside(c)), outside: all.filter(isOutside) };
  }, [data.funnelByMonthCity]);

  const cohortOf = (name: string, m: string | null): Cohort | null => {
    if (!m) return null;
    const set = new Set([m]);
    if (name === ALL) return sumCohort(data.funnelByMonth, set);
    if (name === OUTSIDE) return outside.reduce((a, c) => add(a, sumCohortCity(data.funnelByMonthCity, set, c)), ZERO);
    return sumCohortCity(data.funnelByMonthCity, set, name);
  };

  const rows = useMemo(() => {
    const build = (name: string, pinned: boolean) => {
      const c = cohortOf(name, month)!;
      const p = cohortOf(name, prevMonth);
      const now = convs(c), before = p && p.registrations > 0 ? convs(p) : null;
      const deltas = now.map((x, i) => (x == null || !before || before[i] == null ? null : (x - before[i]!) * 100));
      return { name, pinned, c, now, deltas };
    };
    const cities = active.map((c) => build(c, false));
    const key = (r: (typeof cities)[number]): number | null =>
      sort === "reg" ? r.c.registrations : r.now[["c1", "c3", "c5", "c10"].indexOf(sort)];
    const dir = asc ? 1 : -1;
    // A city with no value for the chosen conversion sorts last both ways.
    cities.sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return a.name.localeCompare(b.name);
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * dir || a.name.localeCompare(b.name);
    });
    const out = [...cities];
    if (outside.length) out.push(build(OUTSIDE, true));
    out.push(build(ALL, true));
    // THE CITY ROWS SUM TO ALL CITIES — the property that makes the split trustworthy. A mismatch is
    // a bug in the split, said loudly rather than rendered quietly.
    const sum = out.filter((r) => r.name !== ALL).reduce((a, r) => add(a, r.c), ZERO);
    const all = out[out.length - 1].c;
    if (valsOf(sum).some((v, i) => v !== valsOf(all)[i])) {
      // eslint-disable-next-line no-console
      console.error("Funnel by city: city rows do not sum to All cities", valsOf(sum), valsOf(all));
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.funnelByMonth, data.funnelByMonthCity, active, outside, month, prevMonth, sort, asc]);

  const inProgress = month === current;
  const step = (d: -1 | 1) => { const m = months[idx + d]; if (m) setPicked(m); };

  return (
    <div className={`${styles.card} ${styles.funnelByCity}`} data-testid="funnel-by-city">
      <div className={styles.cardHead}>
        <div className={styles.cardTitle}>Funnel by city</div>
        <div className={styles.fbcControls}>
          <div className={styles.fbcMonth} role="group" aria-label="Signup month">
            <button type="button" aria-label="Previous month" data-testid="fbc-prev" disabled={idx <= 0} onClick={() => step(-1)}>‹</button>
            <span data-testid="fbc-month" data-month={month}>
              {monthLabel(month)}{inProgress && <i className={styles.funnelInProgress}> · in progress</i>}
            </span>
            <button type="button" aria-label="Next month" data-testid="fbc-next" disabled={idx < 0 || idx >= months.length - 1} onClick={() => step(1)}>›</button>
          </div>
          <label className={styles.fbcSort}>
            <span className={styles.fieldLabel}>Sort by</span>
            <select data-testid="fbc-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              {SORTS.map((o) => <option key={o.k} value={o.k}>{o.label}</option>)}
            </select>
            <button type="button" className={styles.fbcDir} data-testid="fbc-dir" aria-pressed={asc}
              title={asc ? "Lowest first: click for highest first" : "Highest first: click for lowest first"}
              onClick={() => setAsc((v) => !v)}>{asc ? "↑ Lowest first" : "↓ Highest first"}</button>
          </label>
        </div>
      </div>

      <div className={styles.funnelScroll}>
        <div className={`${styles.funnelMatrix} ${styles.fbcMatrix}`}>
          <div className={`${styles.funnelRow} ${styles.fbcRow} ${styles.funnelHeaderRow}`}>
            <div className={styles.fbcPin} />
            {STAGES.slice(1).flatMap((s, i, arr) => {
              const cells = [<div key={`h${i}`} className={styles.funnelHstage}>{s.label}</div>];
              if (i < arr.length - 1) cells.push(<div key={`ha${i}`} className={styles.funnelHarrow}>→</div>);
              return cells;
            })}
          </div>
          {rows.map((r) => (
            <div key={r.name} className={`${styles.funnelRow} ${styles.fbcRow}`} data-testid="fbc-row" data-city={r.name}
              data-pinned={r.pinned ? "1" : "0"}>
              <div className={`${styles.funnelPeriod} ${styles.fbcPin}`}>
                <span className={styles.funnelPeriodName}>{r.name}</span>
                {r.name === OUTSIDE && <span className={styles.funnelPeriodMeta}>{outside.join(", ")}</span>}
              </div>
              {renderRowCells(valsOf(r.c), null, inProgress, false, { offset: 1, deltas: r.deltas })}
            </div>
          ))}
        </div>
      </div>

      {/* WHAT A CITY MEANS HERE, IN VISIBLE TEXT (moved from the comparison, wording Ryan's). */}
      <p className={styles.funnelFootnote} data-testid="funnel-city-rule">
        Players are grouped by the city selected at signup, regardless of where they play.
        Downloads and download-to-signup conversion aren&rsquo;t available by city.
        {prevMonth ? ` Changes are against ${monthLabel(prevMonth)}, in percentage points.` : ""}
      </p>
    </div>
  );
}
