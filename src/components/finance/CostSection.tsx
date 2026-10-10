"use client";

// FINANCE › COST — field cost against the revenue it carried.
//
// ── REVENUE IS THE REVENUE PAGE'S (Ryan, 2026-10-10) ─────────────────────────────────────────────
// Net revenue — after sales tax, refunds and disputes — from fin_txn, through the Revenue page's own
// code (src/lib/useNetRevenue.ts): a city is its City-tab row, a field is the sum of its legs' Field
// tab figures with membership credited by member spots. City rows plus Unassigned equal the Revenue
// page's total. It used to be roster-derived (booking price, credit included, player-cancelled
// bookings kept, membership valued at last month's per-spot rate) and read ~4.5% above the Revenue
// page in September 2026 ($84,213 against $80,554).
//
// ── FIELD COST IS UNCHANGED ──────────────────────────────────────────────────────────────────────
// ONE DERIVATION. Every row is a unit rate × the matches that have ALREADY KICKED OFF, or a share
// venue's own model, all in fieldEconomics.ts:
//   per_match     → the leg's per-match unit rate × realized matches
//   profit_share  → the partner dashboard's own owed — their share of revenue
//   monthly_flat  → a dash. Its figure lives only in an override, and nothing here reads one.
// DERIVED, NOT BILLED: nothing here reads fin_venue_cost_overrides. A DASH IS NOT A ZERO: a venue
// with no cost basis renders "—", is excluded from every ratio's cost, and is named in the
// cost-not-recorded list below the table. NO TARGET LINE: nobody set one.
//
// ── EVERY MONTH IS LOADED FOR WHAT IT IS ─────────────────────────────────────────────────────────
// The prior-month columns and the chart reach months outside the selected period. They used to be
// read out of the selected quarter's data, which holds neither their member spots nor (for the
// quarter column) their schedule — so October's "prior month" for San Antonio divided September's
// full cost by September's DPP alone (74.4% against a true 54.9%), and the prior-quarter column
// carried two months of cost against three of revenue (Austin 10.1%). The finance data now spans
// every month the page shows, each month owned by its own quarter's load.

