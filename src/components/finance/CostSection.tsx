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
  const { fromDate, toDate } = useMemo(() => matchRange(period.start, period.end), [period]);
  const { rows: matchRegistrations, loading: matchLoading } = useMatchRangeData(fromDate, toDate);

  const [structures, setStructures] = useState<Set<CostBasis>>(() => new Set(STRUCTURES));
  const [grain, setGrain] = useState<Grain>("city");
  const [cityFilter, setCityFilter] = useState<string>("all");
  // BOTH BASES, DEFAULTING TO PER-MATCH — the basis the brief specified and the one Cities opens
  // on. Offering only one would make this page disagree with Cities for four venues whose lumpy
  // invoices land in months other than the ones they cover (NEMP, Onion Creek, Bicentennial Park,
  // Lowell H. Strike), and the reader would have no way to see which number they were looking at.
  const [mode, setMode] = useState<CostMode>("per_match");

  // THE PERIOD IS THE WINDOW. The tiles describe the whole of it, at whatever grain was asked
  // for, and it is partial exactly when the period bar says it is.
  const months = period.months;
  const isPartial = period.isCurrent;

  const cities = useMemo(() => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)).map(canonCity), []);

  const allRows = useMemo(
    () => (data ? buildFieldMonths(data, matchRegistrations, months, mode) : []),
    [data, matchRegistrations, months, mode],
  );

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
      return { month: m, cost: r.cost, revenue: r.revenueWithKnownCost, ratio: r.ratio };
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
            <button type="button" className={mode === "per_match" ? s.on : ""} onClick={() => setMode("per_match")}
              title="cost_per_match × charged matches. Steady month to month — billing-timing lumps removed.">
              Per-Match
            </button>
            <button type="button" className={mode === "as_billed" ? s.on : ""} onClick={() => setMode("as_billed")}
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
          <span className={s.tileSub}>
            {T.ratio == null
              ? "no revenue at a costed field this month"
              : `${fmtMoney(T.cost)} against ${fmtMoney(T.revenueWithKnownCost)} at costed fields` +
                // Event play is real revenue that carries no venue cost by policy. Dividing cost
                // by a denominator that included it would report a pitch as nearly free.
                (T.eventRevenue > 0 ? ` · ${fmtMoney(T.eventRevenue)} of event play excluded — events are not billed as matches` : "")}
          </span>
        </div>
        <div className={s.tile}>
          <span className={s.tileLab}>Field cost</span>
          <span className={s.tileVal}>
            {fmtMoney(T.cost)}
            {isPartial && <i className={s.soFar}>so far</i>}
          </span>
          <span className={s.tileSub}>
            {T.unknownFields > 0
              ? `${fmtInt(T.unknownFields)} field-${T.unknownFields === 1 ? "month" : "months"} excluded — no cost on file`
              : "every field in scope has a cost basis"}
          </span>
        </div>
        <div className={s.tile}>
          <span className={s.tileLab}>Revenue</span>
          <span className={s.tileVal}>
            {fmtMoney(T.revenue)}
            {isPartial && <i className={s.soFar}>so far</i>}
          </span>
          <span className={s.tileSub}>
            {T.unknownRevenue > 0
              ? `${fmtMoney(T.unknownRevenue)} of it sits at fields with no cost basis`
              : T.eventRevenue > 0
                ? `${fmtMoney(T.eventRevenue)} of it is event play, across ${fmtInt(T.matches)} billable ${T.matches === 1 ? "match" : "matches"}`
                : `across ${fmtInt(T.matches)} ${T.matches === 1 ? "match" : "matches"}`}
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
          <span><i className={`${s.dot} ${s.barB}`} />Revenue at costed fields</span>
          <span><i className={`${s.dot} ${s.barA}`} />Field cost</span>
          <span>Ratio printed above each pair.</span>
        </div>
      </div>

      <div className={s.ctrlRow}>
        <div className={s.ctrlGroup}>
          <span className={s.ctrlLab}>Economics</span>
          <div className={s.seg}>
            <button type="button" className={grain === "city" ? s.on : ""} onClick={() => setGrain("city")}>City Economics</button>
            <button type="button" className={grain === "field" ? s.on : ""} onClick={() => setGrain("field")}>Field Economics</button>
          </div>
        </div>
        <div className={s.ctrlGroup}>
          <button type="button" className={s.btn} onClick={exportTable}>Export</button>
        </div>
      </div>

      <EconomicsTable rows={live} grain={grain} total={T} />

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
  rows, grain, total,
}: {
  rows: FieldMonth[];
  grain: Grain;
  total: ReturnType<typeof rollup>;
}) {
  if (rows.length === 0) return <div className={s.empty}>No fields match this selection.</div>;
  const grouped = grain === "city" ? byCity(rows) : byField(rows);
  const list = [...grouped.values()]
    .map((g) => ({
      label: grain === "city" ? g[0].city : g[0].field,
      city: g[0].city,
      bases: [...new Set(g.map((x) => x.basis))],
      allUnknown: g.every((x) => x.cost == null),
      anyUnknown: g.some((x) => x.cost == null),
      r: rollup(g),
    }))
    .sort((a, b) => b.r.revenue - a.r.revenue);

  return (
    <div className={s.card}>
      <div className={s.legend} data-testid="cost-ratio-note">
        <span>
          <b>Cost ratio is field cost ÷ revenue at costed fields</b> — the column beside it, not
          total revenue. Event play is billed to nobody and fields with no cost basis have no cost
          behind them, so neither can sit under a cost in a ratio. The three revenue columns add up
          to the total on every row.
        </span>
      </div>
      <div className={s.tblWrap}>
        <table className={s.tbl} data-testid="cost-economics-table">
          <thead>
            <tr>
              <th className="l">{grain === "city" ? "City" : "Field"}</th>
              {grain === "field" && <th className="l">City</th>}
              {/* "Cost structure" is the mockup's wording for this column. */}
              <th className="l">Cost structure</th>
              <th>Matches</th>
              <th>Revenue</th>
              {/* THE RATIO'S DENOMINATOR, ON SCREEN. The ratio has always divided by revenue at
                  COSTED fields, but only total revenue was shown — so Austin printed 83.3% beside
                  columns that divide to 65.2%, and San Antonio printed 170.1% beside 39.3%. A
                  reader doing the arithmetic in the row got a different number from the one in the
                  row, which is a column lying by omission. The three components are split out so
                  the division on screen is the division performed. */}
              <th data-testid="cost-th-costed">At costed fields</th>
              <th data-testid="cost-th-event">Event play</th>
              <th data-testid="cost-th-nobasis">No cost basis</th>
              <th>Field cost</th>
              <th>Cost ratio</th>
            </tr>
          </thead>
          <tbody>
            {list.map((x) => (
              <tr key={x.label} data-testid="cost-row">
                <td className="l">{x.label}</td>
                {grain === "field" && <td className="l">{x.city}</td>}
                <td className="l">
                  {/* ON EVERY ROW — a >100% ratio is legible only if the billing says why. */}
                  {x.bases.map((b) => (
                    <span key={b} className={`${s.bt} ${b === "profit_share" ? s.btShare : b === "monthly_flat" ? s.btFlat : ""}`} data-testid="cost-billing-mark">
                      {COST_BASIS_LABEL[b]}
                    </span>
                  ))}
                  {x.anyUnknown && <span className={`${s.bt} ${s.btNone}`} data-testid="cost-billing-mark">No cost on file</span>}
                </td>
                <td>{fmtInt(x.r.matches)}</td>
                <td data-testid="cost-rev-total">{fmtMoney(x.r.revenue)}</td>
                {/* denominator + event + no-basis === revenue, on every row */}
                <td data-testid="cost-rev-costed">{fmtMoney(x.r.revenueWithKnownCost)}</td>
                <td className={s.mut} data-testid="cost-rev-event">{fmtMoney(x.r.eventRevenue)}</td>
                <td className={s.mut} data-testid="cost-rev-nobasis">
                  {fmtMoney(x.r.revenue - x.r.revenueWithKnownCost - x.r.eventRevenue)}
                </td>
                <td className={x.allUnknown ? s.mut : s.neg} data-testid="cost-amount-cell">
                  {x.allUnknown ? "—" : fmtMoney(x.r.cost)}
                </td>
                <td className={x.r.ratio == null ? s.mut : ""} data-testid="cost-ratio-cell">
                  {x.r.ratio == null ? "—" : fmtPct(x.r.ratio)}
                </td>
              </tr>
            ))}
            <tr className={s.tot} data-testid="cost-total-row">
              <td className="l">{grain === "city" ? "All cities" : "All fields"}</td>
              {grain === "field" && <td className="l">—</td>}
              <td className="l">—</td>
              <td>{fmtInt(total.matches)}</td>
              <td data-testid="cost-tot-total">{fmtMoney(total.revenue)}</td>
              <td data-testid="cost-tot-costed">{fmtMoney(total.revenueWithKnownCost)}</td>
              <td className={s.mut} data-testid="cost-tot-event">{fmtMoney(total.eventRevenue)}</td>
              <td className={s.mut} data-testid="cost-tot-nobasis">
                {fmtMoney(total.revenue - total.revenueWithKnownCost - total.eventRevenue)}
              </td>
              <td className={s.neg} data-testid="cost-total-amount">{fmtMoney(total.cost)}</td>
              <td>{total.ratio == null ? "—" : fmtPct(total.ratio)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
