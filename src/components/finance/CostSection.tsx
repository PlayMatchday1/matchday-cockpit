"use client";

// FINANCE › COST — field cost against the revenue it carried.
//
// NOTHING HERE IS A CONSTANT. A month's field cost is DERIVED, every time:
//   per_match     → a unit rate × the matches that month. WHICH unit rate depends on the Basis
//                   control: Per-Match reads cost_per_match (steady, lumps removed), As Billed
//                   reads the override if one exists and otherwise per_match_rate (what was
//                   actually invoiced). Those are two different facts, not one entered twice, and
//                   four venues differ sharply between them — see fieldEconomics.CostMode.
//   monthly_flat  → the flat amount recorded for the month; cost_per_match is never consulted
//   profit_share  → the partner dashboard's own owed, computed by the same code the partner page
//                   renders. cost_per_match is never read for a share venue, which is what makes
//                   Crossbar Rowlett's placeholder zero UNREACHABLE rather than special-cased.
// All of that lives in fieldEconomics.ts; this file only arranges it.
//
// A DASH IS NOT A ZERO. A venue with no cost basis on file renders "—", is excluded from every
// ratio, and is named in the cost-not-recorded list below the table so the gap is fillable. A
// venue billed per_match at a real rate of $0 — Carroll Senior HS — renders $0, because free is a
// fact and hiding it behind a dash would be its own lie.
//
// NO TARGET LINE. Nobody set 50%, or any other figure: it appears nowhere in src, docs, supabase
// or scripts. The fourth tile is therefore the MEASURED highest-ratio field, not a threshold
// count.
//
// THE BILLING TYPE IS ON EVERY ROW. A share venue in a thin month can show a ratio over 100% —
// true, and unreadable as anything but an error unless the row says how the money moves.

import { useMemo, useState } from "react";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useMatchRangeData } from "@/lib/useMatchData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { matchRange } from "@/lib/financePeriod";
import {
  buildFieldMonths, byCity, byField, canonCity, costNotRecorded, highestRatioField, rollup,
  priorMonthOf, priorQuarterOf, pooledRatio, ratioBand,
  COST_BASIS_LABEL, type CostBasis, type CostMode, type FieldMonth,
} from "@/lib/fieldEconomics";
import { CITY_DISPLAY_ORDER, type Q2Month } from "@/lib/financeStats";
import { isCityHidden } from "@/lib/types";
import { downloadCsv, fmtInt, fmtMoney, fmtPct } from "@/components/growth/format";
import s from "./financeSection.module.css";

type Grain = "city" | "field";

// The three real structures. hourly_rate is null on every fin_venues row and nothing is recorded
// as an installation or a free-use arrangement, so the filter offers what exists and no more.
const STRUCTURES: readonly CostBasis[] = ["per_match", "profit_share", "monthly_flat"];

