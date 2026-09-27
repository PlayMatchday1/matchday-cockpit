"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { fmtInt, monthLabel } from "./format";
import { canonCity } from "@/lib/reviewsDerive";
import { CANONICAL_CITIES } from "@/lib/growthAnalytics";
import { clampMonthsToNow } from "@/lib/funnelMonth";

// PART 1 (c0d3853, unchanged): a nested COHORT funnel. For the users who completed
// sign-up in a window, how many went on to play ≥1/≥3/≥5/≥10 non-cancelled
// matches EVER. Each stage a strict subset → no conversion > 100%.
//
// v1_2 restyle (presentation only): bars carry the funnel shape (each stage as a
// share of the row's registrations); numbers carry the values. No per-cell colour
// tiers, no repeated stage/"conversion" labels, no per-row arrows. The conversion
// between two cells is still b/a — placement unchanged from c0d3853.

// One-hue light→dark ramp in stage order (colour is redundant with position; the
// number is always printed). Downloads has no source → no bar.
const STAGES: { label: string; hue: string | null }[] = [
  { label: "Downloads", hue: "#c3ecd6" },
  { label: "Registrations", hue: "#93dcb9" },
  { label: "1 match", hue: "#5ecb97" },
  { label: "3 matches", hue: "#2fa774" },
  { label: "5 matches", hue: "#186b4c" },
  { label: "10 matches", hue: "var(--forest)" },
];

const ALL_CITIES = "All cities";

type Cohort = { registrations: number; played1: number; played3: number; played5: number; played10: number };

// The city-dimensioned cohort for one city. canonCity on BOTH sides — see the comment at the
// city state above for why that is not optional.
function sumCohortCity(
  rows: { m: string; city: string; registrations: number; played1: number; played3: number; played5: number; played10: number }[],
  monthSet: Set<string>,
  city: string,
): Cohort {
  const want = canonCity(city);
  const acc: Cohort = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 };
  for (const r of rows) {
    if (!monthSet.has(r.m) || canonCity(r.city) !== want) continue;
    acc.registrations += r.registrations;
    acc.played1 += r.played1;
    acc.played3 += r.played3;
    acc.played5 += r.played5;
    acc.played10 += r.played10;
  }
  return acc;
}

function sumCohort(rows: GrowthData["funnelByMonth"], monthSet: Set<string>): Cohort {
  const acc: Cohort = { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 };
  for (const r of rows) {
    if (!monthSet.has(r.m)) continue;
    acc.registrations += r.registrations;
    acc.played1 += r.played1;
    acc.played3 += r.played3;
    acc.played5 += r.played5;
    acc.played10 += r.played10;
  }
  return acc;
}

/* EVERY CHIP IS A 32px TARGET, from one function, so none can drift smaller than the others.
 * maxWidth keeps a long name from pushing the row wider than a 390px screen. */
function chipStyle(on: boolean): React.CSSProperties {
  return {
    minHeight: 32, padding: "0 10px", borderRadius: 999, cursor: "pointer",
    fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", maxWidth: "100%",
    overflow: "hidden", textOverflow: "ellipsis",
    border: `1px solid ${on ? "var(--deep-green, #003326)" : "var(--cream-line, #dfe6e2)"}`,
    background: on ? "var(--deep-green, #003326)" : "var(--card, #fff)",
    color: on ? "#fff" : "var(--mut, #5b6b63)",
  };
}

