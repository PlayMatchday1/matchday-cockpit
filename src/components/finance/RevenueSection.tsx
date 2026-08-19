"use client";

// FINANCE › REVENUE — what came in, at three grains, over the anchor month and the prior three.
//
// ONE DERIVATION WITH COST. Every DPP figure here comes from fieldEconomics.buildFieldMonths, the
// same function /admin/finance/cost reads. The Field Cost column is that module's allocation of
// the month's canonical cost, NOT venue.cost_per_match — see the header of fieldEconomics.ts for
// why the second one cannot be used for money.
//
// FOUR MONTHS CROSS A QUARTER. The loader fetches one quarter, so the page mounts a second loader
// for the quarter owning the earlier months and merges them by month ownership. Reading those
// months out of the current quarter's 14-day pad instead would hand back a fragment wearing a
// whole month's label.
//
// THE CURRENT MONTH IS PARTIAL AND SAYS SO. Measured tiles carry the "so far" mark. Exactly one
// number on this page is an extrapolation — the pace tile — and it is named as one. Nothing else
// is grossed up to a full month.

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useMatchRangeData } from "@/lib/useMatchData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { comparisonSpan, matchRange } from "@/lib/financePeriod";
import {
  buildFieldMonths, buildMatchRows, byCity, byField, canonCity,
  COST_BASIS_LABEL, type FieldMonth, type MatchRow,
} from "@/lib/fieldEconomics";
import { cityMembershipRevenueFor, CITY_DISPLAY_ORDER, type Q2Month } from "@/lib/financeStats";
import { loadMembershipWindowsByUserId, type MembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import { isCityHidden } from "@/lib/types";
import { downloadCsv, fmtMoney, fmtInt } from "@/components/growth/format";
import DailyRevenuePace from "./DailyRevenuePace";
import s from "./financeSection.module.css";

type View = "both" | "dpp" | "membership";
type CompareWith = "prev_month" | "prev_quarter_avg" | "prev_year_avg";
type Grain = "city" | "field" | "match";

const VIEW_LABEL: Record<View, string> = {
  both: "DPP + Membership",
  dpp: "DPP only",
  membership: "Membership only",
};

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (d: Date) => {
  const h = d.getHours();
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
};
const dateLabel = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function RevenueSection() {
  // THE CHART IS THE SELECTED PERIOD PLUS THE PRIOR THREE AT THE SAME GRAIN. comparisonSpan
  // collapses those four into one synthetic span so this is a SINGLE fetch, and reports how many
  // it had to drop when the span would need more quarters than can be mounted.
  const { period, now } = useFinancePeriod();
  const { periods, span, dropped } = useMemo(() => comparisonSpan(period, 4, now), [period, now]);
  const { data, loading: primaryLoading } = useFinancePeriodData(span);
  // BOTH LOADERS GATE THE RENDER — see the same note on CostSection. useMatchData carries every
  // DPP dollar on this page; rendering before it lands printed a real-looking $0 in every tile.
  // THE SPAN, NOT THE PERIOD. This page draws the selected period plus the prior three at the
  // same grain, so its window is the span's — narrower than the whole table by two orders of
  // magnitude, and wider than the period by exactly what the chart needs.
  const { fromDate, toDate } = useMemo(() => matchRange(span.start, span.end), [span]);
  const { rows: matchRegistrations, loading: matchLoading } = useMatchRangeData(fromDate, toDate);

  // Subscription windows, for the member-vs-comp split only. useMatchData fetches without them,
  // which collapses every free spot into "member".
  const [windows, setWindows] = useState<MembershipWindowsByUserId>(() => new Map());
  useEffect(() => {
    let alive = true;
    loadMembershipWindowsByUserId(supabase)
      .then((w) => { if (alive) setWindows(w); })
      .catch(() => { /* leaves the legacy split; the column note says which is in force */ });
    return () => { alive = false; };
  }, []);

  const [view, setView] = useState<View>("both");
  const [compare, setCompare] = useState<CompareWith>("prev_month");
  const [grain, setGrain] = useState<Grain>("city");
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [fieldFilter, setFieldFilter] = useState<string>("all");

  const cities = useMemo(
    () => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)).map(canonCity),
    [],
  );

  const fieldRows = useMemo(
    () => (data ? buildFieldMonths(data, matchRegistrations, span.months) : []),
    [data, matchRegistrations, span.months],
  );

  const matchRows = useMemo(
    () => (data ? buildMatchRows(data, matchRegistrations, fieldRows, windows) : []),
    [data, matchRegistrations, fieldRows, windows],
  );

  // Filters apply to every grain and to the chart, so what the chart shows is what the table
  // adds up to. A filtered chart that silently stayed national would be the worse lie.
  const shownFields = useMemo(
    () => fieldRows.filter(
      (r) => (cityFilter === "all" || r.city === canonCity(cityFilter)) &&
             (fieldFilter === "all" || r.key === fieldFilter),
    ),
    [fieldRows, cityFilter, fieldFilter],
  );
  // ── MATCH VIEW FILTERS (the mockup's panel) ─────────────────────────────────────────────────
  //
  // EVERY FIELD HERE BACKS A COLUMN THAT EXISTS. The mockup lists thirteen; Match View renders all
  // thirteen, so none was dropped. A filter over a column the table does not show would narrow the
  // rows for a reason the reader cannot see.
  //
  // Scoped to Match View only — City and Field views keep the chips and the Field dropdown, which
  // the mockup drops entirely and which would be a real regression to lose.
  const [mf, setMf] = useState<Record<string, string>>({});
  const setMF = (k: string, v: string) => setMf((m) => ({ ...m, [k]: v }));
  const clearMatchFilters = () => setMf({});
  const matchFiltersOn = Object.values(mf).some((v) => v && v !== "all");

  const shownMatchesBase = useMemo(
    () => matchRows.filter(
      (r) => (cityFilter === "all" || r.city === canonCity(cityFilter)) &&
             (fieldFilter === "all" || r.fieldKey === fieldFilter),
    ),
    [matchRows, cityFilter, fieldFilter],
  );

  const HOUR = (d: Date) => `${((d.getHours() + 11) % 12) + 1}${d.getHours() < 12 ? "am" : "pm"}`;
  const dayName = (d: Date) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const shownMatches = useMemo(() => shownMatchesBase.filter((r) => {
    const eq = (k: string, v: string) => !mf[k] || mf[k] === "all" || mf[k] === v;
    return eq("date", ymd(r.start)) && eq("month", r.month) && eq("week", String(r.week))
      && eq("weekday", dayName(r.start)) && eq("city", r.city) && eq("location", r.location)
      && eq("hour", HOUR(r.start)) && eq("match", String(r.matchApiId))
      && eq("members", String(r.memberSpots)) && eq("free", String(r.freeSpots))
      && eq("dpps", String(r.dppSpots)) && eq("spots", String(r.totalSpots))
      && eq("dpprev", String(Math.round(r.dppRevenue)));
  }), [shownMatchesBase, mf]);

  // Options come from the rows ALREADY narrowed by the chips, so the panel never offers a value
  // that would return nothing.
  const opts = (get: (r: MatchRow) => string) =>
    [...new Set(shownMatchesBase.map(get))].filter(Boolean).sort();

  // Membership is a city fact, not a pitch fact, so the field filter cannot narrow it. When one
  // is applied the membership series is withheld rather than shown unnarrowed next to a narrowed
  // DPP series — two different scopes on one axis is how a chart starts lying.
  const membershipScoped = fieldFilter === "all";
  const membershipCities = useMemo(
    () => (cityFilter === "all" ? cities : cities.filter((c) => c === canonCity(cityFilter))),
    [cities, cityFilter],
  );

  // ONE BAR PER PERIOD, not per month — at Quarter grain a bar is a quarter, and its value is the
  // sum of that quarter's months.
  type SeriesPoint = { month: string; key: string; dpp: number; membership: number };
  const series = useMemo<SeriesPoint[]>(() => {
    if (!data) return [];
    return periods.map((p) => {
      const ms = new Set(p.months);
      const dpp = shownFields.filter((r) => ms.has(r.month)).reduce((a, r) => a + r.revenue, 0);
      let membership = 0;
      if (membershipScoped) {
        for (const c of membershipCities) for (const m of p.months) membership += cityMembershipRevenueFor(data, c, m);
      }
      return { month: p.label, key: p.key, dpp, membership };
    });
  }, [data, periods, shownFields, membershipScoped, membershipCities]);

  const valueOf = (p: { dpp: number; membership: number }) =>
    view === "dpp" ? p.dpp : view === "membership" ? p.membership : p.dpp + p.membership;

  // ── AVERAGE DAILY REVENUE, DIVIDED BY THE RIGHT NUMBER ──────────────────────────────────────
  //
  // The mockup hardcodes /31 for every month. That is wrong for April, June, September, November
  // (30) and badly wrong for February (28/29) — $66,267 for April reads $2,138 instead of $2,209.
  // The mockup is the spec for layout, not for arithmetic it gets wrong.
  //
  // A CLOSED month divides by its own length. The CURRENT month divides by days ELAPSED — dividing
  // a partial month by its full length understates the daily rate every single day of that month.
  // Which was used is stated on screen rather than left for the reader to infer.
  //
  // daysInMonthOf() is Date's own month-end arithmetic (day 0 of the next month), so February and
  // leap years fall out of it rather than out of a table someone has to maintain.
  // ACCEPTS BOTH NAMINGS. The series labels months in FULL ("June 2026") while the period keys use
  // the three-letter form ("Jun 2026"). A three-letter-only lookup returned -1 for June, July and
  // every other long name, the divisor fell through to 1, and the row printed the month's entire
  // revenue as its daily average — $68,997/day. Caught by dividing the rendered figures back out.
  const MONTH_NAMES = ["January","February","March","April","May","June",
    "July","August","September","October","November","December"];
  const daysInMonthOf = (label: string) => {
    const [mLab, yStr] = String(label ?? "").trim().split(/\s+/);
    const yr = Number(yStr);
    if (!mLab || !Number.isFinite(yr)) return 0;
    const mi = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(mLab.slice(0, 3).toLowerCase()));
    if (mi < 0) return 0;
    // Day 0 of the next month is the last day of this one — February and leap years included,
    // with no table to keep in step.
    return new Date(yr, mi + 1, 0).getDate();
  };
  // For the month in progress the period model already counts elapsed days inclusive of today.
  const divisorFor = (p: { key: string; month: string }) =>
    p.key === period.key && period.isCurrent
      ? { days: Math.max(1, period.elapsedDays), basis: "elapsed" as const }
      : { days: Math.max(1, daysInMonthOf(p.month)), basis: "full" as const };

  const SUMMARY_ROWS = [
    { key: "total", label: "Total revenue",
      render: (p: SeriesPoint) => fmtMoney(p.dpp + p.membership) },
    { key: "dpp", label: "DPP",
      render: (p: SeriesPoint) => fmtMoney(p.dpp) },
    { key: "membership", label: "Membership",
      render: (p: SeriesPoint) => (membershipScoped ? fmtMoney(p.membership) : "—") },
    { key: "avgdaily", label: "Average daily revenue",
      render: (p: SeriesPoint) => {
        const { days, basis } = divisorFor(p);
        return (
          <>
            {fmtMoney((p.dpp + p.membership) / days)}
            <i className={s.soFar} data-testid="avg-daily-basis">
              {basis === "elapsed" ? `÷ ${days} elapsed` : `÷ ${days} days`}
            </i>
          </>
        );
      } },
  ];

  // The count beside the Breakdown segments, in the units of the view being shown.
  const breakdownCount = useMemo(() => {
    if (grain === "match") return `${shownMatches.length} ${shownMatches.length === 1 ? "match" : "matches"}`;
    const n = (grain === "city" ? byCity(shownFields) : byField(shownFields)).size;
    return `${n} ${grain === "city" ? (n === 1 ? "city" : "cities") : (n === 1 ? "field" : "fields")}`;
  }, [grain, shownFields, shownMatches]);

  const anchorPoint = series.find((p) => p.key === period.key) ?? { month: period.label, key: period.key, dpp: 0, membership: 0 };
  const anchorValue = valueOf(anchorPoint);

  // ELAPSED AND TOTAL COME FROM THE PERIOD, at whatever grain it is — 17 of 31 for August, 48 of
  // 92 for Q3. Computing them here from the day of the month would have been right only at Month
  // grain and quietly wrong at the other two.
  const daysInMonth = period.totalDays;
  const daysElapsed = period.elapsedDays;
  const avgDaily = anchorValue / Math.max(1, daysElapsed);
  const pace = avgDaily * daysInMonth;

  const topCity = useMemo(() => {
    if (!data) return null;
    let best: { city: string; value: number } | null = null;
    for (const c of cities) {
      if (cityFilter !== "all" && c !== canonCity(cityFilter)) continue;
      const ms = new Set(period.months);
      const dpp = shownFields.filter((r) => ms.has(r.month) && r.city === c).reduce((a, r) => a + r.revenue, 0);
      let membership = 0;
      if (membershipScoped) for (const m of period.months) membership += cityMembershipRevenueFor(data, c, m);
      const value = valueOf({ dpp, membership });
      if (value <= 0) continue;
      if (!best || value > best.value) best = { city: c, value };
    }
    return best;
  }, [data, cities, cityFilter, shownFields, period, membershipScoped, view]);

  // ===== Comparison basis =====
  // THE OPTIONS FOLLOW THE GRAIN. Under the old quarter-only control these were fixed as
  // "previous month" and "previous quarter avg"; with three grains a fixed word would lie — at
  // Quarter grain the previous bar IS a quarter. So the comparison is stated in periods and the
  // label names the actual bar it used.
  //
  // A PARTIAL PERIOD IS COMPARED ON PACE, not on its part-period total, or every mid-month visit
  // reports a collapse. The sub-line says which of the two is being compared.
  const comparison = useMemo((): { label: string; basis: number | null; note: string } => {
    if (compare === "prev_year_avg") {
      return { label: "Previous year", basis: null, note: "no comparable year on record" };
    }
    const idx = series.findIndex((p) => p.key === period.key);
    if (compare === "prev_month") {
      const prev = idx > 0 ? series[idx - 1] : undefined;
      return {
        label: prev ? prev.month : "Previous period",
        basis: prev ? valueOf(prev) : null,
        note: prev ? "" : `nothing before this on record`,
      };
    }
    const priors = idx > 0 ? series.slice(0, idx) : [];
    if (priors.length === 0) return { label: "Prior periods avg", basis: null, note: "nothing before this on record" };
    return {
      label: `${priors.length} prior ${priors.length === 1 ? "period" : "periods"} avg`,
      basis: priors.reduce((a, p) => a + valueOf(p), 0) / priors.length,
      note: "",
    };
  }, [compare, series, period, view]);

  const comparedValue = period.isCurrent ? pace : anchorValue;
  const delta =
    comparison.basis && comparison.basis > 0 ? (comparedValue - comparison.basis) / comparison.basis : null;

  if (matchLoading || (primaryLoading && !data)) {
    return <div className={s.empty}>Loading…</div>;
  }
  if (!data) return <div className={s.empty}>No finance data for this period.</div>;

  const fieldOptions = [...byField(fieldRows).values()]
    .map((g) => ({ key: g[0].key, label: g[0].field, city: g[0].city }))
    .filter((f) => cityFilter === "all" || f.city === canonCity(cityFilter))
    .sort((a, b) => a.label.localeCompare(b.label));

  const filtersOn = cityFilter !== "all" || fieldFilter !== "all";
  const clearFilters = () => { setCityFilter("all"); setFieldFilter("all"); };

  const max = Math.max(1, ...series.map((p) => valueOf(p)));

  function exportChart() {
    downloadCsv(`matchday-revenue-${period.key}.csv`, [
      ["Period", "DPP revenue", "Membership revenue", "Total"],
      ...series.map((p) => [p.month, p.dpp.toFixed(2), membershipScoped ? p.membership.toFixed(2) : "", (p.dpp + p.membership).toFixed(2)]),
    ]);
  }

  function exportTable() {
    if (grain === "match") {
      downloadCsv(`matchday-revenue-matches-${period.key}.csv`, [
        ["Date", "Month", "Week", "Weekday", "City", "Location", "Hour", "Match", "Members Code", "Free Code", "DPP's", "Total Spots", "DPP Revenue", "Field Cost"],
        ...shownMatches.map((r) => [
          dateLabel(r.start), r.month, r.week, WEEKDAY[r.start.getDay()], r.city, r.location,
          hourLabel(r.start), 1, r.memberSpots, r.freeSpots, r.dppSpots, r.totalSpots,
          r.dppRevenue.toFixed(2), r.fieldCost == null ? "" : r.fieldCost.toFixed(2),
        ]),
      ]);
      return;
    }
    const grouped = grain === "city" ? byCity(shownFields) : byField(shownFields);
    downloadCsv(`matchday-revenue-${grain}-${period.key}.csv`, [
      ["Month", grain === "city" ? "City" : "Location", "Billing", "Matches", "DPP Revenue", "Private Rental", "Field Cost"],
      ...[...grouped.values()].flatMap((rows) =>
        rows.map((r) => [
          r.month, grain === "city" ? r.city : r.field, COST_BASIS_LABEL[r.basis], r.matches,
          (r.revenue - r.privateRental).toFixed(2), r.privateRental.toFixed(2),
          r.cost == null ? "" : r.cost.toFixed(2),
        ]),
      ),
    ]);
  }

  return (
    <div className={s.wrap} data-testid="finance-revenue">
      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Compare with</span>
          <div className={s.seg}>
            {(["prev_month", "prev_quarter_avg", "prev_year_avg"] as const).map((o) => {
              // The finance record begins March 2026 — fin_revenue holds two sparse months across
              // the whole of 2025 ($7,711 between them) and nothing before. A year-ago figure
              // would compare this month against an empty ledger, so the control is disabled and
              // says why rather than rendering a −100%.
              const off = o === "prev_year_avg";
              return (
                <button key={o} type="button" disabled={off}
                  title={off ? "Disabled: the finance record starts March 2026, so there is no comparable month a year back." : undefined}
                  className={compare === o ? s.on : ""} onClick={() => !off && setCompare(o)}>
                  {o === "prev_month" ? "Previous period" : o === "prev_quarter_avg" ? "Prior periods avg" : "Previous year"}
                </button>
              );
            })}
          </div>
        </div>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>View</span>
          <div className={s.seg}>
            {(["both", "dpp", "membership"] as const).map((o) => (
              <button key={o} type="button" className={view === o ? s.on : ""} onClick={() => setView(o)}>
                {VIEW_LABEL[o]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={s.tiles}>
        <Tile
          label={`${period.label} revenue`}
          value={fmtMoney(anchorValue)}
          partial={period.isCurrent}
          sub={
            comparison.basis == null
              ? `vs ${comparison.label} — ${comparison.note}`
              : `${delta == null ? "—" : (delta >= 0 ? "+" : "") + (delta * 100).toFixed(1) + "%"} vs ${comparison.label}` +
                (period.isCurrent ? " (pace compared, not part-period)" : "")
          }
        />
        <Tile
          label="Avg daily revenue"
          value={fmtMoney(avgDaily)}
          partial={period.isCurrent}
          sub={`${fmtMoney(anchorValue)} over ${daysElapsed} ${daysElapsed === 1 ? "day" : "days"}`}
        />
        <Tile
          label="Top revenue city"
          value={topCity ? topCity.city : "—"}
          partial={period.isCurrent && topCity != null}
          sub={topCity ? fmtMoney(topCity.value) : "no revenue recorded this month"}
        />
        <Tile
          label="Pace to month end"
          value={period.isCurrent ? fmtMoney(pace) : fmtMoney(anchorValue)}
          sub={
            period.isCurrent
              ? `PROJECTED — ${fmtMoney(avgDaily)}/day × ${daysInMonth} days. The only grossed-up number here.`
              : "Period closed — this is the actual, not a projection."
          }
        />
      </div>

      {/* DAILY PACE, above the period bars. The bars answer "how did the month end"; this answers
          "are we ahead of last month, today" — which is the question that can still be acted on.
          The existing bar chart below is untouched. */}
      <DailyRevenuePace />

      <div className={s.card}>
        <div className={s.cardHead}>
          <div>
            <span className={s.cardTitle}>Matchday revenue</span>
            <div className={s.cardSub} data-testid="revenue-summary-sub">
              Current month and prior three months · oldest to newest
            </div>
          </div>
          {/* ONE Export, ghost, in the table head — the mockup has one and the page had two. */}
          <button type="button" className={s.btn} onClick={exportChart}>Export</button>
        </div>

        {/* THE FOUR-COLUMN SUMMARY replaces the stacked bar chart, which is not in the mockup and
            is gone rather than hidden behind a toggle. Four months across, oldest left; four
            concept rows down. The bars showed the same two numbers with less precision and no
            room for the third and fourth rows. */}
        <div className={s.tblWrap}>
          <table className={s.tbl} data-testid="revenue-summary">
            <thead>
              <tr>
                <th className="l">&nbsp;</th>
                {series.map((p) => (
                  <th key={p.key} data-testid="revenue-summary-month">
                    {p.month}
                    {p.key === period.key && period.isCurrent && <i className={s.soFar}>so far</i>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map((row) => (
                <tr key={row.key} data-testid="revenue-summary-row" data-row={row.key}>
                  <td className="l">{row.label}</td>
                  {series.map((p) => (
                    <td key={p.key} data-testid={`sum-${row.key}`} data-month={p.key}>
                      {row.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* BREAKDOWN LIVES IN THE CARD, directly under the table, as the mockup places it — it was
            floating below in its own row. The count sits beside the segments. */}
        <div className={s.ctrlRow}>
          <div className={s.ctrlGroup}>
            <span className={s.ctrlLab}>Breakdown</span>
            <div className={s.seg} role="group" aria-label="Breakdown">
              {(["city", "field", "match"] as const).map((g) => (
                <button key={g} type="button" data-testid={`breakdown-${g}`}
                  aria-pressed={grain === g}
                  className={grain === g ? s.on : ""} onClick={() => setGrain(g)}>
                  {g === "city" ? "City View" : g === "field" ? "Field View" : "Match View"}
                </button>
              ))}
            </div>
            <span className={s.ctrlLab} data-testid="breakdown-count">{breakdownCount}</span>
          </div>
        </div>

        <div className={s.legend}>
          {!membershipScoped && <span>Membership withheld — it is a city figure and cannot be narrowed to one pitch.</span>}
          {/* A table that quietly drew fewer months than asked would read as "this is all there
              was". It says so instead. */}
          {dropped > 0 && (
            <span data-testid="revenue-span-dropped">
              {dropped} earlier {dropped === 1 ? "period" : "periods"} not drawn — the span would
              need more quarters than can be loaded at once.
            </span>
          )}
          {periods.length < 4 && dropped === 0 && (
            <span data-testid="revenue-span-short">
              {periods.length} of 4 {periods.length === 1 ? "period" : "periods"} — the record does not go back further.
            </span>
          )}
        </div>
      </div>

      {/* THE CHIPS AND THE FIELD DROPDOWN STAY. The mockup replaces them with a Match-View-only
          filter panel and leaves City and Field views unfilterable — that would be a real
          regression on a working control, so they are kept and the panel is added alongside. */}
      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>City</span>
          <div className={s.seg}>
            <button type="button" className={cityFilter === "all" ? s.on : ""} onClick={() => { setCityFilter("all"); setFieldFilter("all"); }}>All</button>
            {cities.map((c) => (
              <button key={c} type="button" className={cityFilter === c ? s.on : ""} onClick={() => { setCityFilter(c); setFieldFilter("all"); }}>{c}</button>
            ))}
          </div>
        </div>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Field</span>
          <select
            className={s.btn}
            value={fieldFilter}
            onChange={(e) => setFieldFilter(e.target.value)}
            aria-label="Field"
          >
            <option value="all">All fields</option>
            {fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        <div className={s.ctrlGroup}>
          <button type="button" className={s.btn} onClick={clearFilters} disabled={!filtersOn}>Clear filters</button>
        </div>
      </div>

      {/* THE MOCKUP'S MATCH FILTER PANEL — Match View only. Thirteen fields, each backing a column
          Match View actually renders, so nothing narrows the table for an invisible reason. */}
      {grain === "match" && (
        <div className={s.card} data-testid="match-filter-panel">
          <div className={s.filterGrid}>
            {([
              ["date", "Date", () => opts((r) => ymd(r.start))],
              ["month", "Month", () => opts((r) => r.month)],
              ["week", "Week", () => opts((r) => String(r.week))],
              ["weekday", "Weekday", () => opts((r) => dayName(r.start))],
              ["city", "City", () => opts((r) => r.city)],
              ["location", "Location", () => opts((r) => r.location)],
              ["hour", "Hour", () => opts((r) => HOUR(r.start))],
              ["match", "Match", () => opts((r) => String(r.matchApiId))],
              ["members", "Members Code", () => opts((r) => String(r.memberSpots))],
              ["free", "Free Code", () => opts((r) => String(r.freeSpots))],
              ["dpps", "DPP\u2019s", () => opts((r) => String(r.dppSpots))],
              ["spots", "Total Spots", () => opts((r) => String(r.totalSpots))],
              ["dpprev", "DPP Revenue", () => opts((r) => String(Math.round(r.dppRevenue)))],
            ] as [string, string, () => string[]][]).map(([k, lab, get]) => (
              <label key={k} className={s.filterField}>
                <span>{lab}</span>
                <select className={s.sel} data-testid={`mf-${k}`} value={mf[k] ?? "all"}
                  onChange={(e) => setMF(k, e.target.value)}>
                  <option value="all">All</option>
                  {get().map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className={s.ctrlGroup}>
            <button type="button" className={s.btn} data-testid="mf-clear"
              onClick={clearMatchFilters} disabled={!matchFiltersOn}>Clear filters</button>
            <span className={s.ctrlLab}>{shownMatches.length} of {shownMatchesBase.length} matches</span>
          </div>
        </div>
      )}

      {grain === "match" ? (
        <MatchTable rows={shownMatches} />
      ) : (
        <GroupTable rows={shownFields} grain={grain} month={period.months[period.months.length - 1] ?? ""}
          membershipOf={(c) => (data ? cityMembershipRevenueFor(data, c, period.months[period.months.length - 1] ?? "") : 0)}
          membershipScoped={membershipScoped} />
      )}
    </div>
  );
}

function Tile({ label, value, sub, partial }: { label: string; value: string; sub: string; partial?: boolean }) {
  return (
    <div className={s.tile}>
      <span className={s.tileLab}>{label}</span>
      <span className={s.tileVal} data-testid="revenue-tile-value">
        {value}
        {partial && <i className={s.soFar} data-testid="revenue-tile-partial">so far</i>}
      </span>
      <span className={s.tileSub}>{sub}</span>
    </div>
  );
}

function BillingMark({ basis, unknown }: { basis: FieldMonth["basis"]; unknown: boolean }) {
  const cls = unknown ? s.btNone : basis === "profit_share" ? s.btShare : basis === "monthly_flat" ? s.btFlat : "";
  return <span className={`${s.bt} ${cls}`} data-testid="billing-mark">{unknown ? "No cost on file" : COST_BASIS_LABEL[basis]}</span>;
}

// CITY / FIELD VIEW — ranked, for the month the period is on, to the mockup's column set.
//
// SCOPED TO ONE MONTH, which is what every "(in month)" header says. The previous table paired
// each thing with each month and ranked by DPP across the span; that answered a different question
// and had none of the derived columns.
//
// EVERY DERIVED COLUMN IS COMPUTED FROM THE TWO IT DIVIDES, so a reader can check them by hand:
// avg/venue = total ÷ venues, avg/match = total ÷ matches, mix = membership ÷ total. The match
// denominator is guarded — a city with revenue and no matches would otherwise print Infinity.
function GroupTable({ rows, grain, month, membershipOf, membershipScoped }: {
  rows: FieldMonth[]; grain: "city" | "field"; month: Q2Month;
  membershipOf: (city: string) => number; membershipScoped: boolean;
}) {
  const scoped = rows.filter((r) => r.month === month);
  if (scoped.length === 0) return <div className={s.empty}>No rows for this selection.</div>;

  const keyed = new Map<string, { label: string; city: string; venues: Set<string>; matches: number; dpp: number }>();
  for (const r of scoped) {
    const label = grain === "city" ? r.city : r.field;
    let e = keyed.get(label);
    if (!e) { e = { label, city: r.city, venues: new Set(), matches: 0, dpp: 0 }; keyed.set(label, e); }
    e.venues.add(r.field);
    e.matches += r.matches;
    e.dpp += r.revenue;
  }
  // Membership is a CITY figure. In field view it cannot be narrowed to one pitch, so it is shown
  // as — rather than split on a guess.
  const list = [...keyed.values()].map((e) => {
    const membership = grain === "city" && membershipScoped ? membershipOf(e.city) : 0;
    const total = e.dpp + membership;
    return { ...e, membership, total, venueCount: e.venues.size };
  }).sort((a, b) => b.total - a.total);

  const T = list.reduce((a, r) => ({
    venues: a.venues + r.venueCount, matches: a.matches + r.matches,
    total: a.total + r.total, dpp: a.dpp + r.dpp, membership: a.membership + r.membership,
  }), { venues: 0, matches: 0, total: 0, dpp: 0, membership: 0 });
  const showMembership = grain === "city" && membershipScoped;
  const pct = (n: number, d: number) => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;

  return (
    <div className={s.card}>
      <div className={s.tblWrap}>
        <table className={s.tbl} data-testid="revenue-group-table">
          <thead>
            <tr>
              <th className="l">{grain === "city" ? "City" : "Location"}</th>
              <th>Venues</th>
              <th>Matches</th>
              <th>Total revenue <i className={s.mut}>(in month)</i></th>
              <th>Avg revenue / venue</th>
              <th>Avg revenue / match</th>
              <th>DPP revenue <i className={s.mut}>(in month)</i></th>
              <th>Membership revenue <i className={s.mut}>(in month)</i></th>
              <th>Member mix <i className={s.mut}>(in month)</i></th>
            </tr>
          </thead>
          <tbody>
            {list.map((r, i) => (
              <tr key={r.label} data-testid="revenue-group-row" data-label={r.label}>
                <td className="l"><span className={s.rank}>{i + 1}</span>{r.label}</td>
                <td data-testid="gt-venues">{fmtInt(r.venueCount)}</td>
                <td data-testid="gt-matches">{fmtInt(r.matches)}</td>
                <td data-testid="gt-total">{fmtMoney(r.total)}</td>
                <td data-testid="gt-avgvenue">{fmtMoney(r.total / Math.max(1, r.venueCount))}</td>
                {/* guarded: revenue with zero matches must not print Infinity */}
                <td data-testid="gt-avgmatch">{fmtMoney(r.total / Math.max(1, r.matches))}</td>
                <td data-testid="gt-dpp">{fmtMoney(r.dpp)}</td>
                <td data-testid="gt-member">{showMembership ? fmtMoney(r.membership) : "—"}</td>
                <td data-testid="gt-mix">{showMembership ? pct(r.membership, r.total) : "—"}</td>
              </tr>
            ))}
            <tr className={s.tot}>
              <td className="l">Total</td>
              <td>{fmtInt(T.venues)}</td>
              <td>{fmtInt(T.matches)}</td>
              <td data-testid="gt-tot-total">{fmtMoney(T.total)}</td>
              <td>{fmtMoney(T.total / Math.max(1, T.venues))}</td>
              <td>{fmtMoney(T.total / Math.max(1, T.matches))}</td>
              <td data-testid="gt-tot-dpp">{fmtMoney(T.dpp)}</td>
              <td data-testid="gt-tot-member">{showMembership ? fmtMoney(T.membership) : "—"}</td>
              <td>{showMembership ? pct(T.membership, T.total) : "—"}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MatchTable({ rows }: { rows: MatchRow[] }) {
  if (rows.length === 0) return <div className={s.empty}>No matches for this selection.</div>;
  const T = rows.reduce(
    (a, r) => ({
      member: a.member + r.memberSpots, free: a.free + r.freeSpots, dpp: a.dpp + r.dppSpots,
      total: a.total + r.totalSpots, rev: a.rev + r.dppRevenue,
      cost: a.cost + (r.fieldCost ?? 0), unknown: a.unknown + (r.fieldCost == null ? 1 : 0),
    }),
    { member: 0, free: 0, dpp: 0, total: 0, rev: 0, cost: 0, unknown: 0 },
  );
  return (
    <div className={s.card}>
      <div className={s.tblWrap}>
        <table className={`${s.tbl} ${s.wide}`} data-testid="revenue-match-table">
          <thead>
            <tr>
              <th className="l">Date</th>
              <th className="l">Month</th>
              <th>Week</th>
              <th className="l">Weekday</th>
              <th className="l">City</th>
              <th className="l">Location</th>
              <th className="l">Hour</th>
              <th>Match</th>
              <th>Members Code</th>
              <th>Free Code</th>
              <th>DPP&rsquo;s</th>
              <th>Total Spots</th>
              <th>DPP Revenue</th>
              <th>Field Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.matchApiId} data-testid="revenue-match-row">
                <td className="l">{dateLabel(r.start)}</td>
                <td className="l">{r.month}</td>
                <td>{r.week}</td>
                <td className="l">{WEEKDAY[r.start.getDay()]}</td>
                <td className="l">{r.city}</td>
                <td className="l">{r.location}</td>
                <td className="l">{hourLabel(r.start)}</td>
                <td>1</td>
                <td>{fmtInt(r.memberSpots)}</td>
                <td>{fmtInt(r.freeSpots)}</td>
                <td>{fmtInt(r.dppSpots)}</td>
                <td>{fmtInt(r.totalSpots)}</td>
                <td>{fmtMoney(r.dppRevenue)}</td>
                <td className={r.fieldCost == null ? s.mut : s.neg} data-testid="revenue-match-cost">
                  {r.fieldCost == null ? "—" : fmtMoney(r.fieldCost)}
                </td>
              </tr>
            ))}
            <tr className={s.tot}>
              <td className="l">Total</td>
              <td className="l">—</td>
              <td>—</td>
              <td className="l">—</td>
              <td className="l">—</td>
              <td className="l">—</td>
              <td className="l">—</td>
              <td>{fmtInt(rows.length)}</td>
              <td>{fmtInt(T.member)}</td>
              <td>{fmtInt(T.free)}</td>
              <td>{fmtInt(T.dpp)}</td>
              <td>{fmtInt(T.total)}</td>
              <td>{fmtMoney(T.rev)}</td>
              <td className={s.neg}>{T.unknown === rows.length ? "—" : fmtMoney(T.cost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