import { useCallback, useMemo, useState } from "react";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { monthSpanPeriod } from "@/lib/financePeriod";
import {
  buildFieldMonths, byField, canonCity, costNotRecorded, ratioBand,
  COST_BASIS_LABEL, type FieldMonth,
} from "@/lib/fieldEconomics";
import { CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { isCityHidden } from "@/lib/types";
import { useNetRevenue } from "@/lib/useNetRevenue";
import { loadVenueLaunches, useAsync } from "@/lib/useRevenueTxn";
import { addMonths, dateOfYm, nextSort, shortYm, sortBy, ymOfDate, type SortState } from "@/lib/revenueRange";
import { downloadCsv, fmtInt, fmtMoney, fmtPct } from "@/components/growth/format";
import s from "./financeSection.module.css";

type Grain = "city" | "field";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ymOfLabel = (label: string) => `${label.slice(-4)}-${String(MON.indexOf(label.slice(0, 3)) + 1).padStart(2, "0")}`;
const labelOfYm = (ym: string) => `${MON[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const monName = (ym: string) => MON[Number(ym.slice(5, 7)) - 1];
const MAX_QUARTERS = 4; // useFinancePeriodData mounts at most four quarter loaders

/** One cell's money: revenue (dollars) and cost (null = no cost basis on file). */
type Cell = { revenue: number; cost: number | null };
const ratioOf = (c: Cell | null): number | null => (c && c.cost != null && c.revenue > 0 ? c.cost / c.revenue : null);
const addCell = (a: Cell, b: Cell): Cell => ({ revenue: a.revenue + b.revenue, cost: a.cost == null && b.cost == null ? null : (a.cost ?? 0) + (b.cost ?? 0) });
const ZERO: Cell = { revenue: 0, cost: null };

type Row = {
  key: string; label: string; city: string | null; pinned: boolean;
  launch: string | null;
  cur: Cell;
  /** Prior months' cells, oldest last (index 0 = the month just before the period). */
  prior: (Cell | null)[];
  allUnknown: boolean;
};

export default function CostSection() {
  const { period, now } = useFinancePeriod();
  const curYm = ymOfDate(now);
  const periodYms = useMemo(() => period.months.map(ymOfLabel), [period]);
  /* THE ANCHOR: the period's last month, never past this month. The chart is it and the three
   * before it; the ratio columns are the three months before the period's FIRST month. */
  const anchor = useMemo(() => { const l = periodYms[periodYms.length - 1] ?? curYm; return l > curYm ? curYm : l; }, [periodYms, curYm]);
  const chartYms = useMemo(() => [3, 2, 1, 0].map((n) => addMonths(anchor, -n)), [anchor]);
  const priorYms = useMemo(() => [1, 2, 3].map((n) => addMonths(periodYms[0] ?? anchor, -n)), [periodYms, anchor]);

  // ── THE LOAD WINDOW: every month on the page, at most four quarters (the loader's limit). ──
  const { span, loadedFrom } = useMemo(() => {
    const all = [...new Set([...periodYms, ...chartYms, ...priorYms])].sort();
    let from = all[0];
    let p = monthSpanPeriod(dateOfYm(from), period.end, now);
    while (p.quarters.length > MAX_QUARTERS) { from = addMonths(from, 3); p = monthSpanPeriod(dateOfYm(from), period.end, now); }
    return { span: p, loadedFrom: from };
  }, [periodYms, chartYms, priorYms, period.end, now]);
  const { data, loading } = useFinancePeriodData(span);
  const allYms = useMemo(() => [...new Set([...periodYms, ...chartYms, ...priorYms])].filter((m) => m >= loadedFrom).sort(), [periodYms, chartYms, priorYms, loadedFrom]);
  const net = useNetRevenue(allYms, data?.venues ?? null);

  const [grain, setGrain] = useState<Grain>("city");
  const [cityFilter, setCityFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortState>({ key: "rev", dir: -1 });
  const realizedThroughMs = now.getTime();
  const isPartial = period.isCurrent;
  const cities = useMemo(() => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)).map(canonCity), []);
  const inScope = useCallback((city: string | null) => cityFilter === "all" || canonCity(city) === canonCity(cityFilter), [cityFilter]);

  /* FIELD COST, as before: buildFieldMonths, realized through now. Its roster revenue is NOT read —
   * no registrations are passed — and each row's revenue is replaced by the Revenue page's net for
   * the field's legs. */
  const fieldMonths = useMemo(() => {
    if (!data || !net.byMonth) return [] as FieldMonth[];
    const fmMonths = allYms.map(labelOfYm) as Parameters<typeof buildFieldMonths>[2];
    return buildFieldMonths(data, [], fmMonths, realizedThroughMs).map((r) => {
      const nm = net.byMonth!.get(ymOfLabel(r.month));
      const cents = r.venueIds.reduce((a, id) => a + (nm?.venues.get(id)?.net ?? 0), 0);
      return { ...r, revenue: cents / 100, eventRevenue: 0, privateRental: 0, membership: null };
    });
  }, [data, net.byMonth, allYms, realizedThroughMs]);

  // ── LAUNCHED — the Revenue page's rule: the first played match, event fields aside unless flagged regular. ──
  const fieldsByVenue = useMemo(() => {
    if (!data) return null;
    const o: Record<string, number[]> = {};
    for (const v of data.venues) o[String(v.id)] = [];
    for (const [fid, vid] of data.venueFields) o[String(vid)]?.push(Number(fid));
    return o;
  }, [data]);
  const regularIds = useMemo(() => (data?.venueFieldLinks ?? []).filter((l) => l.counts_as_regular_play).map((l) => Number(l.mdapi_field_id)), [data]);
  const nowYmd = `${curYm}-${String(now.getDate()).padStart(2, "0")}`;
  const launches = useAsync(fieldsByVenue ? `vlaunch|${nowYmd}|${regularIds.join(",")}|${JSON.stringify(fieldsByVenue)}` : null,
    () => loadVenueLaunches(fieldsByVenue!, nowYmd, regularIds));
  const launchOfIds = useCallback((ids: number[]) => {
    const d = ids.map((id) => launches.data?.[String(id)]).filter((x): x is string => !!x).sort();
    return d.length ? d[0].slice(0, 7) : null;
  }, [launches.data]);
  const cityVenueIds = useCallback((city: string) => (data?.venues ?? []).filter((v) => canonCity(v.city) === canonCity(city)).map((v) => Number(v.id)), [data]);

  // ── CELLS ──
  const fieldCell = useCallback((key: string, ym: string): Cell | null => {
    const r = fieldMonths.find((x) => x.key === key && ymOfLabel(x.month) === ym);
    return r ? { revenue: r.revenue, cost: r.cost } : null;
  }, [fieldMonths]);
  const cityCost = useCallback((city: string, ym: string): number | null => {
    let c: number | null = null;
    for (const r of fieldMonths) if (canonCity(r.city) === canonCity(city) && ymOfLabel(r.month) === ym && r.cost != null) c = (c ?? 0) + r.cost;
    return c;
  }, [fieldMonths]);
  const cityCell = useCallback((city: string, ym: string): Cell | null => {
    const nm = net.byMonth?.get(ym);
    if (!nm) return null;
    return { revenue: (nm.cities.get(canonCity(city))?.net ?? 0) / 100, cost: cityCost(city, ym) };
  }, [net.byMonth, cityCost]);
  /** Everything in the city filter: one city, or all of MatchDay (Unassigned included). */
  const scopeCell = useCallback((ym: string): Cell | null => {
    const nm = net.byMonth?.get(ym);
    if (!nm) return null;
    if (cityFilter !== "all") return cityCell(cityFilter, ym);
    let cost: number | null = null;
    for (const r of fieldMonths) if (ymOfLabel(r.month) === ym && r.cost != null) cost = (cost ?? 0) + r.cost;
    return { revenue: nm.total / 100, cost };
  }, [net.byMonth, cityFilter, cityCell, fieldMonths]);
  const sumOver = (yms: string[], f: (ym: string) => Cell | null): Cell | null => {
    const cells = yms.map(f);
    if (cells.every((c) => c == null)) return null;
    return cells.reduce<Cell>((a, c) => (c ? addCell(a, c) : a), ZERO);
  };
  const loaded = (ym: string) => ym >= loadedFrom;

  // ── THE TABLE'S ROWS ──
  const rows = useMemo<Row[]>(() => {
    if (!net.byMonth || !data) return [];
    const prior = (f: (ym: string) => Cell | null) => priorYms.map((ym) => (loaded(ym) ? f(ym) : null));
    if (grain === "city") {
      const names = new Set<string>();
      for (const ym of periodYms) for (const c of net.byMonth.get(ym)?.cities.keys() ?? []) names.add(c);
      for (const r of fieldMonths) if (periodYms.includes(ymOfLabel(r.month)) && (r.cost != null || r.matches > 0)) names.add(canonCity(r.city));
      const out: Row[] = [...names].filter((c) => inScope(c)).map((c) => {
        const cur = sumOver(periodYms, (ym) => cityCell(c, ym)) ?? ZERO;
        return { key: `c-${c}`, label: c, city: c, pinned: false, launch: launchOfIds(cityVenueIds(c)), cur,
          prior: prior((ym) => cityCell(c, ym)), allUnknown: cur.cost == null };
      }).filter((r) => r.cur.revenue !== 0 || r.cur.cost != null);
      if (cityFilter === "all") {
        const un = (ym: string): Cell => ({ revenue: (net.byMonth!.get(ym)?.unassigned?.net ?? 0) / 100, cost: null });
        const cur = sumOver(periodYms, un) ?? ZERO;
        if (cur.revenue !== 0) out.push({ key: "unassigned", label: "Unassigned", city: null, pinned: true, launch: null, cur, prior: prior(un), allUnknown: true });
      }
      return out;
    }
    const byKey = new Map<string, FieldMonth[]>();
    for (const r of fieldMonths) if (inScope(r.city)) { const a = byKey.get(r.key) ?? []; a.push(r); byKey.set(r.key, a); }
    const out: Row[] = [];
    for (const [key, list] of byKey) {
      const cur = sumOver(periodYms, (ym) => fieldCell(key, ym)) ?? ZERO;
      const live = list.some((r) => periodYms.includes(ymOfLabel(r.month)) && (r.revenue !== 0 || (r.cost ?? 0) !== 0 || r.matches > 0));
      if (!live) continue;
      out.push({ key, label: list[0].field, city: list[0].city, pinned: false, launch: launchOfIds(list[0].venueIds), cur,
        prior: prior((ym) => fieldCell(key, ym)), allUnknown: list.filter((r) => periodYms.includes(ymOfLabel(r.month))).every((r) => r.cost == null) });
    }
    /* NO FIELD: the scope's revenue that no field carries — DPP without a field, membership no member
     * spot placed, and (for All cities) Unassigned. Pinned, so the fields plus it are the total. */
    const nf = (ym: string): Cell | null => {
      const t = scopeCell(ym); if (!t) return null;
      const fields = [...byKey.keys()].reduce((a, k) => a + (fieldCell(k, ym)?.revenue ?? 0), 0);
      return { revenue: Math.round((t.revenue - fields) * 100) / 100, cost: null };
    };
    const nfCur = sumOver(periodYms, nf) ?? ZERO;
    if (Math.abs(nfCur.revenue) >= 0.005) out.push({ key: "nofield", label: "No field", city: null, pinned: true, launch: null, cur: nfCur, prior: prior(nf), allUnknown: true });
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [net.byMonth, data, grain, periodYms, priorYms, fieldMonths, cityFilter, inScope, cityCell, fieldCell, scopeCell, launchOfIds, cityVenueIds, loadedFrom]);

  const total = useMemo(() => ({
    cur: sumOver(periodYms, scopeCell) ?? ZERO,
    prior: priorYms.map((ym) => (loaded(ym) ? scopeCell(ym) : null)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [periodYms, priorYms, scopeCell, loadedFrom]);

  // Tiles and the not-recorded list read the field rows of the selected period, in scope.
  const periodFields = useMemo(() => fieldMonths.filter((r) => periodYms.includes(ymOfLabel(r.month)) && inScope(r.city)
    && (r.revenue !== 0 || (r.cost ?? 0) !== 0 || r.matches > 0)), [fieldMonths, periodYms, inScope]);
  const dashedCount = useMemo(() => {
    if (grain === "city") return rows.filter((r) => !r.pinned && r.cur.cost == null).length;
    let n = 0; for (const g of byField(periodFields).values()) if (g.every((x) => x.cost == null)) n += 1; return n;
  }, [grain, rows, periodFields]);
  const gaps = useMemo(() => costNotRecorded(periodFields), [periodFields]);
  const lastFull = anchor < curYm ? anchor : addMonths(anchor, -1);
  const lastFullCell = loaded(lastFull) ? scopeCell(lastFull) : null;
  const series = useMemo(() => chartYms.map((ym) => {
    const c = loaded(ym) ? scopeCell(ym) : null;
    return { ym, revenue: c?.revenue ?? 0, cost: c?.cost ?? 0, ratio: ratioOf(c), partial: ym === curYm };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [chartYms, scopeCell, curYm, loadedFrom]);

  const valueOf = useCallback((r: Row, k: string): number | string | null => {
    if (k === "name") return r.label;
    if (k === "city") return r.city;
    if (k === "rev") return r.cur.revenue;
    if (k === "cost") return r.cur.cost;
    if (k === "ratio") return ratioOf(r.cur);
    const i = Number(k.slice(1));
    const ym = priorYms[i];
    return r.launch && ym < r.launch ? null : ratioOf(r.prior[i]);
  }, [priorYms]);
  const ordered = useMemo(() => [...sortBy(rows.filter((r) => !r.pinned), (r) => valueOf(r, sort.key), sort.dir), ...rows.filter((r) => r.pinned)], [rows, sort, valueOf]);
  const onSort = (k: string) => setSort((cur) => nextSort(cur, k, k === "name" || k === "city"));

  if (loading && !data) return <div className={s.empty}>Loading…</div>;
  if (!data) return <div className={s.empty}>No finance data for this period.</div>;
  if (net.error) return <div className={s.empty}>Revenue did not load: {net.error}</div>;
  if (!net.byMonth) return <div className={s.empty}>Loading…</div>;

  const T = total.cur;
  const max = Math.max(1, ...series.map((p) => Math.max(p.cost, p.revenue)));

  function exportTable() {
    const field = grain === "field";
    const pct = (c: Cell | null) => { const r = ratioOf(c); return r == null ? "" : (r * 100).toFixed(1) + "%"; };
    downloadCsv(`matchday-field-cost-${grain}-${period.key}.csv`, [
      [field ? "Field" : "City", ...(field ? ["City"] : []), "Launched", `Revenue (${period.label}, net, the Revenue page's)`, "Field cost", "Cost ratio",
        ...priorYms.map((ym) => `Cost ratio ${labelOfYm(ym)}`), ...priorYms.flatMap((ym) => [`Revenue ${labelOfYm(ym)}`, `Field cost ${labelOfYm(ym)}`])],
      ...[...ordered, { key: "total", label: cityFilter === "all" ? (field ? "All fields" : "All cities") : cityFilter, city: null, pinned: true, launch: null, cur: T, prior: total.prior, allUnknown: false } as Row].map((r) => [
        r.label, ...(field ? [r.city ?? ""] : []), r.launch ? shortYm(r.launch) : "",
        r.cur.revenue.toFixed(2), r.cur.cost == null ? "" : r.cur.cost.toFixed(2), pct(r.cur),
        ...priorYms.map((ym, i) => (r.launch && ym < r.launch ? "" : pct(r.prior[i]))),
        ...priorYms.flatMap((_, i) => [r.prior[i] ? r.prior[i]!.revenue.toFixed(2) : "", r.prior[i]?.cost == null ? "" : r.prior[i]!.cost!.toFixed(2)]),
      ]),
    ]);
  }

  const soFar = isPartial ? <i className={s.soFar}>so far</i> : null;
  return (
    <div className={s.wrap} data-testid="finance-cost">
      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>City</span>
          <div className={s.seg}>
            <button type="button" className={cityFilter === "all" ? s.on : ""} onClick={() => setCityFilter("all")}>All</button>
            {cities.map((c) => (
              <button key={c} type="button" className={cityFilter === c ? s.on : ""} onClick={() => setCityFilter(c)}>{c}</button>
            ))}
          </div>
        </div>
      </div>

      <div className={s.tiles}>
        <div className={s.tile}>
          <span className={s.tileLab}>Field cost ratio</span>
          <span className={s.tileVal} data-testid="cost-tile-ratio" data-partial={isPartial ? "1" : undefined}
            title={isPartial ? IN_PROGRESS : undefined} style={isPartial ? PARTIAL_STYLE : undefined}>
            {ratioOf(T) == null ? "—" : fmtPct(ratioOf(T)!)}{ratioOf(T) != null && soFar}</span>
        </div>
        <div className={s.tile}>
          <span className={s.tileLab} title={FIELD_COST_HOVER} data-testid="cost-hover-tile" style={{ textDecoration: "underline dotted", textUnderlineOffset: 3, cursor: "help" }}>Field cost</span>
          <span className={s.tileVal} data-testid="cost-tile-cost">
            {fmtMoney(T.cost ?? 0)}
            {dashedCount > 0 && <i className={s.excl} data-testid="cost-excluded">· {dashedCount} excluded</i>}
            {soFar}
          </span>
        </div>
        <div className={s.tile}>
          <span className={s.tileLab} title={REVENUE_HOVER} style={{ textDecoration: "underline dotted", textUnderlineOffset: 3, cursor: "help" }}>Revenue</span>
          <span className={s.tileVal} data-testid="cost-tile-revenue">{fmtMoney(T.revenue)}{soFar}</span>
        </div>
        {/* THE LAST FULL MONTH, beside a month in progress: what a whole month cost. */}
        <div className={s.tile}>
          <span className={s.tileLab}>Field cost · {labelOfYm(lastFull)}</span>
          <span className={s.tileVal} data-testid="cost-tile-lastfull">{lastFullCell?.cost == null ? "—" : fmtMoney(lastFullCell.cost)}</span>
          <span className={s.tileSub} data-testid="cost-tile-lastfull-ratio">
            {ratioOf(lastFullCell) == null ? "no ratio" : `${fmtPct(ratioOf(lastFullCell)!)} of ${fmtMoney(lastFullCell!.revenue)} revenue`}
          </span>
        </div>
      </div>

      <div className={s.card}>
        <div className={s.cardHead}>
          <span className={s.cardTitle}>Revenue, field cost and cost ratio · {labelOfYm(chartYms[0])} to {labelOfYm(chartYms[3])}</span>
        </div>
        <div className={s.chart} data-testid="cost-chart">
          {series.map((p) => (
            <div key={p.ym} className={s.col} data-testid="cost-chart-col" data-month={p.ym} style={p.partial ? { opacity: 0.5 } : undefined}>
              <span className={s.colVal} data-testid="cost-chart-ratio" title={p.partial ? IN_PROGRESS : undefined}
                style={p.partial ? { cursor: "help", textDecoration: "underline dotted", textUnderlineOffset: 3 } : undefined}>
                {p.ratio == null ? "—" : fmtPct(p.ratio, 0)}</span>
              <div className={s.stack} style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
                <div className={s.barB} style={{ height: `${(p.revenue / max) * 150}px`, flex: 1, borderRadius: "4px 4px 0 0" }} />
                <div className={s.barA} style={{ height: `${(p.cost / max) * 150}px`, flex: 1 }} />
              </div>
              <span className={s.colLab}>{labelOfYm(p.ym)}{p.partial && <i className={s.soFar}>so far</i>}</span>
              <span className={s.colVal}>{fmtMoney(p.cost)}</span>
            </div>
          ))}
        </div>
        <div className={s.legend}>
          <span><i className={`${s.dot} ${s.barB}`} />Revenue</span>
          <span><i className={`${s.dot} ${s.barA}`} />Field cost</span>
          <span>Ratio printed above each pair.</span>
        </div>
      </div>

      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Breakdown</span>
          <div className={s.seg}>
            <button type="button" data-testid="grain-city" aria-pressed={grain === "city"}
              className={grain === "city" ? s.on : ""} onClick={() => setGrain("city")}>City Economics</button>
            <button type="button" data-testid="grain-field" aria-pressed={grain === "field"}
              className={grain === "field" ? s.on : ""} onClick={() => setGrain("field")}>Field Economics</button>
          </div>
          <span className={s.ctrlLab} data-testid="breakdown-count">
            {fmtInt(rows.filter((r) => !r.pinned).length)} {grain === "city" ? "cities" : "fields"}
          </span>
        </div>
        <div className={s.ctrlGroup}>
          <button type="button" className={s.btn} onClick={exportTable}>Export</button>
        </div>
      </div>

      <p className={s.derivedNote} data-testid="cost-derived-note">
        Field cost: per-match rate × the matches that have already kicked off. Revenue: net, the same as the Revenue page.
      </p>

      <EconomicsTable rows={ordered} grain={grain} total={{ cur: T, prior: total.prior }} priorYms={priorYms}
        totalLabel={cityFilter === "all" ? (grain === "city" ? "All cities" : "All fields") : cityFilter}
        periodLabel={period.label} sort={sort} onSort={onSort} loaded={loaded} partial={isPartial} />

      {gaps.length > 0 && (
        <div className={s.gap} data-testid="cost-not-recorded">
          <p className={s.gapH}>Cost not recorded · {gaps.length} {gaps.length === 1 ? "field" : "fields"}</p>
          <div className={s.gapList}>
            {gaps.map((g) => (
              <span key={g.field} className={s.gapRow} data-testid="cost-gap-row">
                <b>{g.field}</b> · {g.city}
                <span className={`${s.bt} ${s.btNone}`}>{COST_BASIS_LABEL[g.basis]}</span>
                carried {fmtMoney(g.revenue)} of revenue with no cost basis on file, so its cost is
                held out of the ratio above rather than counted at $0.
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EconomicsTable({ rows, grain, total, priorYms, totalLabel, periodLabel, sort, onSort, loaded, partial }: {
  rows: Row[]; grain: Grain; total: { cur: Cell; prior: (Cell | null)[] }; priorYms: string[];
  totalLabel: string; periodLabel: string; sort: SortState; onSort: (k: string) => void; loaded: (ym: string) => boolean;
  /** The selected period is still in progress: its Cost ratio column renders lighter, with IN_PROGRESS. */
  partial: boolean;
}) {
  if (rows.length === 0) return <div className={s.empty}>No fields match this selection.</div>;
  const field = grain === "field";
  const th = (k: string, label: React.ReactNode, cls?: string, title?: string) => {
    const on = sort.key === k;
    return (
      <th className={cls} style={cls === "l" ? { textAlign: "left" } : undefined} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} data-testid={`cost-th-${k}`}>
        <button type="button" className={s.sortBtn} onClick={() => onSort(k)} title={title}>
          {label}<span className={on ? `${s.sortArr} ${s.sortOn}` : s.sortArr} aria-hidden="true">{on && sort.dir === 1 ? "▲" : "▼"}</span>
        </button>
      </th>
    );
  };
  const tip = (ym: string | null, c: Cell | null) => (c ? `${ym ? labelOfYm(ym) : periodLabel}: revenue ${fmtMoney(c.revenue)} · field cost ${c.cost == null ? "not recorded" : fmtMoney(c.cost)}` : undefined);
  const ratioCell = (c: Cell | null, ym: string | null, why: string | null, testid: string, pill = false) => {
    const r = why ? null : ratioOf(c);
    // THE SELECTED MONTH IN PROGRESS: lighter, and the hover says why the ratio reads low.
    const inProgress = ym == null && partial;
    return (
      <td className={r == null ? s.mut : ""} data-testid={testid} data-partial={inProgress ? "1" : undefined}
        title={why ?? (inProgress ? IN_PROGRESS : tip(ym, c))} style={inProgress && r != null ? PARTIAL_STYLE : undefined}>
        {r == null ? "—" : pill ? (
          <span className={`${s.pill} ${s[ratioBand(r)]}`} data-testid="cost-ratio-pill" data-band={ratioBand(r)}><i className={s.pillDot} />{fmtPct(r)}</span>
        ) : fmtPct(r)}
      </td>
    );
  };
  const priorWhy = (r: Row, ym: string) => (!loaded(ym) ? "Not loaded: the page loads at most four quarters" : r.launch && ym < r.launch ? `Before ${r.label} launched` : null);
  return (
    <div className={s.card}>
      <div className={s.tblWrap}>
        <table className={s.tbl} data-testid="cost-economics-table">
          <thead>
            <tr>
              {th("name", field ? "Field" : "City", "l")}
              {field && th("city", "City", "l")}
              {th("rev", "Revenue", undefined, REVENUE_HOVER)}
              {th("cost", <span title={FIELD_COST_HOVER} data-testid="cost-hover-th">Field cost</span>)}
              {th("ratio", "Cost ratio", undefined, partial ? IN_PROGRESS : undefined)}
              {priorYms.map((ym, i) => th(`p${i}`, monName(ym), undefined, `Cost ratio, all of ${labelOfYm(ym)}`))}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.key} data-testid={x.pinned ? "cost-pinned-row" : "cost-row"} data-label={x.label} className={x.pinned ? s.pinRow : undefined}>
                <td className="l" style={{ textAlign: "left" }}>{x.pinned ? <i>{x.label}</i> : <b>{x.label}</b>}</td>
                {field && <td className="l" style={{ textAlign: "left" }}>{x.city ?? "—"}</td>}
                <td data-testid="cost-revenue-cell" data-cents={Math.round(x.cur.revenue * 100)}>{fmtMoney(x.cur.revenue)}</td>
                <td className={x.cur.cost == null ? s.mut : ""} data-testid="cost-amount-cell" data-cents={x.cur.cost == null ? "" : Math.round(x.cur.cost * 100)}>{x.cur.cost == null ? "—" : fmtMoney(x.cur.cost)}</td>
                {ratioCell(x.cur, null, null, "cost-ratio-cell", true)}
                {priorYms.map((ym, i) => <RatioTd key={ym} c={x.prior[i]} ym={ym} why={x.pinned ? "" : priorWhy(x, ym)} tip={tip} testid={`cost-prior-${i}`} />)}
              </tr>
            ))}
            <tr className={s.tot} data-testid="cost-total-row">
              <td className="l" style={{ textAlign: "left" }}>{totalLabel}</td>
              {field && <td className="l" style={{ textAlign: "left" }}>—</td>}
              <td data-cents={Math.round(total.cur.revenue * 100)}>{fmtMoney(total.cur.revenue)}</td>
              <td>{fmtMoney(total.cur.cost ?? 0)}</td>
              {ratioCell(total.cur, null, null, "cost-total-ratio")}
              {priorYms.map((ym, i) => <RatioTd key={ym} c={total.prior[i]} ym={ym} why={loaded(ym) ? null : "Not loaded"} tip={tip} testid={`cost-total-prior-${i}`} />)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A prior month's ratio. `why` "" = a pinned row (no ratio, no hover); a string = a dash with that reason. */
function RatioTd({ c, ym, why, tip, testid }: { c: Cell | null; ym: string; why: string | null; tip: (ym: string | null, c: Cell | null) => string | undefined; testid: string }) {
  const r = why != null ? null : ratioOf(c);
  return <td className={r == null ? s.mut : ""} data-testid={testid} title={why ? why : why === "" ? undefined : tip(ym, c)}>{r == null ? "—" : fmtPct(r)}</td>;
}

/* WHAT THIS PAGE'S FIELD COST IS (Ryan, 2026-10-09): the rate side, in the month the matches happen —
 * never the month bill, and never a cost per match override (fieldEconomics reads legRateUnitCost). */
const FIELD_COST_HOVER = "Field Costs rate × matches played, in the month they were played. OpEx shows when the bill is paid.";
const REVENUE_HOVER = "Net revenue, the same as the Revenue page.";
/* A MONTH IN PROGRESS READS LOW (Ryan, 2026-10-10): revenue counts every charge so far — the
 * memberships billed on the 1st and bookings for matches still to come — while field cost counts
 * only matches already played. Shown, lighter, with this said on hover; never adjusted. */
const IN_PROGRESS = "Month in progress. Revenue includes memberships billed on the 1st and bookings for matches not yet played; field cost counts only matches played so far. Compare full months.";
const PARTIAL_STYLE: React.CSSProperties = { opacity: 0.5, cursor: "help" };
