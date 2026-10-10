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
  comparisonSpan, matchRange, matchPanelPeriod, monthSpanPeriod,
  type MatchWindowKind,
} from "@/lib/financePeriod";
import type { FinanceData } from "@/lib/useFinanceData";
import type { Q2Month } from "@/lib/financeStats";
import {
  buildFieldCostSlots, buildFieldMonths, buildMatchRows, canonCity, hasKickedOff,
  type MatchRow,
} from "@/lib/fieldEconomics";
import { cityTotalMemberSpotsFor, unattributedVenues, venueMemberSpotsFor } from "@/lib/financeStats";
import {
  addMonths, dateOfYm, monthsBetween, nextSort, periodKeyOfYm, presetRange, shortYm, ymOfDate, ymOfPeriodKey,
  type MonthRange, type Preset, type SortState, type Ym,
} from "@/lib/revenueRange";
import { loadMembershipWindowsByUserId, type MembershipWindowsByUserId } from "@/lib/mdapiMatchesRead";
import {
  bucketOf, byCityRows, byFieldRows, cityLabel, fieldKeyOf, filterRows, isRevenueRow, taxCentsOf, totalsOf, money, UNASSIGNED,
  type GroupRow, type MemberShares, type PageFilter, type RollupRow, type Totals,
} from "@/lib/revenueTxn";
import { loadCityLaunches, loadMatchRollup, loadVenueFirstPlayed, loadRollup, useAsync, useReaderId } from "@/lib/useRevenueTxn";
import { downloadCsv } from "@/components/growth/format";
import MatchView from "./MatchView";
import DailyRevenuePace from "./DailyRevenuePace";
import RevenueTop, { monthKeyOf, monthLabelOf, ymdOf } from "./RevenueTop";
import RevenueNetTable, {
  TEXT_KEYS, orderRows, selectedValue, type PnLCell,
} from "./RevenueNetTable";
import { useFieldPnL } from "@/lib/useFieldPnL";
import { rollupFields, type FieldAgg, type PnLRollup } from "@/lib/fieldPnL";
import { InfoI, RV2_CSS } from "./RevenueInfo";
import s from "./financeSection.module.css";

type Grain = "city" | "field" | "match";

/** Every month fin_txn holds, fetched once: month × venue over all history is ~700 rows and ~1.2 s
 *  (measured 2026-10-09), summed by the database — the range controls only pick months out of it. */