export default function CostSection() {
  // The window is the page's period. This card used to carry its own Jul/Aug/Sep segment, which
  // was the second of the two controls doing one job.
  const { period, now } = useFinancePeriod();
  const { data, loading } = useFinancePeriodData(period);
  // BOTH LOADERS GATE THE RENDER. useMatchData pulls every match-player row and takes far longer
  // than the finance fetch; rendering on the finance half alone put a REAL-LOOKING $0 in the
  // revenue column of every city for as long as it took to arrive. A zero is a claim, and this
  // page's whole argument is that a number you do not have yet is not a number you may print.
  // The period's own window — see the note on CityPnlTable. buildFieldMonths buckets by
  // `months`, so rows outside the period never reach a figure on this page.
  // THE WINDOW REACHES BACK A QUARTER. The two prior-ratio columns need cost AND revenue for the
  // preceding calendar month and the preceding calendar quarter, and revenue is roster-derived —
  // so those months' match rows have to be loaded too. Without this the columns would render a
  // dash for everything and look like missing data rather than an unfetched window.
  const priorMonth = useMemo(() => (period.months[0] ? priorMonthOf(period.months[0]) : null), [period]);
  const priorQuarter = useMemo(() => (period.months[0] ? priorQuarterOf(period.months[0]) : []), [period]);
  const extraMonths = useMemo(
    () => [...new Set([...priorQuarter, ...(priorMonth ? [priorMonth] : [])])],
    [priorQuarter, priorMonth],
  );
  const windowStart = useMemo(() => {
    // Earliest month we need, as a local-midnight date.
    const all = [...extraMonths];
    if (all.length === 0) return period.start;
    const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const parsed = all.map((k) => { const [mo, yr] = k.split(" "); return new Date(Number(yr), M.indexOf(mo), 1); });
    const earliest = parsed.reduce((a, b) => (a < b ? a : b), parsed[0]);
    return earliest < period.start ? earliest : period.start;
  }, [extraMonths, period]);
  const { fromDate, toDate } = useMemo(() => matchRange(windowStart, period.end), [windowStart, period]);
  const { rows: matchRegistrations, loading: matchLoading } = useMatchRangeData(fromDate, toDate);

  const [structures, setStructures] = useState<Set<CostBasis>>(() => new Set(STRUCTURES));
  const [grain, setGrain] = useState<Grain>("city");
  const [cityFilter, setCityFilter] = useState<string>("all");
  // BOTH BASES, DEFAULTING TO PER-MATCH — the basis the brief specified and the one Cities opens
  // on. Offering only one would make this page disagree with Cities for four venues whose lumpy
  // invoices land in months other than the ones they cover (NEMP, Onion Creek, Bicentennial Park,
  // Lowell H. Strike), and the reader would have no way to see which number they were looking at.
  // DEFAULT: AS BILLED — the same derivation Field Costs, OpEx and Cash Flow use, so the page
  // opens on the number those three agree on. The per-match basis is unchanged and still one
  // click away; the toggle is the explanation, so there is no sentence here saying so.
  const [mode, setMode] = useState<CostMode>("as_billed");

  // THE PERIOD IS THE WINDOW. The tiles describe the whole of it, at whatever grain was asked
  // for, and it is partial exactly when the period bar says it is.
  const months = period.months;
  const isPartial = period.isCurrent;

  const cities = useMemo(() => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)).map(canonCity), []);

  // Rows for the period AND the prior windows, from one call — so the prior figures come off the
  // same derivation as the current one and cannot drift from it.
  const everyMonth = useMemo(() => [...new Set([...extraMonths, ...months])], [extraMonths, months]);
  const everyRow = useMemo(
    () => (data ? buildFieldMonths(data, matchRegistrations, everyMonth, mode) : []),
    [data, matchRegistrations, everyMonth, mode],
  );
  const allRows = useMemo(() => everyRow.filter((r) => months.includes(r.month)), [everyRow, months]);

  const monthRows = allRows;

  // The structure filter narrows WHICH FIELDS are in scope. It is a filter on the estate, not on
  // the arithmetic — the totals below are always the sum of the rows on screen.
  const scoped = useMemo(
    () => monthRows.filter((r) => structures.has(r.basis) && (cityFilter === "all" || r.city === canonCity(cityFilter))),
    [monthRows, structures, cityFilter],
  );
  // A field with neither cost nor revenue in the month did not trade; listing it adds a row of
  // dashes and nothing else.
  const live = useMemo(() => scoped.filter((r) => r.revenue > 0 || (r.cost ?? 0) !== 0 || r.matches > 0), [scoped]);

  // PRIOR RATIOS, per entity, on the SAME structure/city filters as the table. Keyed by city and
  // by field so either grain can look itself up. pooledRatio is cost-summed ÷ revenue-summed over
  // the window — never an average of monthly ratios.
  const priorRatios = useMemo(() => {
    const scopedAll = everyRow.filter(
      (r) => structures.has(r.basis) && (cityFilter === "all" || r.city === canonCity(cityFilter)),
    );
    const build = (monthsIn: string[]) => {
      const rows = scopedAll.filter((r) => monthsIn.includes(r.month));
      const cityMap = new Map<string, number | null>();
      for (const [k, g] of byCity(rows)) cityMap.set(k, pooledRatio(g));
      const fieldMap = new Map<string, number | null>();
      for (const [k, g] of byField(rows)) fieldMap.set(k, pooledRatio(g));
      return { cityMap, fieldMap, any: rows.length > 0 };
    };
    return {
      month: build(priorMonth ? [priorMonth] : []),
      quarter: build(priorQuarter),
    };
  }, [everyRow, structures, cityFilter, priorMonth, priorQuarter]);

  // The same grouping the table performs — a second count computed another way is how a caption
  // and its table start disagreeing.
  const rowCount = useMemo(
    () => (grain === "city" ? byCity(live) : byField(live)).size,
    [live, grain],
  );

  // ROWS THE FIELD COST CARD DOES NOT INCLUDE. rollup skips an unknown-cost row when summing cost
  // but still counts its revenue, so the card's total is smaller than the table it sits over by an
  // amount nothing on screen names. This is that count — grouped the SAME way the table groups, so
  // it is the number of DASHES a reader can see, and it moves with the grain, the month and the
  // structure/city filters because `live` does.
  const dashedCount = useMemo(() => {
    const grouped = grain === "city" ? byCity(live) : byField(live);
    let n = 0;
    for (const g of grouped.values()) if (g.every((x) => x.cost == null)) n += 1;
    return n;
  }, [live, grain]);

  const T = useMemo(() => rollup(live), [live]);
  const worst = useMemo(() => highestRatioField(live), [live]);
  const gaps = useMemo(() => costNotRecorded(live), [live]);

  // Chart: every month of the quarter under the same filters, so the selected month is read
  // against its neighbours rather than in isolation.
  const seriesRows = useMemo(
    () => allRows.filter((r) => structures.has(r.basis) && (cityFilter === "all" || r.city === canonCity(cityFilter))),
    [allRows, structures, cityFilter],
  );
  const series = useMemo(
    () => months.map((m) => {
      const r = rollup(seriesRows.filter((x) => x.month === m));
      // TOTAL revenue, matching the column and the ratio's denominator. The chart used to plot
      // revenueWithKnownCost, so its bars and its printed ratio disagreed with the table.
      return { month: m, cost: r.cost, revenue: r.revenue, ratio: r.ratio };
    }),
    [months, seriesRows],
  );

  if ((loading && !data) || matchLoading) return <div className={s.empty}>Loading…</div>;
  if (!data) return <div className={s.empty}>No finance data for this quarter.</div>;

  const toggleStructure = (b: CostBasis) =>
    setStructures((prev) => {
      const next = new Set(prev);
      // Never let the last one off — an empty estate is not a view, it is a blank screen.
      if (next.has(b) && next.size > 1) next.delete(b);
      else next.add(b);
      return next;
    });

  const max = Math.max(1, ...series.map((p) => Math.max(p.cost, p.revenue)));

  function exportTable() {
    const grouped = grain === "city" ? byCity(live) : byField(live);
    downloadCsv(`matchday-field-cost-${period.key}.csv`, [
      [grain === "city" ? "City" : "Field", "City", "Billing", "Matches", "Revenue", "Event revenue", "Ratio denominator", "Field cost", "Cost ratio", "Cost recorded"],
      ...[...grouped.values()].map((rows) => {
        const r = rollup(rows);
        return [
          grain === "city" ? rows[0].city : rows[0].field,
          rows[0].city,
          grain === "city" ? [...new Set(rows.map((x) => COST_BASIS_LABEL[x.basis]))].join(" + ") : COST_BASIS_LABEL[rows[0].basis],
          r.matches,
          r.revenue.toFixed(2),
          r.eventRevenue.toFixed(2),
          r.revenueWithKnownCost.toFixed(2),
          r.unknownFields === rows.length ? "" : r.cost.toFixed(2),
          r.ratio == null ? "" : (r.ratio * 100).toFixed(1) + "%",
          r.unknownFields === rows.length ? "no" : r.unknownFields > 0 ? "partial" : "yes",
        ];
      }),
    ]);
  }

  return (
    <div className={s.wrap} data-testid="finance-cost">
      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Basis</span>
          <div className={s.seg}>
            <button type="button" data-testid="basis-per-match" aria-pressed={mode === "per_match"}
              className={mode === "per_match" ? s.on : ""} onClick={() => setMode("per_match")}
              title="cost_per_match × charged matches. Steady month to month — billing-timing lumps removed.">
              Per-Match
            </button>
            <button type="button" data-testid="basis-as-billed" aria-pressed={mode === "as_billed"}
              className={mode === "as_billed" ? s.on : ""} onClick={() => setMode("as_billed")}
              title="What the venue invoiced: an override where one exists, else per_match_rate × matches.">
              As Billed
            </button>
          </div>
        </div>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Structure</span>
          <div className={s.seg}>
            {STRUCTURES.map((b) => (
              <button key={b} type="button" className={structures.has(b) ? s.on : ""} onClick={() => toggleStructure(b)}>
                {COST_BASIS_LABEL[b]}
              </button>
            ))}
          </div>
        </div>
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
          <span className={s.tileVal} data-testid="cost-tile-ratio">
            {T.ratio == null ? "—" : fmtPct(T.ratio)}
            {isPartial && T.ratio != null && <i className={s.soFar}>so far</i>}
          </span>
        </div>
        <div className={s.tile}>
          <span className={s.tileLab}>Field cost</span>
          <span className={s.tileVal}>
            {fmtMoney(T.cost)}
            {/* NOTHING AT ALL WHEN NOTHING IS EXCLUDED. The marker is the whole signal — no
                subtitle, no banner, no colour. It says a number is missing, not which: the
                "Cost not recorded" block below the table already names them. */}
            {dashedCount > 0 && (
              <i className={s.excl} data-testid="cost-excluded">· {dashedCount} excluded</i>
            )}
            {isPartial && <i className={s.soFar}>so far</i>}
          </span>
        </div>
        <div className={s.tile}>
          <span className={s.tileLab}>Revenue</span>
          <span className={s.tileVal}>
            {fmtMoney(T.revenue)}
            {isPartial && <i className={s.soFar}>so far</i>}
          </span>
        </div>
        {/* MEASURED, NOT ASSERTED. There is no target to be above. */}
        <div className={s.tile}>
          <span className={s.tileLab}>Highest-ratio field</span>
          <span className={s.tileVal} data-testid="cost-tile-worst">{worst ? worst.field : "—"}</span>
          <span className={s.tileSub}>
            {worst ? `${fmtPct(worst.ratio)} · ${worst.city}` : "no field with both a cost and revenue this month"}
          </span>
        </div>
      </div>

      <div className={s.card}>
        <div className={s.cardHead}>
          <span className={s.cardTitle}>Revenue, field cost and cost ratio · {period.label}</span>
        </div>
        <div className={s.chart}>
          {series.map((p) => (
            <div key={p.month} className={s.col}>
              <span className={s.colVal}>{p.ratio == null ? "—" : fmtPct(p.ratio, 0)}</span>
              <div className={s.stack} style={{ flexDirection: "row", alignItems: "flex-end", gap: 4 }}>
                <div className={s.barB} style={{ height: `${(p.revenue / max) * 150}px`, flex: 1, borderRadius: "4px 4px 0 0" }} />
                <div className={s.barA} style={{ height: `${(p.cost / max) * 150}px`, flex: 1 }} />
              </div>
              <span className={s.colLab}>{p.month}</span>
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
          {/* COUNTS THE ROWS ACTUALLY RENDERED for the selected month, so it moves with the month
              filter and with the structure/city filters. A count that did not would be a caption
              describing a different table. */}
          <span className={s.ctrlLab} data-testid="breakdown-count">
            {rowCount} {grain === "city" ? (rowCount === 1 ? "city" : "cities") : (rowCount === 1 ? "field" : "fields")}
          </span>
        </div>
        <div className={s.ctrlGroup}>
          <button type="button" className={s.btn} onClick={exportTable}>Export</button>
        </div>
      </div>

      <EconomicsTable rows={live} grain={grain} total={T} prior={priorRatios} />

      {gaps.length > 0 && (
        <div className={s.gap} data-testid="cost-not-recorded">
          <p className={s.gapH}>Cost not recorded · {gaps.length} {gaps.length === 1 ? "field" : "fields"}</p>
          <div className={s.gapList}>
            {gaps.map((g) => (
              <span key={g.field} className={s.gapRow} data-testid="cost-gap-row">
                <b>{g.field}</b> · {g.city}
                <span className={`${s.bt} ${s.btNone}`}>{COST_BASIS_LABEL[g.basis]}</span>
                carried {fmtMoney(g.revenue)} of revenue with no cost basis on file, so it is held
                out of the ratio above rather than counted at $0.
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EconomicsTable({
  rows, grain, total, prior,
}: {
  rows: FieldMonth[];
  grain: Grain;
  total: ReturnType<typeof rollup>;
  prior: {
    month: { cityMap: Map<string, number | null>; fieldMap: Map<string, number | null>; any: boolean };
    quarter: { cityMap: Map<string, number | null>; fieldMap: Map<string, number | null>; any: boolean };
  };
}) {
  if (rows.length === 0) return <div className={s.empty}>No fields match this selection.</div>;
  const grouped = grain === "city" ? byCity(rows) : byField(rows);
  const list = [...grouped.values()]
    .map((g) => ({
      // byCity keys on city, byField keys on FieldMonth.key — match both exactly.
      key: grain === "city" ? g[0].city : g[0].key,
      label: grain === "city" ? g[0].city : g[0].field,
      city: g[0].city,
      bases: [...new Set(g.map((x) => x.basis))],
      allUnknown: g.every((x) => x.cost == null),
      r: rollup(g),
    }))
    .sort((a, b) => b.r.revenue - a.r.revenue);

  // THE RANK IS ASSIGNED BY REVENUE AND THEN TRAVELS WITH THE ROW. Assigned here, off the
  // revenue-sorted list, so #1 is the top earner whatever the table is later sorted by — a rank
  // that renumbered itself on sort would be a row index wearing a badge.
  const ranked = list.map((x, i) => ({ ...x, rank: i + 1 }));

  const priorFor = (which: "month" | "quarter", x: (typeof ranked)[number]) =>
    (grain === "city" ? prior[which].cityMap : prior[which].fieldMap).get(x.key) ?? null;

  const dash = <span className={s.mut}>—</span>;

  return (
    <div className={s.card}>
      <div className={s.tblWrap}>
        <table className={s.tbl} data-testid="cost-economics-table">
          <thead>
            <tr>
              <th data-testid="cost-th-rank">#</th>
              <th className="l">{grain === "city" ? "City" : "Field"}</th>
              {grain === "field" && <th className="l">City</th>}
              {grain === "field" && <th className="l">Cost structure</th>}
              <th>Revenue</th>
              <th>Field cost</th>
              <th>Cost ratio</th>
              <th>Prior month ratio</th>
              <th>Prior quarter ratio</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((x) => {
              const pm = priorFor("month", x);
              const pq = priorFor("quarter", x);
              return (
                <tr key={x.label} data-testid="cost-row">
                  <td><span className={s.rank} data-testid="cost-rank">{x.rank}</span></td>
                  <td className="l"><b>{x.label}</b></td>
                  {grain === "field" && <td className="l">{x.city}</td>}
                  {grain === "field" && (
                    <td className="l" data-testid="cost-structure">
                      {x.bases.map((b) => COST_BASIS_LABEL[b]).join(" + ")}
                    </td>
                  )}
                  <td data-testid="cost-revenue-cell">{fmtMoney(x.r.revenue)}</td>
                  <td className={x.allUnknown ? s.mut : ""} data-testid="cost-amount-cell">
                    {x.allUnknown ? "—" : fmtMoney(x.r.cost)}
                  </td>
                  <td data-testid="cost-ratio-cell">
                    {x.r.ratio == null ? dash : (
                      <span className={`${s.pill} ${s[ratioBand(x.r.ratio)]}`} data-testid="cost-ratio-pill"
                        data-band={ratioBand(x.r.ratio)}>
                        <i className={s.pillDot} />{fmtPct(x.r.ratio)}
                      </span>
                    )}
                  </td>
                  <td className={pm == null ? s.mut : ""} data-testid="cost-prior-month">
                    {pm == null ? "—" : fmtPct(pm)}
                  </td>
                  <td className={pq == null ? s.mut : ""} data-testid="cost-prior-quarter">
                    {pq == null ? "—" : fmtPct(pq)}
                  </td>
                </tr>
              );
            })}
            <tr className={s.tot} data-testid="cost-total-row">
              <td />
              <td className="l">{grain === "city" ? "All cities" : "All fields"}</td>
              {grain === "field" && <td className="l">—</td>}
              {grain === "field" && <td className="l">—</td>}
              <td>{fmtMoney(total.revenue)}</td>
              <td>{fmtMoney(total.cost)}</td>
              <td>{total.ratio == null ? dash : fmtPct(total.ratio)}</td>
              <td>—</td>
              <td>—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
