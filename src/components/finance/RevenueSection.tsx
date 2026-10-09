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
import { cityTotalMemberSpotsFor, unattributedVenues, venueMemberSpotsFor } from "@/lib/financeStats";
import { loadMembershipWindowsByUserId, type MembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import {
  bucketOf, byCityRows, byFieldRows, cityLabel, fieldKeyOf, filterRows, isRevenueRow, taxCentsOf, money, UNASSIGNED,
  type GroupRow, type MemberShares, type PageFilter, type RollupRow, type Totals,
} from "@/lib/revenueTxn";
import { loadMatchRollup, loadRollup, useAsync, useReaderId } from "@/lib/useRevenueTxn";
import { downloadCsv } from "@/components/growth/format";
import MatchView from "./MatchView";
import DailyRevenuePace from "./DailyRevenuePace";
import RevenueTop, { monthKeyOf, monthLabelOf, totalsByMonth, ymdOf } from "./RevenueTop";
import RevenueNetTable, { type PnLCell } from "./RevenueNetTable";
import { useFieldPnL } from "@/lib/useFieldPnL";
import { rollupFields, type FieldAgg, type PnLRollup } from "@/lib/fieldPnL";
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

  /* MATCHES THAT HAVE KICKED OFF, by now. The current month used to count its whole schedule (544
   * for October on the 7th) against revenue so far; the realized cut is the one Cost uses. A closed
   * month is unchanged by it — every match in it has kicked off. These rows feed match COUNTS and
   * the member-spot shares only; no money on this page comes from them. */
  const fieldRows = useMemo(
    () => (data ? buildFieldMonths(data, matchRegistrations, span.months, now.getTime()) : []),
    [data, matchRegistrations, span.months, now],
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
      const cents = r.gross_cents - taxCentsOf({ kind: r.kind as RollupRow["kind"], source: "Stripe", city: r.city, gross_cents: r.gross_cents, tax_cents: r.tax_cents });
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
  /* MEMBERSHIP ONTO FIELDS — the Cities page's rule (cityPnl.ts, "ALLOCATE membership onto the
   * pitches"): field share = the field's member spots that month ÷ the city's member spots that
   * month, from the same two helpers. Applied to fin_txn membership in byFieldRows. */
  const memberShares = useCallback<MemberShares>((city, periodKey) => {
    if (!data) return null;
    const month = monthLabelOf(periodKey);
    const legs = data.venues.filter((v) => canonCity(v.city) === canonCity(city));
    if (legs.length === 0) return null;
    const citySpots = cityTotalMemberSpotsFor(data, legs[0].city, month);
    if (!(citySpots > 0)) return null;
    return legs
      .map((v) => ({ venueId: Number(v.id), share: venueMemberSpotsFor(data, v.id, month).member / citySpots }))
      .filter((x) => x.share > 0);
  }, [data]);
  const fieldGroups = useMemo(() => {
    if (!periodRows) return [];
    const rows = cityFilter === "all" ? periodRows : periodRows.filter((r) => cityLabel(r.city) === cityFilter);
    return byFieldRows(rows, venues, memberShares);
  }, [periodRows, cityFilter, venues, memberShares]);
  // Field-view city chips: the cities with revenue in the period, Unassigned last.
  const chipCities = useMemo(() => cityGroups.map((g) => g.label), [cityGroups]);

  /* ── THE PAGE FILTER: ONE CITY, OR ONE FIELD (Ryan, 2026-10-07) ─────────────────────────────
   * It narrows the top card, the four-month table and the chart together, through filterRows() in
   * revenueTxn — the same rows the City and Field tabs group, so a filtered figure equals that
   * city's row or that field's row to the cent. The City / Field / Match tables below stay whole,
   * so the comparison can be made on one screen. Changing city resets the field. */
  const [filter, setFilter] = useState<PageFilter>({ city: null, field: null });
  const fieldOptions = useMemo(() => {
    // Real fields with revenue in the selected period and city, by field ID — never a match name.
    const out = new Map<string, { label: string; legs: number[] }>();
    if (!periodRows || venues.size === 0) return out;
    const names = new Map<string, Set<string>>();
    for (const v of venues.values()) names.set(v.name, (names.get(v.name) ?? new Set()).add(v.city ?? ""));
    for (const r of periodRows) {
      if (!isRevenueRow(r) || r.fin_venue_id == null || (r.kind !== "charge" && r.kind !== "manual") || r.gross_cents <= 0) continue;
      if (filter.city && cityLabel(r.city) !== filter.city) continue;
      const v = venues.get(r.fin_venue_id);
      if (!v) continue;
      const key = fieldKeyOf(r.fin_venue_id, venues, r.city);
      const o = out.get(key) ?? { label: (names.get(v.name)?.size ?? 0) > 1 && !filter.city ? `${v.name} (${v.city ?? "—"})` : v.name, legs: [] };
      out.set(key, o);
    }
    // EVERY LEG OF THE FIELD, not only the ones that charged: membership is credited by member spots
    // to any of them.
    for (const [id] of venues) { const k = fieldKeyOf(id, venues); const o = out.get(k); if (o && !o.legs.includes(id)) o.legs.push(id); }
    return new Map([...out].sort((a, b) => a[1].label.localeCompare(b[1].label)));
  }, [periodRows, venues, filter.city]);
  // A field not in the list for this period cannot stay selected.
  useEffect(() => {
    if (filter.field && periodRows && venues.size > 0 && !fieldOptions.has(filter.field)) setFilter((f) => ({ ...f, field: null }));
  }, [filter.field, fieldOptions, periodRows, venues.size]);
  const fieldLegs = filter.field ? fieldOptions.get(filter.field)?.legs ?? null : null;
  const fieldName = filter.field ? filter.field.slice(0, filter.field.lastIndexOf("|")) : null;
  const fieldCity = filter.field ? filter.field.slice(filter.field.lastIndexOf("|") + 1) : null;
  const scopeLabel = filter.field ? `${fieldCity} · ${fieldName}` : filter.city ?? "All MatchDay";
  /* Member-spot shares exist only for months the roster loader holds; a field needs them. */
  const sharesCover = useCallback((monthKey: string) => {
    const cov = data?.mdapiMemberSpots.coveredMonths;
    return !!data && (!cov || cov.size === 0 || cov.has(monthLabelOf(monthKey)));
  }, [data]);
  const narrow = useCallback((rows: RollupRow[] | null): RollupRow[] | null => {
    if (!rows) return null;
    if (filter.field) return data ? filterRows(rows, filter, venues, memberShares) : null;
    return filterRows(rows, filter, venues);
  }, [filter, data, venues, memberShares]);
  const topRows = useMemo(() => narrow(periodRows), [narrow, periodRows]);
  const spanRows = useMemo(() => narrow(txn.data), [narrow, txn.data]);

  /* THE TILES' DAY ROWS, ALL ON THE PAGE'S NARROWING (merged 2026-10-08). Pace to month end reads
   * this month by day and, for its shape factor, last month by day; Avg daily DPP takes today's
   * partial DPP out of a period in progress. All three come through useNarrowedDays, so a city or a
   * field selected at the top narrows every one of them the same way. */
  const isCurMonth = period.grain === "month" && period.isCurrent;
  const pFrom = ymdOf(period.start), pTo = ymdOf(period.end);
  const prevFrom = ymdOf(new Date(period.start.getFullYear(), period.start.getMonth() - 1, 1));
  const prevTo = ymdOf(new Date(period.start.getFullYear(), period.start.getMonth(), 0));
  const todayYmd = ymdOf(new Date(period.start.getFullYear(), period.start.getMonth(), period.start.getDate() + period.elapsedDays - 1));
  const narrowing = { uid, filter, fieldLegs, narrow, ready: !!data, venues, memberShares };
  const day = useNarrowedDays(isCurMonth, pFrom, pTo, narrowing);
  const prevDay = useNarrowedDays(isCurMonth, prevFrom, prevTo, narrowing);
  const todayDay = useNarrowedDays(period.isCurrent, todayYmd, todayYmd, narrowing);

  const filters = (
    <span className="rv2-filters" data-testid="page-filters">
      <select aria-label="City" data-testid="filter-city" value={filter.city ?? ""}
        onChange={(e) => setFilter({ city: e.target.value || null, field: null })}>
        <option value="">All cities</option>
        {chipCities.filter((c) => c !== UNASSIGNED).map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select aria-label="Field" data-testid="field-select" value={filter.field ?? ""} disabled={venues.size === 0}
        onChange={(e) => setFilter((f) => ({ ...f, field: e.target.value || null }))}>
        <option value="">All fields</option>
        {[...fieldOptions].map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
      </select>
      <InfoI pop="fields" label="How fields are listed" />
    </span>
  );


  // MATCHES, FROM THE ROSTER, for the same months.
  const periodFieldRows = useMemo(() => {
    const ms = new Set(period.months);
    return fieldRows.filter((r) => ms.has(r.month));
  }, [fieldRows, period.months]);
  const cityMatches = useCallback((g: GroupRow) => g.label === UNASSIGNED ? null
    : periodFieldRows.filter((r) => canonCity(r.city) === canonCity(g.label)).reduce((a, r) => a + r.matches, 0), [periodFieldRows]);
  const fieldMatches = useCallback((g: GroupRow) => g.venueId == null ? null
    : periodFieldRows.filter((r) => r.venueIds.includes(g.venueId!)).reduce((a, r) => a + r.matches, 0), [periodFieldRows]);
  // VENUES: the city's fields with a kicked-off match in the period — the same rows as Matches.
  const cityVenues = useCallback((g: GroupRow) => g.label === UNASSIGNED ? null
    : new Set(periodFieldRows.filter((r) => canonCity(r.city) === canonCity(g.label) && r.matches > 0).map((r) => r.key)).size, [periodFieldRows]);

  /* ── THE LAST 4 COMPLETED WEEKS — Slate Review's Match P&L by field (src/lib/fieldPnL.ts) ───────
   * Always that window, whatever the month picker says. A field row is the field's Slate line,
   * found through the venue ids on it (a field's legs, from the roster rows); a city row is
   * match-weighted across the city's fields that have a cost. */
  const fp = useFieldPnL(4);
  const cellOfRollup = (r: PnLRollup): PnLCell => ({
    matches: r.matches, revPM: r.revPM, costPM: r.costPM, netPM: r.netPM,
    coverage: r.covered < r.matches ? `${r.covered.toLocaleString("en-US")} of ${r.matches.toLocaleString("en-US")} matches` : null,
    costText: null, profitShare: false, provisionalMonths: r.provisionalMonths,
  });
  const cellOfField = (f: FieldAgg): PnLCell => ({
    matches: f.matches, revPM: f.revPM, costPM: f.costPM, netPM: f.netPM, coverage: null,
    costText: f.bucket === "model" ? f.costLabel : f.bucket === "unmapped" ? "No venue cost" : null,
    profitShare: f.bucket === "share", provisionalMonths: f.provisionalMonths, costNote: f.costNote,
  });
  const fieldAggOf = useCallback((g: GroupRow): FieldAgg | null => {
    if (!fp.fields || g.venueId == null) return null;
    const legs = new Set<number>([g.venueId]);
    for (const r of periodFieldRows) if (r.venueIds.includes(g.venueId)) for (const id of r.venueIds) legs.add(id);
    return fp.fields.find((f) => f.bucket !== "unmapped" && f.venueIds.some((id) => legs.has(id))) ?? null;
  }, [fp.fields, periodFieldRows]);
  const cityFields = useCallback((label: string) =>
    (fp.fields ?? []).filter((f) => canonCity(f.city) === canonCity(label)), [fp.fields]);
  const pnlFor = (gr: "city" | "field") => ({
    label: fp.win.label, loading: !fp.fields && !fp.error, error: fp.error,
    of: (g: GroupRow) => {
      if (gr === "city") return fp.fields ? cellOfRollup(rollupFields(cityFields(g.label))) : null;
      const f = fieldAggOf(g);
      return f ? cellOfField(f) : null;
    },
    total: !fp.fields ? null : cellOfRollup(rollupFields(
      gr === "field" && cityFilter !== "all" ? cityFields(cityFilter) : fp.fields)),
  });

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
  // THE FOUR-MONTH TABLE FOLLOWS THE PAGE FILTER.
  const monthTotals = useMemo(() => (spanRows ? totalsByMonth(spanRows) : null), [spanRows]);
  const periodTotal = useCallback((months: string[], pick: (t: Totals) => number) => {
    if (!monthTotals) return null;
    return months.reduce((a, m) => { const t = monthTotals.get(monthKeyOf(m)); return a + (t ? pick(t) : 0); }, 0);
  }, [monthTotals]);
  const SUMMARY_ROWS: { key: string; label: string; pick: (t: Totals) => number; strong?: boolean }[] = [
    { key: "gross", label: "Gross collected", pick: (t) => t.gross },
    { key: "reversals", label: "Refunds and disputes", pick: (t) => t.reversals },
    { key: "tax", label: "Sales tax", pick: (t) => t.tax },
    { key: "net", label: "Net revenue", pick: (t) => t.net, strong: true },
    { key: "dpp", label: "DPP (net)", pick: (t) => t.dpp },
    { key: "membership", label: "Membership (net)", pick: (t) => t.membership },
    { key: "other", label: "Other (net)", pick: (t) => t.other },
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
    // REAL CITIES ONLY: Unassigned is a row so the table adds up, not a city.
    if (grain === "city") { const n = cityGroups.filter((g) => g.label !== UNASSIGNED).length; return `${n} ${noun(n)}`; }
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
    // THE TABLE ON SCREEN, cell for cell: the same GroupRows, in dollars to the cent, and the same
    // 4-week cells, with the window in their headers.
    const d = (c: number) => (c / 100).toFixed(2);
    const groups = grain === "city" ? cityGroups : fieldGroups;
    const total = groups.reduce((a, g) => a + g.net, 0);
    const city = grain === "city";
    const p = pnlFor(grain);
    const w = `last 4 completed weeks ${fp.win.label}`;
    const n2 = (v: number | null) => (v == null ? "" : v.toFixed(2));
    downloadCsv(`matchday-revenue-${grain}-${period.key}.csv`, [
      [city ? "City" : "Field", ...(city ? ["Venues"] : ["City", "Launched"]), "Period", "Matches (kicked off)",
        "DPP (before refunds)", "Membership (before refunds)", "Net revenue", ...(city ? ["Avg revenue / venue"] : []), "Member mix", "Share",
        `Matches (${w})`, `Revenue / match (${w}, play revenue before tax, refunds and Stripe fees)`, `Field cost / match (${w})`,
        `Net / match (${w})`, `Cost note (${w})`],
      ...groups.map((g) => {
        const m = city ? cityMatches(g) : fieldMatches(g);
        const v = city ? cityVenues(g) : null;
        const c = g.label === UNASSIGNED ? null : p.of(g);
        const note = !c ? "" : [c.costText, c.profitShare ? "Profit share" : null, c.coverage ? `averages cover ${c.coverage}` : null,
          c.provisionalMonths.length ? `provisional until ${c.provisionalMonths.join(" and ")} closes` : null].filter(Boolean).join("; ");
        return [g.label, ...(city ? [v ?? ""] : [g.city ?? "", launchOf(g) ?? ""]), period.label, m ?? "",
          d(g.dpp), d(g.membership), d(g.net), ...(city ? [v ? d(Math.round(g.net / v)) : ""] : []),
          g.net > 0 ? `${((g.membership / g.net) * 100).toFixed(1)}%` : "", total ? `${((g.net / total) * 100).toFixed(1)}%` : "",
          c ? c.matches : "", n2(c?.revPM ?? null), n2(c?.costPM ?? null), n2(c?.netPM ?? null), note];
      }),
    ]);
  }

  const top = <RevenueTop period={period} rows={topRows} error={txn.error} dayRows={day.rows} prevDay={prevDay} todayRows={todayDay.rows} filters={filters} />;
  const pace = <DailyRevenuePace filter={filter} scopeLabel={scopeLabel} venues={venues} fieldLegs={fieldLegs}
    memberShares={data ? memberShares : undefined} sharesCover={sharesCover} />;

  /* THE TOP AND THE PACE CARD ARE NOT GATED ON THE ROSTER. They read fin_txn only, and a switch to
   * Quarter blanks the roster-backed parts for ~20 seconds while mdapi_match_players pages in.
   * React reconciles by POSITION, so both sit at the same index in all three trees below — otherwise
   * they would unmount the moment the roster lands and lose an open popover or a pinned readout. */
  if (matchLoading || (primaryLoading && !data)) {
    return (
      <div className={`${s.wrap} rv2`} data-testid="finance-revenue-loading">
        <style>{RV2_CSS}</style>
        {top}
        {pace}
        <div className={s.empty}>Loading…</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={`${s.wrap} rv2`} data-testid="finance-revenue-nodata">
        <style>{RV2_CSS}</style>
        {top}
        {pace}
        <div className={s.empty}>No finance data for this period.</div>
      </div>
    );
  }

  return (
    <div className={`${s.wrap} rv2`} data-testid="finance-revenue">
      <style>{RV2_CSS}</style>
      {top}
      {pace}

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
            <span className={s.cardTitle} data-testid="revenue-summary-title">{fieldName ?? filter.city ?? "Matchday revenue"}</span>
            <span className="rv2-tag" data-testid="summary-scope-tag" style={{ marginLeft: 10 }}>{scopeLabel}</span>
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
              {SUMMARY_ROWS.filter((row) => row.key !== "other" || periods.some((p) => (periodTotal(p.months, row.pick) ?? 0) !== 0)).map((row) => (
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
          <RevenueNetTable grain="city" groups={cityGroups} matchesOf={cityMatches} venuesOf={cityVenues} pnl={pnlFor("city")} />
        ) : (
          <RevenueNetTable grain="field" groups={fieldGroups} matchesOf={fieldMatches} launchOf={launchOf} pnl={pnlFor("field")} />
        )}
      </div>
    </div>
  );
}


/* DAY ROWS FOR ONE RANGE, NARROWED THE WAY THE PAGE IS. All of MatchDay, a city (filterRows on the
 * rows), or a field: that field's own legs plus the city's membership rows, which filterRows credits
 * to it by member spots. `rows` is null while loading; `error` is a failed read. */
function useNarrowedDays(on: boolean, from: string, to: string, n: {
  uid: string | null; filter: PageFilter; fieldLegs: number[] | null; narrow: (rows: RollupRow[] | null) => RollupRow[] | null;
  ready: boolean; venues: Map<number, { name: string; city: string | null }>; memberShares: MemberShares;
}): { rows: RollupRow[] | null; error: string | null } {
  const all = useAsync(on && n.uid ? `day|${n.uid}|${from}|${to}` : null,
    () => loadRollup(n.uid!, { from, to, grain: "day", byVenue: false }));
  const legs = useAsync(on && n.uid && n.filter.field && n.fieldLegs?.length ? `daylegs|${n.uid}|${from}|${to}|${n.fieldLegs.join(",")}` : null,
    async () => (await Promise.all(n.fieldLegs!.map((id) => loadRollup(n.uid!, { from, to, grain: "day", byVenue: true, venueId: id })))).flat());
  const { filter, narrow, ready, venues, memberShares } = n;
  const rows = useMemo(() => {
    if (!all.data) return null;
    if (!filter.field) return narrow(all.data);
    if (!legs.data) return null;
    const rs = [...legs.data, ...all.data.filter((r) => r.fin_venue_id == null && bucketOf(r.type) === "membership")];
    return ready ? filterRows(rs, filter, venues, memberShares, true) : null;
  }, [all.data, legs.data, filter, narrow, ready, venues, memberShares]);
  return { rows, error: all.error ?? legs.error };
}