export default function PlayerFunnel({
  data,
  period,
  scopeChip,
}: {
  data: GrowthData;
  period: Period;
  scopeChip?: ReactNode;
}) {
  /* ── THE AXIS, CLAMPED TO THE MONTH CHICAGO IS ACTUALLY IN ────────────────────────────────
   * behaviorOverall runs off behaviorAxis, whose ceiling is max(nowMonth, last booked match month)
   * - and growth_play_dims carries BOOKED matches, so the axis runs into the future. This page then
   * called its last entry the current month. Measured on prod 2026-09-27: the axis ended 2026-10
   * while Chicago was in 2026-09.
   *
   * CLAMPED HERE AND NOT IN THE AXIS, because behaviorAxis has other readers (BehaviorPanel among
   * them) that may legitimately want a future month. See lib/funnelMonth for why the clamp is to the
   * calendar rather than to the data, and why it reads the business timezone.
   *
   * EVERYTHING DOWNSTREAM INHERITS IT, including the range pickers' own max: an end month there can
   * no longer be a month that has no data by definition. One clamp, not four. */
  const months = useMemo(() => clampMonthsToNow(data.behaviorOverall.map((p) => p.m)), [data.behaviorOverall]);
  /* THE RANGE COMES FROM THE PAGE AND IS NOT DUPLICATED HERE. These were local state with their own
   * two month inputs in this card's header, which meant the page had two range controls: one driving
   * the cards and one driving the bottom row of this table. Ryan: "there's already a custom range for
   * the last row" - so that one moved up and now drives both. */
  const customStart = period.start;
  const customEnd = period.end;
  /* ── CITIES ARE A SET NOW, AND THE SET DECIDES THE ROW DIMENSION ──────────────────────────
   * Ryan: "Develop an option to compare all cities or multiple cities simultaneously. Currently we
   * can only filter one city at a time."
   *
   * THE PICKER IS THE MODE CONTROL, so there is no second control to leave in the wrong position:
   *   none      the month rows, exactly as before
   *   one       the month rows filtered to it, exactly as before
   *   two-plus  one row per city over the range, plus the total they sum to
   *
   * "COMPARE THE FUNNELS" MEANS READING A COLUMN DOWN, which month rows cannot show however they
   * are filtered. Filtering to one city is a different question and keeps its old answer. */
  const [picked, setPicked] = useState<readonly string[]>([]);
  const compare = picked.length >= 2;
  const city = picked.length === 1 ? picked[0] : ALL_CITIES;

  // ONE VOCABULARY AT THE POINT OF COMPARISON. canonCity runs on BOTH sides, so a cockpit name can
  // never be compared against a normalised one. That exact mismatch made /city/reviews return zero
  // rows for DFW — "Dallas / Fort Worth" against "Dallas" — while passing in Austin, the one city
  // where the two maps agree. The dropdown is built from the same canonicalised set the rows carry.
  const cityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.funnelByMonthCity) set.add(canonCity(r.city));
    return [...set].sort();
  }, [data.funnelByMonthCity]);

  /* ── ACTIVE CITIES FIRST, THEN OUTSIDE ACTIVE CITIES, WITH COUNTS ──────────────────────────
   * Measured on prod 2026-09-27: 29,238 completed registrations. New York City 398, Warsaw 148,
   * El Paso 102.
   *
   * NOTHING IS FILTERED OUT AND THE PICKER IS THE FILTER. Anyone wanting a narrower read deselects.
   * An exclusion was built for Warsaw and reverted: it took Warsaw out of the national row as well,
   * and a page carrying a hidden exclusion is a page whose total cannot be checked against its
   * source. On the full set the city rows and the total reconcile to 29,238 exactly, which is the one
   * property that makes these rows trustworthy.
   *
   * THE GROUP IS "OUTSIDE ACTIVE CITIES", NOT "NOT FLEET CITIES", because El Paso belongs in it and
   * El Paso IS a fleet city - it is simply not running. A label naming the fleet would be wrong about
   * the one member that makes the group necessary.
   *
   * TWO WAYS IN, DELIBERATELY. A city qualifies if it is absent from CANONICAL_CITIES (New York,
   * Warsaw) OR if it is a fleet city that is not running (El Paso). The first half is automatic, so a
   * new declared spelling lands here without anyone remembering to add it; the second is a list,
   * because "running" is not a fact this data carries.
   *
   * NO "LICENSEE" LABEL. Warsaw's arrangement is not settled, and a label on the page would harden a
   * decision nobody has made. It is in the group and in the totals like the others. */
  const NOT_RUNNING = useMemo(() => new Set(["El Paso"].map((c) => canonCity(c))), []);
  const regsByCity = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data.funnelByMonthCity) {
      const c = canonCity(r.city);
      m.set(c, (m.get(c) ?? 0) + r.registrations);
    }
    return m;
  }, [data.funnelByMonthCity]);
  const { fleetCities, otherCities } = useMemo(() => {
    const fleet = new Set((CANONICAL_CITIES as readonly string[]).map((c) => canonCity(c)));
    const outside = (c: string) => !fleet.has(c) || NOT_RUNNING.has(c);
    return {
      fleetCities: cityOptions.filter((c) => !outside(c)),
      otherCities: cityOptions.filter((c) => outside(c)),
    };
  }, [cityOptions, NOT_RUNNING]);

  const toggleCity = (c: string) =>
    setPicked((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  /* THE RANGE THE NOTE AND THE CITY ROWS BOTH NAME, ordered once here so the two cannot disagree
   * about which end is which when the pickers are set backwards. */
  const range = useMemo<[string, string]>(() => {
    const lo = period.start <= period.end ? period.start : period.end;
    const hi = period.start <= period.end ? period.end : period.start;
    const inRange = months.filter((m) => m >= lo && m <= hi);
    return [inRange[0] ?? lo, inRange[inRange.length - 1] ?? hi];
  }, [period.start, period.end, months]);

  const rows = useMemo(() => {
    /* ── TWO OR MORE CITIES: ONE ROW PER CITY, PLUS THE TOTAL ────────────────────────────────
     * The month rows GIVE WAY rather than doubling up: the table has one row dimension at a time,
     * because a table that stacked city rows under month rows would invite reading a city row as a
     * subtotal of the month above it.
     *
     * THE TOTAL ROW IS THE ARITHMETIC CONTROL. City rows that do not sum to their own total is the
     * failure this table would otherwise hide, since every row looks plausible alone. It is computed
     * by summing the CITY rows, not by re-querying the national cohort, so a mismatch means the city
     * split lost or duplicated somebody rather than meaning two queries disagree.
     *
     * DOWNLOADS ARE A DASH ON EVERY CITY ROW AND ON THE TOTAL. The stores report country and region,
     * never city, so there is no honest way to split them, and the total of dashes is a dash rather
     * than the national number - which would silently compare city registrations against a national
     * denominator. So the first conversion in a city row is a dash too; the other four are real. */
    const lo0 = customStart <= customEnd ? customStart : customEnd;
    const hi0 = customStart <= customEnd ? customEnd : customStart;
    const rangeMonths = months.filter((m) => m >= lo0 && m <= hi0);
    if (compare) {
      const span = rangeMonths.length
        ? `${monthLabel(rangeMonths[0])} – ${monthLabel(rangeMonths[rangeMonths.length - 1])}`
        : "no months in range";
      const monthsOf = new Set(rangeMonths);
      const per = picked.map((c) => ({ city: c, c: sumCohortCity(data.funnelByMonthCity, monthsOf, c) }));
      const total = per.reduce((a, x) => ({
        registrations: a.registrations + x.c.registrations,
        played1: a.played1 + x.c.played1,
        played3: a.played3 + x.c.played3,
        played5: a.played5 + x.c.played5,
        played10: a.played10 + x.c.played10,
      }), { registrations: 0, played1: 0, played3: 0, played5: 0, played10: 0 });
      return [
        ...per.map(({ city: c, c: v }) => ({
          name: c, meta: span, months: rangeMonths, partial: false, isCity: true, isTotal: false,
          vals: [null, v.registrations, v.played1, v.played3, v.played5, v.played10] as (number | null)[],
          dlNote: null as string | null,
        })),
        {
          name: `Total of ${picked.length} cities`, meta: span, months: rangeMonths, partial: false,
          isCity: true, isTotal: true,
          vals: [null, total.registrations, total.played1, total.played3, total.played5, total.played10] as (number | null)[],
          dlNote: null as string | null,
        },
      ];
    }
    // "Current" is the latest data month (independent of the global period);
    // "Custom" is driven by the Custom start/end inputs.
    const end = months[months.length - 1];
    const endIdx = months.indexOf(end);
    const prev = endIdx > 0 ? months[endIdx - 1] : end;
    const year = end.slice(0, 4);
    const ytd = months.filter((m) => m.startsWith(year) && m <= end);
    const lo = customStart <= customEnd ? customStart : customEnd;
    const hi = customStart <= customEnd ? customEnd : customStart;
    const custom = months.filter((m) => m >= lo && m <= hi);
    return [
      // THE CURRENT MONTH IS AN OPEN PERIOD. Its registrations are current while its downloads
      // are short — the month is part-elapsed AND Apple's daily feed lags — so its conversion is
      // computed on a denominator that has not finished arriving. The NUMBER is fine; the
      // COMPARISON to the closed rows beneath it is not. Marked, exactly as the partner page marks
      // a month that has not closed; neither excluded nor annualised.
      { name: monthLabel(end), meta: "current month", months: [end], partial: true },
      { name: monthLabel(prev), meta: "previous month", months: [prev] },
      { name: `${year} YTD`, meta: "year to date", months: ytd },
      {
        name: custom.length ? `${monthLabel(custom[0])} – ${monthLabel(custom[custom.length - 1])}` : "—",
        meta: "custom range",
        months: custom,
      },
    ].map((r) => {
      const monthsOf = new Set(r.months);
      // ALL CITIES uses the national cohort; a single city uses the city-dimensioned one. They are
      // built from the same users in the same pass on the server, so the only difference is which
      // rows are summed.
      const c = city === ALL_CITIES
        ? sumCohort(data.funnelByMonth, monthsOf)
        : sumCohortCity(data.funnelByMonthCity, monthsOf, city);
      // Downloads = iOS App Units + Android user-installs summed over the row's months; null
      // (dash) when we have NO install data for that period — never 0.
      //
      // THIS READ BOTH STORES ONLY AFTER APPLE LANDED. It summed androidByMonth alone while the
      // KPI card above already summed both, so the same metric over the same period appeared twice
      // on one page as 2,241 and 11,307. The visible symptom was a download → registration
      // conversion of 2551.3% in the Aug 2026 row (995 registrations from 39 downloads) — a funnel
      // stage that grew 25× at its first step, on screen the whole time.
      //
      // The two stores count differently (Apple App Units = new downloads, Google user-installs =
      // user-deduped), which is why the card calls the sum not-like-for-like. That caveat now lives
      // in the page banner; it is a reason to label the number, not a reason to show a different
      // one here than the card shows.
      // THE TWO STORES DO NOT COVER THE SAME HISTORY, AND THEY NEVER WILL. Apple's monthly Sales
      // and Trends reports are retained for ONE YEAR and are not regenerated once that window
      // passes, so iOS monthly data before Aug 2025 is PERMANENTLY GONE — not unsynced, not
      // pending, not fillable. (Apple keeps YEARLY reports for ten years, so annual iOS totals for
      // 2023 and 2024 are recoverable, but with no monthly granularity, which is the granularity
      // this table is built on.) Google's begin Mar 2023.
      //
      // So the boundary below is a PERMANENT PROPERTY OF THE DATA. There is deliberately no TODO
      // here: nothing later can remove this label, and writing it as a temporary gap would invite
      // someone to try. A naive sum is genuinely both stores only from Apple's floor onward, and
      // the step up when iOS appears would otherwise read as growth when it is a second source
      // arriving.
      //
      // NOT BACKFILLED, NOT ESTIMATED, AND ROWS ARE NOT RESTRICTED to the covered window. The row
      // still shows what we have; it is LABELLED with what that number is made of. Computed per
      // row from the months it actually spans, because two of the four rows (YTD and the custom
      // range) are driven by data or by the operator and can straddle the floor at any time.
      const monthSet = new Set(r.months);
      const iosFloor = data.downloads.ios?.earliest.slice(0, 7) ?? null;
      const withIos = iosFloor ? r.months.filter((m) => m >= iosFloor) : [];
      const coverage: "both" | "partial" | "android" =
        !iosFloor || withIos.length === 0 ? "android"
        : withIos.length === r.months.length ? "both"
        : "partial";
      // DOWNLOADS CANNOT BE ATTRIBUTED TO A CITY. Apple and Google report country and region,
      // never city. With a single city selected the cell is a DASH and its conversion is a dash —
      // NOT the national figure, and never a city's registrations divided by a national
      // denominator, which would invent a conversion rate that does not exist.
      const dlMonths = city === ALL_CITIES
        ? [...data.downloads.androidByMonth, ...data.downloads.iosByMonth].filter((d) => monthSet.has(d.m))
        : [];
      const downloads = dlMonths.length ? dlMonths.reduce((a, d) => a + d.count, 0) : null;
      const dlNote =
        city !== ALL_CITIES ? null
        : downloads == null ? null
        : coverage === "both" ? null
        : coverage === "android" ? "Android only · no iOS data exists"
        : `Android only before ${monthLabel(iosFloor!)}`;
      const vals = [downloads, c.registrations, c.played1, c.played3, c.played5, c.played10] as (number | null)[];
      // Assert nested — a violation is a bug, not a number to render.
      for (let i = 2; i < vals.length; i++) {
        if ((vals[i] as number) > (vals[i - 1] as number)) {
          // eslint-disable-next-line no-console
          console.error(`Funnel not nested in "${r.name}" at stage ${i}`, vals);
        }
      }
      return { ...r, vals, dlNote, partial: "partial" in r ? Boolean(r.partial) : false,
               isCity: false, isTotal: false };
    });
  }, [data.funnelByMonth, data.funnelByMonthCity, data.downloads, city, compare, picked, customStart, customEnd, months]);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          {/* TITLE ONLY. The cohort definition, the bar's meaning, the aggregate-ratio caveat and
              the store-coverage explanation all moved to the Player Data Room, which is the page
              for how a number is made. Nothing methodological is stated twice. */}
          <div className={styles.cardTitle}>Player funnel comparison</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
          {scopeChip}
          <div className={styles.controlsRow}>
          {/* ── CHIPS, NOT A MULTI-SELECT ─────────────────────────────────────────────────────
              Ten fit, and a native <select multiple> is close to unusable on a phone: it needs a
              modifier key to pick a second option, which a touch screen does not have. Every chip is
              a real 32px target.
              THE SEPARATOR IS NOT DECORATION. Eight fleet cities, then the two declared cities that
              are not in that list, so nobody reads them as peers of Austin. */}
          <div className={styles.field} style={{ minWidth: 0 }}>
            <span className={styles.fieldLabel} id="funnelCityLabel">City</span>
            <div role="group" aria-labelledby="funnelCityLabel" data-testid="funnel-city-chips"
              style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              <button type="button" data-testid="funnel-city-chip" data-city={ALL_CITIES}
                data-on={picked.length === 0 ? "1" : "0"} aria-pressed={picked.length === 0}
                onClick={() => setPicked([])}
                style={chipStyle(picked.length === 0)}>
                {ALL_CITIES}
              </button>
              {fleetCities.map((c) => (
                <button key={c} type="button" data-testid="funnel-city-chip" data-city={c}
                  data-on={picked.includes(c) ? "1" : "0"} aria-pressed={picked.includes(c)}
                  onClick={() => toggleCity(c)} style={chipStyle(picked.includes(c))}>
                  {c}
                </button>
              ))}
              {otherCities.length > 0 && (
                <>
                  <span data-testid="funnel-city-sep" aria-hidden="true"
                    style={{ alignSelf: "stretch", width: 1, minHeight: 24, background: "var(--cream-line, #dfe6e2)", margin: "0 2px" }} />
                  <span className={styles.fieldLabel} style={{ margin: 0 }} data-testid="funnel-city-sep-label"
                    title="Cities with no active MatchDay operation. Some have never had one and some have stopped. Their registrations are real and are counted in every total on this page; deselect one to leave it out.">
                    Outside active cities
                  </span>
                  {otherCities.map((c) => (
                    <button key={c} type="button" data-testid="funnel-city-chip" data-city={c}
                      data-other="1"
                      data-on={picked.includes(c) ? "1" : "0"} aria-pressed={picked.includes(c)}
                      onClick={() => toggleCity(c)} style={chipStyle(picked.includes(c))}
                      title={`${c} has no active MatchDay operation. Its registrations are real and are counted in every total on this page.`}>
                      {c}
                      {/* THE COUNT RIDES THE CHIP, because a city name alone says nothing about
                          whether it matters. 102 against Austin's 13,297 is the context. */}
                      <i data-testid="funnel-city-count" style={{ fontStyle: "normal", opacity: 0.7, marginLeft: 5, fontSize: 11 }}>
                        {(regsByCity.get(c) ?? 0).toLocaleString()}
                      </i>
                    </button>
                  ))}
                </>
              )}
            </div>
            {/* ── WHAT THIS SELECTION MEANS, AND WHAT THE NEXT CLICK WOULD DO ─────────────────
                The picker is also the mode control, so the mode has to be legible from the picker.
                Without this line, "pick a second city and the rows change dimension" is a behaviour
                the operator discovers by accident. */}
            <p className={styles.funnelPickNote} data-testid="funnel-pick-note">
              {picked.length === 0
                ? "All cities. Pick two or more to compare them side by side."
                : picked.length === 1
                  ? `${picked[0]} only, by month. Pick another city to compare them side by side.`
                  : `${picked.length} cities, compared over ${monthLabel(range[0])} to ${monthLabel(range[1])}.`}
            </p>
          </div>
          </div>
        </div>
      </div>

      <div className={styles.funnelScroll}>
        <div className={styles.funnelMatrix}>
          {/* header: the only place a stage is named + one arrow per gap */}
          <div className={`${styles.funnelRow} ${styles.funnelHeaderRow}`}>
            <div />
            {STAGES.flatMap((s, i) => {
              const cells: ReactNode[] = [
                <div key={`h${i}`} className={styles.funnelHstage}>
                  {s.label}
                </div>,
              ];
              if (i < STAGES.length - 1) cells.push(<div key={`ha${i}`} className={styles.funnelHarrow}>→</div>);
              return cells;
            })}
          </div>

          {/* KEYED ON name, NOT meta. In compare mode every city row shares the same meta (the
              range), so keying on meta collapsed them to one row. */}
          {rows.map((r) => (
            <div key={r.name} className={styles.funnelRow} data-testid="funnel-row"
              data-city-row={r.isCity ? "1" : "0"} data-total-row={r.isTotal ? "1" : "0"}>
              <div className={styles.funnelPeriod}>
                <span className={styles.funnelPeriodName}>
                  {r.name}
                  {/* ONCE, ON THE ROW IT DESCRIBES. Clamping the current month to the real one is
                      not the same as pretending it closed, so the marker stays - it just stopped
                      being repeated across every conversion in the row. */}
                  {r.partial && (
                    <i data-testid="funnel-in-progress" className={styles.funnelInProgress}> · in progress</i>
                  )}
                </span>
                <span className={styles.funnelPeriodMeta}>{r.meta}</span>
              </div>
              {renderRowCells(r.vals, r.dlNote, r.partial, r.isCity)}
            </div>
          ))}
        </div>
      </div>

      {/* ── WHAT A CITY MEANS HERE, IN VISIBLE TEXT ─────────────────────────────────────────────
          Someone will put this table in a board deck and read a city row as local activity. Both
          facts that stop them are on the page rather than in a tooltip: the city is the one chosen
          AT SIGNUP, and downloads have no city at all. Wording is Ryan's, verbatim. */}
      <p className={styles.funnelFootnote} data-testid="funnel-city-rule">
        Players are grouped by the city selected at signup, regardless of where they play.
        Downloads and download-to-signup conversion aren&rsquo;t available by city.
      </p>
    </div>
  );
}