const HISTORY_FROM = "2020-01-01";
const PRESETS: { p: Preset; label: string }[] = [{ p: "4", label: "4M" }, { p: "6", label: "6M" }, { p: "12", label: "12M" }, { p: "since", label: "Since launch" }];
const covers = (d: FinanceData | null | undefined, ym: Ym) =>
  !!d && d.mdapiMemberSpots.coveredMonths.has(monthLabelOf(periodKeyOfYm(ym)) as Q2Month);

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
  // THE ROSTER STILL LOADS THE PERIOD AND THE PRIOR THREE, as it did for the old four-period table:
  // match counts and member-spot shares for those months come from it, unchanged.
  const { span } = useMemo(() => comparisonSpan(period, 4, now), [period, now]);
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
  /* THE PAGE FILTER: ONE CITY, OR ONE FIELD — the pinned bar's selects, the only city / field filter
   * on the page (2026-10-09: the Field tab's own city chips are gone; it follows this City). */
  const [filter, setFilter] = useState<PageFilter>({ city: null, field: null });
  const cityFilter = filter.city ?? "all";

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
  const memberShares = useCallback<MemberShares>((city, periodKey) => (data ? sharesOf(data, city, periodKey) : null), [data]);
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
  /* A FIELD SET BY CLICKING ITS ROW stays selectable even when it has no charge of its own in the
   * period (a field whose period figure is its membership share). Cleared when the period changes,
   * so the "no revenue this period" reset below still applies to a field carried across periods. */
  const [clickedField, setClickedField] = useState<string | null>(null);
  useEffect(() => { setClickedField(null); }, [period.key]);
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
    if (clickedField && !out.has(clickedField) && (!filter.city || clickedField.endsWith(`|${filter.city}`))) {
      const nm = clickedField.slice(0, clickedField.lastIndexOf("|"));
      out.set(clickedField, { label: (names.get(nm)?.size ?? 0) > 1 && !filter.city ? `${nm} (${clickedField.slice(clickedField.lastIndexOf("|") + 1)})` : nm, legs: [] });
    }
    // EVERY LEG OF THE FIELD, not only the ones that charged: membership is credited by member spots
    // to any of them.
    for (const [id] of venues) { const k = fieldKeyOf(id, venues); const o = out.get(k); if (o && !o.legs.includes(id)) o.legs.push(id); }
    return new Map([...out].sort((a, b) => a[1].label.localeCompare(b[1].label)));
  }, [periodRows, venues, filter.city, clickedField]);
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

  /* ── LAUNCHED ─────────────────────────────────────────────────────────────────────────────────
   * A FIELD: fin_venues.launch_date, the earliest among the field's venue rows (what the Field tab's
   * Export has always carried). A CITY: the first non-cancelled match on any field linked to the
   * city's venues (Ryan, 2026-10-09: "its earliest field's first match"), read in loadCityLaunches. */
  /* NO launch_date → THE FIELD'S FIRST PLAYED MATCH (Ryan, 2026-10-09: Hill Country Middle School
   * printed $0 for months before it existed). Read only for the venues that need it. */
  const noLaunch = useMemo(() => {
    if (!data) return null;
    const o: Record<string, number[]> = {};
    for (const v of data.venues) if (!v.launch_date) o[String(v.id)] = [];
    for (const [fid, vid] of data.venueFields) o[String(vid)]?.push(Number(fid));
    return o;
  }, [data]);
  const nowYmd = ymdOf(now);
  const venueFirst = useAsync(noLaunch ? `vfirst|${nowYmd}|${JSON.stringify(noLaunch)}` : null, () => loadVenueFirstPlayed(noLaunch!, nowYmd));
  const fieldLaunchYm = useCallback((name: string, city: string | null): Ym | null => {
    const legs = (data?.venues ?? []).filter((v) => v.venue_name === name && (v.city ?? null) === city);
    const dates = legs.map((v) => v.launch_date).filter((d): d is string => !!d).sort();
    if (dates.length) return dates[0].slice(0, 7);
    const first = legs.map((v) => venueFirst.data?.[String(v.id)]).filter((d): d is string => !!d).sort();
    return first.length ? first[0].slice(0, 7) : null;
  }, [data, venueFirst.data]);
  const fieldsByCity = useMemo(() => {
    if (!data) return null;
    const cityOf = new Map(data.venues.map((v) => [Number(v.id), canonCity(v.city)]));
    const o: Record<string, number[]> = {};
    for (const [fid, vid] of data.venueFields) { const c = cityOf.get(Number(vid)); if (c) (o[c] ??= []).push(Number(fid)); }
    return o;
  }, [data]);
  const cityLaunch = useAsync(fieldsByCity ? `launch|${JSON.stringify(fieldsByCity)}` : null, () => loadCityLaunches(fieldsByCity!));
  const cityLaunchYm = useCallback((label: string): Ym | null => {
    const d = cityLaunch.data?.[canonCity(label)];
    return d ? d.slice(0, 7) : null;
  }, [cityLaunch.data]);
  const launchYmOf = useCallback((g: GroupRow): Ym | null =>
    g.venueId != null ? fieldLaunchYm(g.label, g.city) : g.label === UNASSIGNED || g.city == null ? null : cityLaunchYm(g.label),
  [fieldLaunchYm, cityLaunchYm]);
  const scopeLaunch: Ym | null = filter.field ? fieldLaunchYm(fieldName!, fieldCity) : filter.city ? cityLaunchYm(filter.city) : null;

  /* ── THE MONTH RANGE (From / To, 4M / 6M / 12M / Since launch) ────────────────────────────────
   * Shared by the monthly card and the By month table. A preset ends at the selected period's last
   * month (never past this month), so 4M is exactly the old "period and the prior three" for a month;
   * picking a From or To by hand drops the preset and holds the range. Since launch needs a city or a
   * field, and goes back to 4M when the filter returns to All MatchDay. */
  const curYm = ymOfDate(now);
  const hist = useAsync(uid ? `hist|${uid}|${curYm}` : null,
    () => loadRollup(uid!, { from: HISTORY_FROM, to: ymdOf(new Date(now.getFullYear(), now.getMonth() + 1, 0)), grain: "month", byVenue: true }));
  const firstYm = useMemo(() => {
    let m: Ym | null = null;
    for (const r of hist.data ?? []) if (isRevenueRow(r)) { const y = ymOfPeriodKey(r.period); if (!m || y < m) m = y; }
    return m;
  }, [hist.data]);
  const periodEndYm = (() => { const y = ymOfDate(period.end); return y > curYm ? curYm : y; })();
  const [range, setRange] = useState<MonthRange>(() => presetRange("4", periodEndYm, null, null));
  const scopeKey = filter.field ?? filter.city ?? "";
  useEffect(() => {
    setRange((r) => {
      if (r.preset == null) return r;
      const next = r.preset === "since" && !scopeKey ? presetRange("4", periodEndYm, null, firstYm)
        : r.preset === "since" && !scopeLaunch ? r
        : presetRange(r.preset, periodEndYm, scopeLaunch, firstYm);
      return next.from === r.from && next.to === r.to && next.preset === r.preset ? r : next;
    });
  }, [periodEndYm, scopeKey, scopeLaunch, firstYm]);
  const choosePreset = (p: Preset) => setRange(presetRange(p, periodEndYm, scopeLaunch, firstYm));
  const chooseMonth = (which: "from" | "to", ym: Ym) => setRange((r) => {
    const n = { ...r, [which]: ym, preset: null };
    return n.from > n.to ? { from: n.to, to: n.from, preset: null } : n;
  });
  const rangeMonths = useMemo(() => monthsBetween(range.from, range.to), [range.from, range.to]);
  /* OLDEST TO NEWEST, LEFT TO RIGHT (Ryan, 2026-10-09: as it was before the rework). When the months
   * do not fit, the box is scrolled to its right end so the latest months show, with the row labels
   * pinned on the left — on load, and again whenever the range or the city / field changes. */
  const monthBox = useRef<HTMLDivElement | null>(null);
  // STABLE, so it fires when the box mounts (the card appears after the roster loads), not on every render.
  const monthBoxRef = useCallback((el: HTMLDivElement | null) => {
    monthBox.current = el;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);
  const monthOptions = useMemo(() => monthsBetween(firstYm && firstYm < range.from ? firstYm : range.from, curYm), [firstYm, range.from, curYm]);
  const rowsByMonth = useMemo(() => {
    const m = new Map<Ym, RollupRow[]>(rangeMonths.map((ym) => [ym, []]));
    for (const r of hist.data ?? []) m.get(ymOfPeriodKey(r.period))?.push(r);
    return m;
  }, [hist.data, rangeMonths]);

  /* MEMBER SPOTS FOR THE RANGE. A field's months need the city's member spots per field (membership
   * onto fields), which come from the roster loader. The page already holds the period and the
   * prior three; a range reaching further loads the missing months — at most four quarters, the
   * loader's limit — and anything older prints a dash marked "not loaded", never a zero. */
  const needShares = !!filter.field;
  const neededYms = needShares ? rangeMonths.filter((ym) => !covers(data, ym)) : [];
  const extraKey = neededYms.length ? `${neededYms[0]}|${neededYms[neededYms.length - 1]}` : "";
  const extraPeriod = useMemo(() => {
    if (!extraKey) return span;
    const [a, b] = extraKey.split("|");
    const qStart = addMonths(b, -(Number(b.slice(5, 7)) - 1) % 3); // first month of b's quarter
    const floor = addMonths(qStart, -9);                              // four quarters back
    return monthSpanPeriod(dateOfYm(a < floor ? floor : a), dateOfYm(b), now);
  }, [extraKey, span, now]);
  const { data: extra, loading: extraLoading } = useFinancePeriodData(extraPeriod);
  const monthKnown = useCallback((ym: Ym) => covers(data, ym) || covers(extra, ym), [data, extra]);
  const rangeShares = useCallback<MemberShares>((city, periodKey) => {
    const ym = ymOfPeriodKey(periodKey);
    const d = covers(data, ym) ? data : covers(extra, ym) ? extra : null;
    return d ? sharesOf(d, city, periodKey) : null;
  }, [data, extra]);
  const sharesPending = needShares && (primaryLoading || extraLoading);
  const notLoadedNote = "Member spots for this month are not loaded: a field's months reach back four quarters from the end of the range.";
  /* BEFORE AUG 2026 STRIPE CHARGES CARRY NO FIELD (measured 2026-10-09: 0% of DPP charges through
   * July, 90% in August, 100% from September), so a field's earlier months hold only its membership
   * share. Derived from the rows, not pinned: the first month where most DPP charges carry a field. */
  const fieldDataFrom = useMemo(() => {
    const by = new Map<Ym, { all: number; tied: number }>();
    for (const r of hist.data ?? []) {
      if (r.kind !== "charge" || r.excluded || bucketOf(r.type) !== "dpp") continue;
      const ym = ymOfPeriodKey(r.period), o = by.get(ym) ?? { all: 0, tied: 0 };
      o.all += r.gross_cents; if (r.fin_venue_id != null) o.tied += r.gross_cents; by.set(ym, o);
    }
    return [...by].sort(([a], [b]) => a.localeCompare(b)).find(([, o]) => o.all > 0 && o.tied * 2 >= o.all)?.[0] ?? null;
  }, [hist.data]);

  // ── THE MONTHLY CARD: one Totals per month in range, on the page's narrowing ──
  const monthly = useMemo(() => {
    if (!hist.data) return null;
    const out = new Map<Ym, { t: Totals | null; rows: number }>();
    for (const ym of rangeMonths) {
      if (filter.field && !monthKnown(ym)) { out.set(ym, { t: null, rows: 0 }); continue; }
      const rows = rowsByMonth.get(ym) ?? [];
      const n = filter.field ? filterRows(rows, filter, venues, rangeShares) : filterRows(rows, filter, venues);
      out.set(ym, { t: totalsOf(n), rows: n.filter(isRevenueRow).length });
    }
    return out;
  }, [hist.data, rangeMonths, rowsByMonth, filter, venues, rangeShares, monthKnown]);

  const monthsReady = !!monthly;
  useEffect(() => {
    const el = monthBox.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [range.from, range.to, filter.city, filter.field, monthsReady]);
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

  /* SWITCHING VIEW KEEPS WHAT THE NEXT VIEW CAN STILL USE: the page's City carries onto Match
   * View's own City select. Each switch puts the sort back to Net revenue, highest first. */
  const defaultSort = (): SortState => ({ key: "net", dir: -1 });
  const [sort, setSort] = useState<SortState>(defaultSort());
  const changeGrain = (next: Grain) => {
    if (next === grain) return;
    setGrain(next); setSort(defaultSort());
  };
  const onSort = (k: string) => setSort((cur) => nextSort(cur, k, TEXT_KEYS.has(k)));

  /* A ROW SETS THE PINNED FILTER, and the page follows it as it would from the selects. The top of
   * the page is where the change shows, so it scrolls there. */
  const toTop = () => { try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* old browsers */ } };
  const openCity = useCallback((label: string) => { setFilter({ city: label, field: null }); toTop(); }, []);
  const openField = useCallback((key: string, city: string | null) => {
    setClickedField(key);
    setFilter({ city: city && chipCities.includes(city) ? city : null, field: key });
    toTop();
  }, [chipCities]);
  const openGroup = useCallback((g: GroupRow) =>
    g.venueId != null ? () => openField(g.key.slice(1), g.city)
      : grain === "city" && g.label !== UNASSIGNED ? () => openCity(g.label) : null,
  [grain, openCity, openField]);

  /* THE EXPORT IS THE TABLE ON SCREEN: the same rows, in the same order. */
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
    const d = (c: number) => (c / 100).toFixed(2);
    const city = grain === "city";
    // THE SELECTED VIEW, cell for cell: the same GroupRows, in dollars to the cent, and the same
    // 4-week cells, with the window in their headers.
    const groups = grain === "city" ? cityGroups : fieldGroups;
    const total = groups.reduce((a, g) => a + g.net, 0);
    const p = pnlFor(grain);
    const ordered = orderRows(groups, sort, (g, k) => selectedValue(g, k, { matchesOf: city ? cityMatches : fieldMatches, venuesOf: city ? cityVenues : undefined, launchOf: launchYmOf, pnl: p }));
    const w = `last 4 completed weeks ${fp.win.label}`;
    const n2 = (v: number | null) => (v == null ? "" : v.toFixed(2));
    downloadCsv(`matchday-revenue-${grain}-${period.key}.csv`, [
      [city ? "City" : "Field", ...(city ? ["Venues"] : ["City"]), "Launched", "Period", "Matches (kicked off)",
        "DPP (before refunds)", "Membership (before refunds)", "Net revenue", ...(city ? ["Avg revenue / venue"] : []), "Member mix", "Share",
        `Matches (${w})`, `Revenue / match (${w}, play revenue before tax, refunds and Stripe fees)`, `Field cost / match (${w})`,
        `Net / match (${w})`, `Cost note (${w})`],
      ...ordered.map((g) => {
        const m = city ? cityMatches(g) : fieldMatches(g);
        const v = city ? cityVenues(g) : null;
        const c = g.label === UNASSIGNED ? null : p.of(g);
        const l = launchYmOf(g);
        const note = !c ? "" : [c.costText, c.profitShare ? "Profit share" : null, c.coverage ? `averages cover ${c.coverage}` : null,
          c.provisionalMonths.length ? `provisional until ${c.provisionalMonths.join(" and ")} closes` : null].filter(Boolean).join("; ");
        return [g.label, ...(city ? [v ?? ""] : [g.city ?? ""]), l ? shortYm(l) : "", period.label, m ?? "",
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

      {/* ── THE MONTHLY CARD: "Revenue for <scope>", a month range, oldest to newest ── */}
      <div className={s.card} data-testid="revenue-monthly">
        <div className="rv2-mhead">
          <h2 className="rv2-mtitle" data-testid="revenue-summary-title">Revenue for {fieldName ?? filter.city ?? "All MatchDay"}</h2>
          {scopeLaunch && <span className="rv2-launch" data-testid="summary-launched">Launched {shortYm(scopeLaunch)}</span>}
          <span className="rv2-grow" />
          <div className="rv2-range" data-testid="range-controls">
            <span className="rv2-rlab">Months</span>
            <select aria-label="From month" data-testid="range-from" value={range.from} onChange={(e) => chooseMonth("from", e.target.value)}>
              {monthOptions.map((ym) => <option key={ym} value={ym}>{shortYm(ym)}</option>)}
            </select>
            <span>to</span>
            <select aria-label="To month" data-testid="range-to" value={range.to} onChange={(e) => chooseMonth("to", e.target.value)}>
              {monthOptions.map((ym) => <option key={ym} value={ym}>{shortYm(ym)}</option>)}
            </select>
            {PRESETS.map(({ p, label }) => {
              const off = p === "since" && (!scopeKey || !scopeLaunch);
              return (
                <button key={p} type="button" className="rv2-pre" aria-pressed={range.preset === p} data-testid={`range-${p}`}
                  disabled={off} title={off ? (scopeKey ? "No launch date on file" : "Pick a city or a field first") : undefined}
                  onClick={() => choosePreset(p)}>{label}</button>
              );
            })}
          </div>
        </div>
        <div className={s.cardSub} data-testid="revenue-summary-sub">
          {shortYm(range.from)} to {shortYm(range.to)} · Central time
        </div>
        {hist.error ? (
          <div className={s.empty}>Revenue did not load: {hist.error}</div>
        ) : (
        <div className={s.tblWrap} ref={monthBoxRef} data-testid="revenue-summary-box">
          <table className={s.tbl} data-testid="revenue-summary">
            <thead>
              <tr>
                <th className="l">&nbsp;</th>
                {rangeMonths.map((ym) => (
                  <th key={ym} data-testid="revenue-summary-month" data-month={ym}>
                    {shortYm(ym)}
                    {ym === curYm && <i className={s.soFar}>so far</i>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUMMARY_ROWS.filter((row) => row.key !== "other" || rangeMonths.some((ym) => (monthly?.get(ym)?.t?.other ?? 0) !== 0)).map((row) => (
                <tr key={row.key} data-testid="revenue-summary-row" data-row={row.key}>
                  <td className="l" style={{ textAlign: "left" }}>{row.strong ? <b>{row.label}</b> : row.label}</td>
                  {rangeMonths.map((ym) => {
                    const c = monthly?.get(ym);
                    const v = c?.t ? row.pick(c.t) : null;
                    // A DASH, NOT $0, before launch — when the month holds nothing. A pre-launch month
                    // that does hold money shows it (San Antonio and OKC have charges before their first match).
                    const preLaunch = !!scopeLaunch && ym < scopeLaunch && c?.rows === 0;
                    const text = !monthly || (c && !c.t && sharesPending) ? "…"
                      : c && !c.t ? "—"
                      : preLaunch ? "—"
                      : v == null ? "…" : row.strong ? <b>{money(v)}</b> : money(v);
                    const title = c && !c.t && !sharesPending ? notLoadedNote : preLaunch ? "Before launch" : undefined;
                    return (
                      <td key={ym} data-testid={`sum-${row.key}`} data-month={ym} data-cents={preLaunch || v == null ? "" : v}
                        className={text === "—" ? "rv2-dim" : undefined} title={title}>{text}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        {filter.field && fieldDataFrom && range.from < fieldDataFrom && (
          <div className={s.legend} data-testid="field-history-note">
            <span>{`Before ${shortYm(fieldDataFrom)} Stripe charges do not carry a field, so a field's earlier months hold only its share of membership.`}</span>
          </div>
        )}
      </div>

      {/* ── ONE CARD: TOGGLES, COUNT, TABLE ── */}
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
          {grain === "match" ? (
            <span className={s.brkCount} data-testid="breakdown-basis">
              · DPP revenue per match from Stripe, net of tax, dated by kick-off <InfoI pop="matchmoney" label="DPP revenue per match" />
            </span>
          ) : (
            <span className={s.brkCount} data-testid="breakdown-basis">
              · {period.label}{grain === "field" && filter.city ? ` · ${filter.city}` : ""} · net revenue, Central time · click a column to sort, a row to show it above
            </span>
          )}
          <span className={s.brkGrow} />
          <button type="button" className={s.btn} data-testid="breakdown-export"
            onClick={exportTable}>Export</button>
        </div>

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
          <RevenueNetTable grain="city" groups={cityGroups} matchesOf={cityMatches} venuesOf={cityVenues} launchOf={launchYmOf}
            pnl={pnlFor("city")} sort={sort} onSort={onSort} onOpen={openGroup} />
        ) : (
          <RevenueNetTable grain="field" groups={fieldGroups} matchesOf={fieldMatches} launchOf={launchYmOf}
            pnl={pnlFor("field")} sort={sort} onSort={onSort} onOpen={openGroup} />
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

/* MEMBERSHIP ONTO FIELDS for one city-month, from one loaded roster — the Cities page's rule
 * (cityPnl.ts, "ALLOCATE membership onto the pitches"): field share = the field's member spots that
 * month ÷ the city's member spots that month. Null when the month has no member spots in `d`. */
function sharesOf(d: FinanceData, city: string, periodKey: string): { venueId: number; share: number }[] | null {
  const month = monthLabelOf(periodKey);
  const legs = d.venues.filter((v) => canonCity(v.city) === canonCity(city));
  if (legs.length === 0) return null;
  const citySpots = cityTotalMemberSpotsFor(d, legs[0].city, month);
  if (!(citySpots > 0)) return null;
  return legs
    .map((v) => ({ venueId: Number(v.id), share: venueMemberSpotsFor(d, v.id, month).member / citySpots }))
    .filter((x) => x.share > 0);
}
