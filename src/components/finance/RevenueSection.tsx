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
import { useFinanceData, useFinanceDataForQuarter } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import { mergeFinanceDataByMonth } from "@/lib/financeDataMerge";
import {
  buildFieldMonths, buildMatchRows, byCity, byField, canonCity, revenueWindow,
  COST_BASIS_LABEL, type FieldMonth, type MatchRow,
} from "@/lib/fieldEconomics";
import { cityMembershipRevenueFor, CITY_DISPLAY_ORDER, type Q2Month } from "@/lib/financeStats";
import { loadMembershipWindowsByUserId, type MembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import { isCityHidden } from "@/lib/types";
import { downloadCsv, fmtMoney, fmtInt } from "@/components/growth/format";
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
  const quarter = useFinanceQuarter();
  const now = useMemo(() => new Date(), []);
  const win = useMemo(() => revenueWindow(quarter, now), [quarter, now]);

  // Two loaders, one cache. When the window needs no earlier quarter this resolves to the same
  // key as the primary and costs nothing.
  const primary = useFinanceData();
  const secondary = useFinanceDataForQuarter(win.prevQuarter ?? quarter);
  const data = useMemo(
    () => mergeFinanceDataByMonth(primary.data, win.prevQuarter ? secondary.data : null, win.prevMonths),
    [primary.data, secondary.data, win.prevQuarter, win.prevMonths],
  );
  // BOTH LOADERS GATE THE RENDER — see the same note on CostSection. useMatchData carries every
  // DPP dollar on this page; rendering before it lands printed a real-looking $0 in every tile.
  const { rows: matchRegistrations, loading: matchLoading } = useMatchData();

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
    () => (data ? buildFieldMonths(data, matchRegistrations, win.months) : []),
    [data, matchRegistrations, win.months],
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
  const shownMatches = useMemo(
    () => matchRows.filter(
      (r) => (cityFilter === "all" || r.city === canonCity(cityFilter)) &&
             (fieldFilter === "all" || r.fieldKey === fieldFilter),
    ),
    [matchRows, cityFilter, fieldFilter],
  );

  // Membership is a city fact, not a pitch fact, so the field filter cannot narrow it. When one
  // is applied the membership series is withheld rather than shown unnarrowed next to a narrowed
  // DPP series — two different scopes on one axis is how a chart starts lying.
  const membershipScoped = fieldFilter === "all";
  const membershipCities = useMemo(
    () => (cityFilter === "all" ? cities : cities.filter((c) => c === canonCity(cityFilter))),
    [cities, cityFilter],
  );

  const series = useMemo(() => {
    if (!data) return [];
    return win.months.map((month) => {
      const dpp = shownFields.filter((r) => r.month === month).reduce((a, r) => a + r.revenue, 0);
      let membership = 0;
      if (membershipScoped) {
        for (const c of membershipCities) membership += cityMembershipRevenueFor(data, c, month);
      }
      return { month, dpp, membership };
    });
  }, [data, win.months, shownFields, membershipScoped, membershipCities]);

  const valueOf = (p: { dpp: number; membership: number }) =>
    view === "dpp" ? p.dpp : view === "membership" ? p.membership : p.dpp + p.membership;

  const anchorPoint = series.find((p) => p.month === win.anchor) ?? { month: win.anchor, dpp: 0, membership: 0 };
  const anchorValue = valueOf(anchorPoint);

  // Elapsed days drive both the daily average and the pace. For a completed anchor the whole
  // month has elapsed, so the two collapse into the same number — which is correct.
  const anchorMonthInfo = useMemo(() => {
    const m = quarter.months.find((x) => x.key === win.anchor);
    return m ?? quarter.months[quarter.months.length - 1];
  }, [quarter, win.anchor]);
  const daysInMonth = anchorMonthInfo.daysInMonth;
  const daysElapsed = win.anchorIsPartial ? Math.max(1, now.getDate()) : daysInMonth;
  const avgDaily = anchorValue / daysElapsed;
  const pace = avgDaily * daysInMonth;

  const topCity = useMemo(() => {
    if (!data) return null;
    let best: { city: string; value: number } | null = null;
    for (const c of cities) {
      if (cityFilter !== "all" && c !== canonCity(cityFilter)) continue;
      const dpp = shownFields.filter((r) => r.month === win.anchor && r.city === c).reduce((a, r) => a + r.revenue, 0);
      const membership = membershipScoped ? cityMembershipRevenueFor(data, c, win.anchor) : 0;
      const value = valueOf({ dpp, membership });
      if (value <= 0) continue;
      if (!best || value > best.value) best = { city: c, value };
    }
    return best;
  }, [data, cities, cityFilter, shownFields, win.anchor, membershipScoped, view]);

  // ===== Comparison basis =====
  // A partial anchor is compared on PACE, not on its part-month total — otherwise every mid-month
  // visit reports a collapse. The sub-line says which of the two is being compared.
  const prevQuarterRows = useMemo(() => {
    if (!win.prevQuarter || !secondary.data) return null;
    return buildFieldMonths(secondary.data, matchRegistrations, win.prevQuarter.months.map((m) => m.key));
  }, [win.prevQuarter, secondary.data, matchRegistrations]);

  const comparison = useMemo((): { label: string; basis: number | null; note: string } => {
    if (compare === "prev_year_avg") {
      return { label: "Previous year avg", basis: null, note: "no comparable year on record" };
    }
    if (compare === "prev_month") {
      const idx = win.months.indexOf(win.anchor);
      const prev = idx > 0 ? series.find((p) => p.month === win.months[idx - 1]) : undefined;
      return {
        label: win.months[idx - 1] ?? "Previous month",
        basis: prev ? valueOf(prev) : null,
        note: prev ? "" : "the month before the window",
      };
    }
    if (!win.prevQuarter || !prevQuarterRows || !secondary.data) {
      return { label: "Previous quarter avg", basis: null, note: "no prior quarter on record" };
    }
    const ms = win.prevQuarter.months.map((m) => m.key);
    let total = 0;
    for (const month of ms) {
      const dpp = prevQuarterRows
        .filter((r) => r.month === month && (cityFilter === "all" || r.city === canonCity(cityFilter)) && (fieldFilter === "all" || r.key === fieldFilter))
        .reduce((a, r) => a + r.revenue, 0);
      let membership = 0;
      if (membershipScoped) for (const c of membershipCities) membership += cityMembershipRevenueFor(secondary.data, c, month);
      total += valueOf({ dpp, membership });
    }
    return { label: `${win.prevQuarter.label} avg`, basis: total / ms.length, note: "" };
  }, [compare, win, series, prevQuarterRows, secondary.data, cityFilter, fieldFilter, membershipScoped, membershipCities, view]);

  const comparedValue = win.anchorIsPartial ? pace : anchorValue;
  const delta =
    comparison.basis && comparison.basis > 0 ? (comparedValue - comparison.basis) / comparison.basis : null;

  const loading = primary.loading || (win.prevQuarter != null && secondary.loading);
  if (matchLoading || (loading && !data)) {
    return <div className={s.empty}>Loading…</div>;
  }
  if (!data) return <div className={s.empty}>No finance data for this quarter.</div>;

  const fieldOptions = [...byField(fieldRows).values()]
    .map((g) => ({ key: g[0].key, label: g[0].field, city: g[0].city }))
    .filter((f) => cityFilter === "all" || f.city === canonCity(cityFilter))
    .sort((a, b) => a.label.localeCompare(b.label));

  const filtersOn = cityFilter !== "all" || fieldFilter !== "all";
  const clearFilters = () => { setCityFilter("all"); setFieldFilter("all"); };

  const max = Math.max(1, ...series.map((p) => valueOf(p)));

  function exportChart() {
    downloadCsv(`matchday-revenue-${win.anchor.replace(" ", "-")}.csv`, [
      ["Month", "DPP revenue", "Membership revenue", "Total"],
      ...series.map((p) => [p.month, p.dpp.toFixed(2), membershipScoped ? p.membership.toFixed(2) : "", (p.dpp + p.membership).toFixed(2)]),
    ]);
  }

  function exportTable() {
    if (grain === "match") {
      downloadCsv(`matchday-revenue-matches-${win.anchor.replace(" ", "-")}.csv`, [
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
    downloadCsv(`matchday-revenue-${grain}-${win.anchor.replace(" ", "-")}.csv`, [
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
                  {o === "prev_month" ? "Previous month" : o === "prev_quarter_avg" ? "Previous quarter avg" : "Previous year avg"}
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
          label={`${win.anchor} revenue`}
          value={fmtMoney(anchorValue)}
          partial={win.anchorIsPartial}
          sub={
            comparison.basis == null
              ? `vs ${comparison.label} — ${comparison.note}`
              : `${delta == null ? "—" : (delta >= 0 ? "+" : "") + (delta * 100).toFixed(1) + "%"} vs ${comparison.label}` +
                (win.anchorIsPartial ? " (pace compared, not part-month)" : "")
          }
        />
        <Tile
          label="Avg daily revenue"
          value={fmtMoney(avgDaily)}
          partial={win.anchorIsPartial}
          sub={`${fmtMoney(anchorValue)} over ${daysElapsed} ${daysElapsed === 1 ? "day" : "days"}`}
        />
        <Tile
          label="Top revenue city"
          value={topCity ? topCity.city : "—"}
          partial={win.anchorIsPartial && topCity != null}
          sub={topCity ? fmtMoney(topCity.value) : "no revenue recorded this month"}
        />
        <Tile
          label="Pace to month end"
          value={win.anchorIsPartial ? fmtMoney(pace) : fmtMoney(anchorValue)}
          sub={
            win.anchorIsPartial
              ? `PROJECTED — ${fmtMoney(avgDaily)}/day × ${daysInMonth} days. The only grossed-up number here.`
              : "Month closed — this is the actual, not a projection."
          }
        />
      </div>

      <div className={s.card}>
        <div className={s.cardHead}>
          <span className={s.cardTitle}>Matchday revenue</span>
          <button type="button" className={s.btn} onClick={exportChart}>Export</button>
        </div>
        <div className={s.chart}>
          {series.map((p) => {
            const total = valueOf(p);
            const dppH = view === "membership" ? 0 : (p.dpp / max) * 150;
            const memH = view === "dpp" || !membershipScoped ? 0 : (p.membership / max) * 150;
            return (
              <div key={p.month} className={s.col}>
                <span className={s.colVal}>{fmtMoney(total)}</span>
                <div className={s.stack}>
                  {dppH > 0 && <div className={s.barA} style={{ height: `${dppH}px` }} />}
                  {memH > 0 && <div className={s.barB} style={{ height: `${memH}px` }} />}
                </div>
                <span className={s.colLab} data-testid="revenue-chart-month">
                  {p.month}
                  {p.month === win.anchor && win.anchorIsPartial && <i className={s.soFar}>so far</i>}
                </span>
              </div>
            );
          })}
        </div>
        <div className={s.legend}>
          {view !== "membership" && <span><i className={`${s.dot} ${s.barA}`} />DPP</span>}
          {view !== "dpp" && membershipScoped && <span><i className={`${s.dot} ${s.barB}`} />Membership</span>}
          {!membershipScoped && <span>Membership withheld — it is a city figure and cannot be narrowed to one pitch.</span>}
        </div>
      </div>

      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Breakdown</span>
          <div className={s.seg}>
            {(["city", "field", "match"] as const).map((g) => (
              <button key={g} type="button" className={grain === g ? s.on : ""} onClick={() => setGrain(g)}>
                {g === "city" ? "City View" : g === "field" ? "Field View" : "Match View"}
              </button>
            ))}
          </div>
        </div>
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
          <button type="button" className={s.btn} onClick={exportTable}>Export</button>
        </div>
      </div>

      {grain === "match" ? (
        <MatchTable rows={shownMatches} />
      ) : (
        <GroupTable rows={shownFields} grain={grain} />
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

function GroupTable({ rows, grain }: { rows: FieldMonth[]; grain: "city" | "field" }) {
  if (rows.length === 0) return <div className={s.empty}>No rows for this selection.</div>;
  // City view aggregates its fields; field view lists them. Either way the row is a (thing, month)
  // pair so the months stay separable — a single blended figure across four months would hide the
  // very trend the chart above is drawing.
  const keyed = new Map<string, { label: string; month: Q2Month; basisSet: Set<FieldMonth["basis"]>; matches: number; dpp: number; rental: number; cost: number; anyUnknown: boolean; allUnknown: boolean }>();
  for (const r of rows) {
    const label = grain === "city" ? r.city : r.field;
    const k = `${label}|${r.month}`;
    let e = keyed.get(k);
    if (!e) {
      e = { label, month: r.month, basisSet: new Set(), matches: 0, dpp: 0, rental: 0, cost: 0, anyUnknown: false, allUnknown: true };
      keyed.set(k, e);
    }
    e.basisSet.add(r.basis);
    e.matches += r.matches;
    e.dpp += r.revenue - r.privateRental;
    e.rental += r.privateRental;
    if (r.cost == null) e.anyUnknown = true;
    else { e.cost += r.cost; e.allUnknown = false; }
  }
  const list = [...keyed.values()].sort((a, b) => (a.label === b.label ? a.month.localeCompare(b.month) : b.dpp - a.dpp));
  const T = list.reduce((a, r) => ({ matches: a.matches + r.matches, dpp: a.dpp + r.dpp, rental: a.rental + r.rental, cost: a.cost + (r.allUnknown ? 0 : r.cost) }), { matches: 0, dpp: 0, rental: 0, cost: 0 });

  return (
    <div className={s.card}>
      <div className={s.tblWrap}>
        <table className={s.tbl} data-testid="revenue-group-table">
          <thead>
            <tr>
              <th className="l">{grain === "city" ? "City" : "Location"}</th>
              <th className="l">Month</th>
              <th>Matches</th>
              <th>DPP Revenue</th>
              <th>Private Rental</th>
              <th>Field Cost</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={`${r.label}|${r.month}`} data-testid="revenue-group-row">
                <td className="l">
                  {r.label}
                  {[...r.basisSet].map((b) => <BillingMark key={b} basis={b} unknown={false} />)}
                  {r.anyUnknown && <BillingMark basis="per_match" unknown />}
                </td>
                <td className="l">{r.month}</td>
                <td>{fmtInt(r.matches)}</td>
                <td>{fmtMoney(r.dpp)}</td>
                <td className={r.rental === 0 ? s.mut : ""}>{r.rental === 0 ? "—" : fmtMoney(r.rental)}</td>
                {/* A dash, never a zero: no basis on file is not a free pitch. */}
                <td className={r.allUnknown ? s.mut : s.neg} data-testid="revenue-cost-cell">
                  {r.allUnknown ? "—" : fmtMoney(r.cost)}
                </td>
              </tr>
            ))}
            <tr className={s.tot}>
              <td className="l">Total</td>
              <td className="l">—</td>
              <td>{fmtInt(T.matches)}</td>
              <td>{fmtMoney(T.dpp)}</td>
              <td>{fmtMoney(T.rental)}</td>
              <td className={s.neg}>{fmtMoney(T.cost)}</td>
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