// Builds a row's stage + conversion cells. The conversion between stage i and i+1
// is b/a (b = vals[i+1], a = vals[i]); a dash when either is null or a is 0.
function renderRowCells(vals: (number | null)[], dlNote?: string | null, partial = false, isCity = false): ReactNode[] {
  // Bars are a share of the LARGEST stage in the row (Downloads when known, else
  // Registrations) so the funnel narrows left → right even now that Downloads is
  // a real, larger-than-registrations value.
  const base = Math.max(0, ...vals.filter((v): v is number => v != null));
  const out: ReactNode[] = [];
  vals.forEach((v, i) => {
    const isNull = v == null;
    const share = isNull || !base ? 0 : Math.min(100, (v / base) * 100);
    // ASSERT 1: a null stage renders its dashed treatment wherever it falls in
    // the row (not only column 0). isNull ⟺ funnelStageNull is applied below.
    const stageDashed = isNull;
    if (isNull && !stageDashed) throw new Error(`funnel: null stage at ${i} not dashed`);
    out.push(
      <div key={`s${i}`} data-testid="funnel-cell" data-stage={i === 0 ? "downloads" : STAGES[i].label.toLowerCase().replace(/\s+/g, "-")}
        className={`${styles.funnelStage} ${stageDashed ? styles.funnelStageNull : ""}`}>
        <span className={styles.funnelSnum}>{isNull ? "—" : fmtInt(v)}</span>
        {/* STORE COVERAGE, on the Downloads cell only. A bare combined number on a row the two
            stores do not both cover would read as one metric when it is two spliced together. */}
        {i === 0 && dlNote && (
          <span className={styles.funnelDlNote} data-testid="funnel-dl-coverage">{dlNote}</span>
        )}
        {/* ── THE DASH CARRIES ITS REASON, ON THE CELL ─────────────────────────────────────────
            The footnote says it once for the table; this says it where the dash is. A dash with no
            reason beside it reads as missing data that somebody could go and fetch, and this one
            cannot be fetched: the stores report country and region and there is no city dimension to
            split. A number here would be invented. */}
        {i === 0 && isCity && (
          <span className={styles.funnelDlNote} data-testid="funnel-why-dash">Installs carry no city</span>
        )}
        {isNull ? (
          <span className={styles.funnelSbar} style={{ background: "transparent" }} />
        ) : (
          <span className={styles.funnelSbar}>
            <span className={styles.funnelSfill} style={{ width: `${share}%`, background: STAGES[i].hue ?? "var(--forest)" }} />
          </span>
        )}
      </div>,
    );
    if (i < vals.length - 1) {
      const a = vals[i];
      const b = vals[i + 1];
      // ASSERT 2: a conversion is a dash whenever EITHER side is null OR the left
      // side is 0 — regardless of position in the row.
      const mustDash = a == null || b == null || a <= 0;
      const known = !mustDash;
      if (mustDash && known) throw new Error(`funnel: conversion at ${i} should be dashed`);
      out.push(
        <div key={`c${i}`} className={styles.funnelConv}>
          {/* ── NO "SO FAR" ON THE CONVERSIONS ────────────────────────────────────────────────
              It said the same thing five times in one row, and five copies of a caveat read as five
              separate caveats. The row says it ONCE instead, in its own label. The pill keeps its
              open-period styling and its title, so the reason is still one hover away on the number
              it applies to. */}
          <span
            className={`${styles.funnelCpill} ${known ? "" : styles.funnelCpillNone} ${partial && known ? styles.funnelCpillPartial : ""}`}
            title={partial && known ? "This month is still open and Apple's daily feed lags, so the denominator is incomplete. Not comparable to the closed rows below." : undefined}
          >
            {known ? `${((b! / a!) * 100).toFixed(1)}%` : "—"}
          </span>
        </div>,
      );
    }
  });
  return out;
}
