"use client";

// FINANCE › REVENUE — what came in, over the selected period and the prior three.
//
// ── EVERY MONEY FIGURE ON THIS PAGE READS fin_txn (2026-10-07) ─────────────────────────────────
// One row per Stripe balance transaction plus the manual Venmo rows, summed in Central time by the
// database (fin_txn_rollup, migration 0213) and turned into figures by ONE module,
// src/lib/revenueTxn.ts. The headline, the line items, the four-month table, the City and Field
// tables and the pace chart are all sums of the same integer per-row amounts, so they agree to the
// cent by construction. Ryan's definitions are written at the top of that module.
//
// The page used to read fin_revenue (tax-inclusive, UTC-dated, one row per day/city/type/venue) for
// its headline and city view, and the roster for its field view — two bases on one page, stated
// rather than reconciled. Both are gone from the money here. Every OTHER Finance page still reads
// fin_revenue and is unchanged.
//
// WHAT STILL COMES FROM THE ROSTER, AND WHY: match COUNTS (a count of matches is a roster fact, not
// money), and the Match tab's rows, field cost and spot counts. The Match tab's DPP revenue per
// match is fin_txn, joined to the match through the payment (fin_txn_match_rollup).
//
// FOUR MONTHS CROSS A QUARTER. The roster loader fetches one quarter, so the page mounts a second
// loader for the quarter owning the earlier months and merges them by month ownership.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useMatchRangeData } from "@/lib/useMatchData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import {
  comparisonSpan, matchRange, matchPanelPeriod,
  type MatchWindowKind,
} from "@/lib/financePeriod";
import {
  buildFieldCostSlots, buildFieldMonths, buildMatchRows, canonCity, hasKickedOff,
  type MatchRow,
} from "@/lib/fieldEconomics";
import { unattributedVenues } from "@/lib/financeStats";
import { loadMembershipWindowsByUserId, type MembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import {
  byCityRows, byFieldRows, cityLabel, taxCentsOf, money, UNASSIGNED,
  type GroupRow, type RollupRow, type Totals,
} from "@/lib/revenueTxn";
import { loadMatchRollup, loadRollup, useAsync, useReaderId } from "@/lib/useRevenueTxn";
import { downloadCsv } from "@/components/growth/format";
import MatchView from "./MatchView";
import DailyRevenuePace from "./DailyRevenuePace";
import RevenueTop, { monthKeyOf, totalsByMonth, ymdOf } from "./RevenueTop";
import RevenueNetTable from "./RevenueNetTable";
import { InfoI, RV2_CSS } from "./RevenueInfo";
import s from "./financeSection.module.css";

type Grain = "city" | "field" | "match";

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
  // THE TABLE IS THE SELECTED PERIOD PLUS THE PRIOR THREE AT THE SAME GRAIN. comparisonSpan
  // collapses those four into one synthetic span, and reports how many it had to drop.
  const { period, now } = useFinancePeriod();
  const { periods, span, dropped } = useMemo(() => comparisonSpan(period, 4, now), [period, now]);
  const uid = useReaderId();

  // ── fin_txn, MONTH GRAIN, BY VENUE, FOR THE WHOLE SPAN. One call; a few hundred rows. ──
  const spanFrom = ymdOf(span.start), spanTo = ymdOf(span.end);
  const txn = useAsync(
    uid ? `span|${uid}|${spanFrom}|${spanTo}` : null,
    () => loadRollup(uid!, { from: spanFrom, to: spanTo, grain: "month", byVenue: true }),
  );
  const periodKeys = useMemo(() => new Set(period.months.map(monthKeyOf)), [period.months]);
  const periodRows = useMemo<RollupRow[] | null>(
    () => (txn.data ? txn.data.filter((r) => periodKeys.has(r.period)) : null),
    [txn.data, periodKeys],
  );

  // ── THE ROSTER: match counts, and the Match tab. ──
  const { data, loading: primaryLoading } = useFinancePeriodData(span);
  const { fromDate, toDate } = useMemo(() => matchRange(span.start, span.end), [span]);
  const { rows: matchRegistrations, loading: matchLoading } = useMatchRangeData(fromDate, toDate);

  // Subscription windows, for the member-vs-comp split in Match View only.
  const [windows, setWindows] = useState<MembershipWindowsByUserId>(() => new Map());
  useEffect(() => {
    let alive = true;
    loadMembershipWindowsByUserId(supabase)
      .then((w) => { if (alive) setWindows(w); })
      .catch(() => { /* leaves the legacy split; the column note says which is in force */ });
    return () => { alive = false; };
  }, []);

  const [grain, setGrain] = useState<Grain>("city");
  const [cityFilter, setCityFilter] = useState<string>("all");

  /* A fin_venues row with a blank city is excluded from Match View's allocated member revenue,
   * and is named here rather than dropped silently. Renders only when there is something to say. */
  const unattributed = useMemo(() => (data ? unattributedVenues(data) : []), [data]);

  const fieldRows = useMemo(
    () => (data ? buildFieldMonths(data, matchRegistrations, span.months, null) : []),
    [data, matchRegistrations, span.months],
  );

  /* ── THE MATCH PANEL'S OWN WINDOW ──────────────────────────────────────────────────────────
   * The panel does NOT inherit `span`: it is a browse-everything table with a YTD / All time
   * window. The finance tables stay on the YTD window in both modes; all time widens the
   * registrations only. */
  const [matchWindow, setMatchWindow] = useState<MatchWindowKind>("ytd");
  const mPeriod = useMemo(() => matchPanelPeriod(matchWindow, now), [matchWindow, now]);
  const mCostPeriod = useMemo(() => matchPanelPeriod("ytd", now), [now]);
  const { data: mData, loading: mCostLoading } = useFinancePeriodData(mCostPeriod);
  const mBounds = useMemo(
    () => (matchWindow === "all"
      ? { fromDate: "", toDate: "" }
      : matchRange(mPeriod.start, mPeriod.end)),
    [matchWindow, mPeriod],
  );
  const { rows: mRegs, loading: mLoading, error: mError } = useMatchRangeData(mBounds.fromDate, mBounds.toDate);
  const mCostSlots = useMemo(
    () => (mData ? buildFieldCostSlots(mData, mPeriod.months, null) : []),
    [mData, mPeriod.months],
  );

  /* ── DPP REVENUE PER MATCH, FROM fin_txn ───────────────────────────────────────────────────
   * Joined through the payment intent (fin_txn_match_rollup): each match's charges, less its
   * refunds and disputes, net of sales tax. Loaded only once the Match tab is open. */
  const mFrom = ymdOf(mPeriod.start), mTo = ymdOf(mPeriod.end);
  const mTxn = useAsync(
    grain === "match" && uid ? `match|${uid}|${mFrom}|${mTo}` : null,
    () => loadMatchRollup(uid!, mFrom, mTo),
  );
  const matchNet = useMemo(() => {
    const out = new Map<number, number>();
    for (const r of mTxn.data ?? []) {
      if (r.excluded) continue;
      const cents = r.gross_cents - taxCentsOf({ kind: r.kind as RollupRow["kind"], source: "Stripe", city: r.city, gross_cents: r.gross_cents });
      out.set(r.match_api_id, (out.get(r.match_api_id) ?? 0) + cents);
    }
    return out;
  }, [mTxn.data]);
  const mBusy = mLoading || (mCostLoading && !mData) || (grain === "match" && !mTxn.data && !mTxn.error);
  const panelRows = useMemo(
    () => (mData ? buildMatchRows(mData, mRegs, mCostSlots, windows) : [])
      .map((r) => ({ ...r, dppRevenue: (matchNet.get(r.matchApiId) ?? 0) / 100 })),
    [mData, mRegs, mCostSlots, windows, matchNet],
  );
  const panelShownRef = useRef<MatchRow[]>([]);
  const onPanelShown = useCallback((rows: MatchRow[]) => { panelShownRef.current = rows; }, []);

  // ── CITY AND FIELD TABLES: the whole selected period, so the Total is the net revenue figure. ──
  const cityGroups = useMemo(() => (periodRows ? byCityRows(periodRows) : []), [periodRows]);
  const venues = useMemo(
    () => new Map((data?.venues ?? []).map((v) => [Number(v.id), { name: v.venue_name, city: v.city ?? null }])),
    [data],
  );
  const fieldGroups = useMemo(() => {
    if (!periodRows) return [];
    const rows = cityFilter === "all" ? periodRows : periodRows.filter((r) => cityLabel(r.city) === cityFilter);
    return byFieldRows(rows, venues);
  }, [periodRows, cityFilter, venues]);
  // Field-view city chips: the cities with revenue in the period, Unassigned last.
  const chipCities = useMemo(() => cityGroups.map((g) => g.label), [cityGroups]);

  // MATCHES, FROM THE ROSTER, for the same months.
  const periodFieldRows = useMemo(() => {
    const ms = new Set(period.months);
    return fieldRows.filter((r) => ms.has(r.month));
  }, [fieldRows, period.months]);
  const cityMatches = useCallback((g: GroupRow) => g.label === UNASSIGNED ? null
    : periodFieldRows.filter((r) => canonCity(r.city) === canonCity(g.label)).reduce((a, r) => a + r.matches, 0), [periodFieldRows]);
  const fieldMatches = useCallback((g: GroupRow) => g.venueId == null ? null
    : periodFieldRows.filter((r) => r.venueIds.includes(g.venueId!)).reduce((a, r) => a + r.matches, 0), [periodFieldRows]);
  // fin_venues.launch_date: the earliest among the field's venue rows.
  const launchOf = useCallback((g: GroupRow): string | null => {
    if (g.venueId == null) return null;
    const dates = (data?.venues ?? [])
      .filter((v) => v.venue_name === g.label && (v.city ?? null) === g.city)
      .map((v) => v.launch_date).filter((d): d is string => !!d).sort();
    if (dates.length === 0) return null;
    const d = new Date(`${dates[0].slice(0, 10)}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dates[0].slice(0, 10);
    return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()]} ${d.getFullYear()}`;
  }, [data]);

  // ── THE FOUR-PERIOD TABLE ──
  const monthTotals = useMemo(() => (txn.data ? totalsByMonth(txn.data) : null), [txn.data]);
  const periodTotal = useCallback((months: string[], pick: (t: Totals) => number) => {
    if (!monthTotals) return null;
    return months.reduce((a, m) => { const t = monthTotals.get(monthKeyOf(m)); return a + (t ? pick(t) : 0); }, 0);
  }, [monthTotals]);
  const SUMMARY_ROWS: { key: string; label: string; pick: (t: Totals) => number; strong?: boolean }[] = [
    { key: "gross", label: "Gross collected", pick: (t) => t.gross },
    { key: "reversals", label: "Refunds and disputes", pick: (t) => t.refunds + t.failed + t.disputes },
    { key: "tax", label: "Sales tax", pick: (t) => t.tax },
    { key: "net", label: "Net revenue", pick: (t) => t.net, strong: true },
    { key: "dpp", label: "DPP (net)", pick: (t) => t.dpp },
    { key: "membership", label: "Membership (net)", pick: (t) => t.membership },
    { key: "fees", label: "Stripe fees", pick: (t) => t.fees },
  ];

  // The count beside the Breakdown segments, in the units of the breakdown being shown.
  const breakdownCount = useMemo(() => {
    const noun = (n: number) =>
      grain === "city" ? (n === 1 ? "city" : "cities")
        : grain === "field" ? (n === 1 ? "field" : "fields")
        : (n === 1 ? "match" : "matches");
    if (grain === "match") {
      const done = panelRows.filter((r) => hasKickedOff(r, now.getTime())).length;
      return `${done} ${noun(done)}`;
    }
    if (grain === "city") return `${cityGroups.length} ${noun(cityGroups.length)}`;
    const real = fieldGroups.filter((g) => g.venueId != null).length;
    return `${real} ${noun(real)}`;
  }, [grain, panelRows, cityGroups, fieldGroups, now]);

  /* SWITCHING VIEW KEEPS WHAT THE NEXT VIEW CAN STILL USE.
   *   Field → Match  the city carries over onto Match View's own City select.
   *   → City         everything drops: City View has no filter. */
  const changeGrain = (next: Grain) => {
    if (next === grain) return;
    if (next === "city") setCityFilter("all");
    setGrain(next);
  };

  function exportTable() {
    if (grain === "match") {
      downloadCsv(`matchday-revenue-matches-${mPeriod.key}.csv`, [
        ["Date", "Month", "Week", "Weekday", "City", "Location", "Hour", "Match", "Members Code", "Free Code", "DPP's", "Total Spots", "DPP Revenue (net)", "Field Cost"],
        ...panelShownRef.current.map((r) => [
          dateLabel(r.start), r.month, r.week, WEEKDAY[r.start.getDay()], r.city, r.location,
          hourLabel(r.start), 1, r.memberSpots, r.freeSpots, r.dppSpots, r.totalSpots,
          r.dppRevenue.toFixed(2), r.fieldCost == null ? "" : r.fieldCost.toFixed(2),
        ]),
      ]);
      return;
    }
    // THE TABLE ON SCREEN, cell for cell: the same GroupRows, in dollars to the cent.
    const d = (c: number) => (c / 100).toFixed(2);
    const groups = grain === "city" ? cityGroups : fieldGroups;
    const total = groups.reduce((a, g) => a + g.net, 0);
    downloadCsv(`matchday-revenue-${grain}-${period.key}.csv`, [
      [grain === "city" ? "City" : "Field", ...(grain === "field" ? ["City", "Launched"] : []), "Period", "Matches",
        "DPP (net)", "Membership (net)", "Other (net)", "Refunds and disputes (net)", "Net revenue", "Share"],
      ...groups.map((g) => {
        const m = grain === "city" ? cityMatches(g) : fieldMatches(g);
        return [g.label, ...(grain === "field" ? [g.city ?? "", launchOf(g) ?? ""] : []), period.label, m ?? "",
          d(g.dpp), d(g.membership), d(g.other), d(g.reversals), d(g.net), total ? `${((g.net / total) * 100).toFixed(1)}%` : ""];
      }),
    ]);
  }

  const top = <RevenueTop period={period} rows={periodRows} error={txn.error} />;

  /* THE TOP AND THE PACE CARD ARE NOT GATED ON THE ROSTER. They read fin_txn only, and a switch to
   * Quarter blanks the roster-backed parts for ~20 seconds while mdapi_match_players pages in.
   * React reconciles by POSITION, so both sit at the same index in all three trees below — otherwise
   * they would unmount the moment the roster lands and lose an open popover or a pinned readout. */
  if (matchLoading || (primaryLoading && !data)) {
    return (
      <div className={`${s.wrap} rv2`} data-testid="finance-revenue-loading">
        <style>{RV2_CSS}</style>
        {top}
        <DailyRevenuePace />
        <div className={s.empty}>Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={`${s.wrap} rv2`} data-testid="finance-revenue-nodata">
        <style>{RV2_CSS}</style>
        {top}
        <DailyRevenuePace />
        <div className={s.empty}>No finance data for this period.</div>
      </div>
    );
  }

  return (
    <div className={`${s.wrap} rv2`} data-testid="finance-revenue">
      <style>{RV2_CSS}</style>
      {top}
      <DailyRevenuePace />

      {unattributed.length > 0 && (
        <div className={s.unattributed} data-testid="revenue-unattributed">
          <strong>
            {unattributed.length === 1
              ? "1 venue could not be attributed to a city"
              : `${unattributed.length} venues could not be attributed to a city`}
          </strong>{" "}
          and {unattributed.length === 1 ? "is" : "are"} excluded from Match View&apos;s allocated membership.{" "}
          {unattributed
            .map((u) => `${u.venueName} (venue ${u.venueId}${u.fieldIds.length
              ? `, field${u.fieldIds.length > 1 ? "s" : ""} ${u.fieldIds.join(", ")}`
              : ", no fields linked"})`)
            .join(" · ")}
          . Set the city on Field Costs to bring {unattributed.length === 1 ? "it" : "them"} back in.
        </div>
      )}

      <div className={s.card}>
        <div className={s.cardHead}>
          <div>
            <span className={s.cardTitle}>Matchday revenue</span>
            <div className={s.cardSub} data-testid="revenue-summary-sub">
              Current {period.grain} and prior three · oldest to newest · Central time
            </div>
          </div>
        </div>
        <div className={s.tblWrap}>
          <table className={s.tbl} data-testid="revenue-summary">
            <thead>
              <tr>
                <th className="l">&nbsp;</th>
                {periods.map((p) => (
                  <th key={p.key} data-testid="revenue-summary-month">
                    {p.label}
                    {p.key === period.key && period.isCurrent && <i className={s.soFar}>so far</i>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.map((row) => (
                <tr key={row.key} data-testid="revenue-summary-row" data-row={row.key}>
                  <td className="l">{row.strong ? <b>{row.label}</b> : row.label}</td>
                  {periods.map((p) => {
                    const v = periodTotal(p.months, row.pick);
                    return (
                      <td key={p.key} data-testid={`sum-${row.key}`} data-month={p.key} data-cents={v ?? ""}>
                        {v == null ? "…" : row.strong ? <b>{money(v)}</b> : money(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={s.legend}>
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

      {/* ── ONE CARD: TOGGLE, COUNT, FILTERS, TABLE ── */}
      <div className={s.card} data-testid="breakdown-card">
        <div className={s.brkHead}>
          <div className={s.seg} role="group" aria-label="Breakdown">
            {(["city", "field", "match"] as const).map((g) => (
              <button key={g} type="button" data-testid={`breakdown-${g}`}
                aria-pressed={grain === g}
                className={grain === g ? s.on : ""} onClick={() => changeGrain(g)}>
                {g === "city" ? "City" : g === "field" ? "Field" : "Match"}
              </button>
            ))}
          </div>
          <span className={s.brkCount} data-testid="breakdown-count">{breakdownCount}</span>
          {grain !== "match" ? (
            <span className={s.brkCount} data-testid="breakdown-basis">
              · {period.label} · net revenue, Central time{grain === "field" ? " · Launched is the field's first day" : ""}
            </span>
          ) : (
            <span className={s.brkCount} data-testid="breakdown-basis">
              · DPP revenue per match from Stripe, net of tax, dated by kick-off <InfoI pop="matchmoney" label="DPP revenue per match" />
            </span>
          )}
          <span className={s.brkGrow} />
          <button type="button" className={s.btn} data-testid="breakdown-export"
            onClick={exportTable}>Export</button>
        </div>

        {/* CITY VIEW RENDERS NO FILTER ROW AT ALL. The rows ARE the cities. */}
        {grain === "field" && (
          <div className={s.brkFilters} data-testid="breakdown-filters">
            <span className={s.ctrlLab}>City</span>
            <div className={s.seg}>
              <button type="button" data-testid="city-chip" data-city="all"
                className={cityFilter === "all" ? s.on : ""}
                onClick={() => setCityFilter("all")}>All</button>
              {chipCities.map((c) => (
                <button key={c} type="button" data-testid="city-chip" data-city={c}
                  className={cityFilter === c ? s.on : ""}
                  onClick={() => setCityFilter(c)}>{c}</button>
              ))}
            </div>
            {cityFilter !== "all" && (
              <button type="button" className={s.brkClear} data-testid="breakdown-clear"
                onClick={() => setCityFilter("all")}>Clear</button>
            )}
          </div>
        )}

        {grain === "match" ? (
          <>
            {mTxn.error && <div className="warn" data-testid="match-money-error">DPP revenue per match did not load: {mTxn.error}</div>}
            <MatchView
              rows={panelRows}
              initialCity={cityFilter === "all" || cityFilter === UNASSIGNED ? undefined : canonCity(cityFilter)}
              windowKind={matchWindow}
              windowLabel={mPeriod.label}
              loading={mBusy}
              error={mError}
              onLoadAllHistory={() => setMatchWindow("all")}
              onShown={onPanelShown}
            />
          </>
        ) : txn.error ? (
          <div className={s.empty}>Revenue did not load: {txn.error}</div>
        ) : !periodRows ? (
          <div className={s.empty}>Loading…</div>
        ) : grain === "city" ? (
          <RevenueNetTable grain="city" groups={cityGroups} matchesOf={cityMatches} />
        ) : (
          <RevenueNetTable grain="field" groups={fieldGroups} matchesOf={fieldMatches} launchOf={launchOf} />
        )}
      </div>
    </div>
  );
}

