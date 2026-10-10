"use client";

// CITY P&L — one row per city, and the row reads left to right as a running calculation:
//
//     DPP rev + Member rev = TOTAL REV  −  Field cost  =  Field net  −  Overhead  =  Net P&L
//
// EACH MARGIN PILL RIDES WITH THE NUMBER IT DESCRIBES. Field margin sits immediately after Field
// net with no rule between them, the way Margin sits after Net P&L. The hairlines mark the four
// STEPS of the chain — Field cost, Field net, Overhead, Net P&L — not the ten columns.
//
// A PITCH DOES HAVE A FIELD MARGIN. Its overhead and net are city facts and stay dashes, but
// field margin is measurable at a pitch: its own revenue against its own venue cost.
//
// WHY IT WAS REBUILT (four things were wrong, none of them the typography):
//
//   1. THE COLUMNS NEVER SHARED AN EDGE. Every numeric column sized itself by its own content, so
//      $14,208 and $55 ended in different places and the eye had nothing to run down. Fixed widths
//      via <colgroup>, tabular numerals, one right edge per column across header, body and footer.
//      That is the whole fix.
//   2. THE MARGIN'S DENOMINATOR WAS INVISIBLE. Margin is Net P&L ÷ (DPP + Member) and that sum
//      appeared nowhere. TOTAL REV is not decoration — it is the number every margin is measured
//      against, so it is on the page and set heavier than the two columns it sums.
//   3. COSTS DID NOT LOOK LIKE COSTS. Field cost was folded invisibly into field net — and on
//      Austin it is the second largest number on the row. Both it and Overhead now carry a minus
//      and the cost colour.
//   4. THE DRILL-DOWN HAD ITS OWN COLUMN WIDTHS. A nested table under a table is exactly where
//      "the columns don't align" was loudest. The pitches now sit in the SAME nine columns.
//
// FIELD NET CHANGED DEFINITION — see src/lib/cityPnl.ts. It is Total rev − Field cost now, not
// DPP − Field cost. Both give the same Net P&L; only the new one chains, which is what lets a
// reader check any cell against its neighbours.
//
// A PITCH DOES NOT HAVE AN OVERHEAD, A NET OR A MARGIN. Those are city-level facts, so the pitch
// rows render dashes there rather than inventing a share of them.
//
// MEMBER REV ON A PITCH IS ALLOCATED, NOT MEASURED — nobody buys a membership at a pitch. Every
// pitch row is marked ALLOC. The allocation happens in cityPnl.ts so the pitches sum to the city
// by construction; it used to be done here, which is how a drill-down starts disagreeing with the
// row it opened from.
//
// MOBILE IS A DIFFERENT LAYOUT, NOT A SQUEEZE. A nine-column chain does not survive 390px, so
// below the table breakpoint each city becomes a card with the chain stacked. Same numbers, same
// order, same colours.

import { useCallback, useMemo, useState } from "react";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { isCityHidden } from "@/lib/types";
import { citiesTotal, computeCityPnl, type CityCostMode, type CityCostScope, type CityPnl, type CityRevenue, type PnlField } from "@/lib/cityPnl";
import { useNetRevenue } from "@/lib/useNetRevenue";
import { canonCity } from "@/lib/fieldEconomics";
import { nextSort, sortBy } from "@/lib/revenueRange";
import FinancePageBar from "@/components/finance/FinancePageBar";
import { InfoI, RV2_CSS } from "@/components/finance/RevenueInfo";
import styles from "./cityPnl.module.css";

const usd = (v: number) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString("en-US");
// The same minus sign as the money cells — a hyphen next to "−$1,611" reads as a different mark.
const pctInt = (x: number) => {
  const n = Math.round(x * 100);
  return (n < 0 ? "−" : "") + Math.abs(n) + "%";
};

// BASIS IS ONE CONTROL over two dimensions; MONTH is its own. Folding the month in with them (the
// old gear popover printed "Aug · Per-Match · Realized" as one string) made the month look like a
// property of the cost basis, which it is not.
/* FIELD COST: PER MATCH | AS BILLED (2026-10-10). "Full month" is gone: it counted every match
 * SCHEDULED in the month, played or not, so on a month in progress it projected the rest of the
 * month's cost against revenue to date. No other page offered it. Both options are realized. */
const BASIS_OPTIONS: { id: CityCostMode; label: string }[] = [
  { id: "per_match", label: "Per match" },
  { id: "as_billed", label: "As billed" },
];

export default function CityPnlTable() {
  // THE WINDOW COMES FROM THE PAGE, NOT FROM THIS CARD. The in-card Month segment (Q3 / Jul / Aug /
  // Sep) is gone: it could only ever offer the selected quarter's three months, so reaching August
  // meant first knowing August is in Q3. The period bar answers that question once for every
  // section, at whichever grain is asked for.
  const { period, now } = useFinancePeriod();
  const { data, loading } = useFinancePeriodData(period);
  /* REVENUE IS THE REVENUE PAGE'S (Ryan, 2026-10-10): fin_txn net, through useNetRevenue — a city
   * is its City-tab row, a pitch its legs' Field-tab net. No roster read any more: the ~2 MB of
   * match-player rows this page fetched existed only to derive the revenue it now reads. */
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const yms = useMemo(() => period.months.map((m) => `${m.slice(-4)}-${String(MON.indexOf(m.slice(0, 3)) + 1).padStart(2, "0")}`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period]);
  const netRev = useNetRevenue(yms, data?.venues ?? null);

  const [basis, setBasis] = useState<CityCostMode>("per_match");
  const [scope, setScope] = useState<string>("All cities");
  const [open, setOpen] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rev", dir: -1 });

  const costMode = basis;
  const costScope: CityCostScope = "realized";
  const months = period.months;
  const displayCities = useMemo(() => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)), []);
  // EVERY CITY WITH REVENUE gets a row, listed or not, so the cities plus Unassigned are the total.
  const cities = useMemo(() => {
    const out: string[] = [...displayCities];
    for (const nm of netRev.byMonth?.values() ?? []) for (const [c, g] of nm.cities) {
      if (g.net !== 0 && !out.some((x) => canonCity(x) === c)) out.push(c);
    }
    return out;
  }, [displayCities, netRev.byMonth]);
  const revenueOf = useCallback((city: string): CityRevenue => {
    const ms = yms.map((ym) => netRev.byMonth?.get(ym)).filter((x): x is NonNullable<typeof x> => !!x);
    const g = ms.map((nm) => nm.cities.get(canonCity(city)));
    return {
      cityNet: g.reduce((a, x) => a + (x?.net ?? 0), 0) / 100,
      cityMembership: g.reduce((a, x) => a + (x?.membership ?? 0), 0) / 100,
      venueNet: (ids) => {
        let n = 0, mem = 0;
        for (const nm of ms) for (const id of ids) { const v = nm.venues.get(id); if (v) { n += v.net; mem += v.membership; } }
        return { net: n / 100, membership: mem / 100 };
      },
    };
  }, [yms, netRev.byMonth]);
  const unassigned = useMemo(() => yms.reduce((a, ym) => a + (netRev.byMonth?.get(ym)?.unassigned?.net ?? 0), 0) / 100, [yms, netRev.byMonth]);

  const rows = useMemo(() => {
    if (!data || !netRev.byMonth) return [];
    return cities.map((c) => computeCityPnl(data, revenueOf(c), c, months, costMode, costScope, now));
  }, [data, netRev.byMonth, cities, revenueOf, months, costMode, costScope, now]);

  // BOTH loaders gate the render. useMatchData carries every DPP dollar and resolves long after
  // the finance fetch; rendering on the first alone printed a real-looking $0 in the DPP column of
  // every city until the second landed.
  if (netRev.error) return <div className={styles.loading}>Revenue did not load: {netRev.error}</div>;
  if (loading || !data || !netRev.byMonth) {
    return <div className={styles.loading}>Loading…</div>;
  }

  const hasData = (k: CityPnl) => k.gross !== 0 || k.overheadTotal !== 0 || k.untracked !== 0;
  const live = rows.filter(hasData).sort((a, b) => b.net - a.net);
  const blank = rows.filter((k) => !hasData(k));
  const single = scope !== "All cities";
  const shown = single ? live.filter((k) => k.city === scope) : live;

  // UNASSIGNED IS PINNED and counted in the total (All cities only): revenue with no city, no cost.
  const showUn = !single && unassigned !== 0;
  // THE TOTAL ROW: the cities on screen plus Unassigned (All cities only) — citiesTotal, asserted in
  // scripts/cities-sums-test.ts on every push.
  const T = citiesTotal(shown, showUn ? unassigned : 0);

  /* SORTING (Ryan, 2026-10-10): every header sorts the city rows; numbers start highest first,
   * text A to Z, a second click reverses. Unassigned, the no-data cities and the total stay pinned
   * at the bottom, and an expanded city's child rows travel with it in their own order. */
  const valueOf = (k: CityPnl, key: SortKey): number | string =>
    key === "city" ? k.city : key === "rev" ? k.gross : key === "cost" ? k.fieldCost : key === "exp" ? k.overheadTotal : key === "profit" ? k.net : k.margin;
  const sorted = sortBy(shown, (k) => valueOf(k, sort.key), sort.dir);
  const onSort = (key: SortKey) => setSort((cur) => nextSort(cur, key, key === "city") as { key: SortKey; dir: 1 | -1 });
  const th = (key: SortKey, label: string, extra?: { title?: string; left?: boolean; testid?: string; info?: React.ReactNode }) => {
    const on = sort.key === key;
    return (
      <th className={extra?.left ? styles.thCity6 : undefined} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} data-testid={`citypnl-th-${key}`}>
        <button type="button" className={styles.sortBtn} onClick={() => onSort(key)} title={extra?.title} data-testid={extra?.testid}>
          {label}<span className={on ? `${styles.sortArr} ${styles.sortOn}` : styles.sortArr} aria-hidden="true">{on && sort.dir === 1 ? "▲" : "▼"}</span>
        </button>
        {extra?.info ? <> {extra.info}</> : null}
      </th>
    );
  };

  return (
    <div className={`${styles.wrap} rv2`}>
      <style>{RV2_CSS}</style>
      {/* THE PAGE NAME AND THE SHARED PINNED BAR (Revenue's), with the City select. */}
      <FinancePageBar title="Cities" testid="cities-title" filters={
        <span className="rv2-filters" data-testid="page-filters">
          <select aria-label="City" data-testid="filter-city" value={single ? scope : ""}
            onChange={(e) => { const c = e.target.value; setScope(c || "All cities"); setOpen(c || null); }}>
            <option value="">All cities</option>
            {live.map((k) => <option key={k.city} value={k.city}>{k.city}</option>)}
          </select>
        </span>
      } />
      <div className={styles.card}>
        {/* FIELD COST BASIS: one small toggle. Per match is Finance › Cost's field cost exactly. */}
        <div className={styles.basisRow} data-testid="citypnl-basis">
          <span className={styles.clab}>Field cost</span>
          <div className={styles.basisSeg} role="group" aria-label="Field cost basis">
            {BASIS_OPTIONS.map((o) => (
              <button key={o.id} type="button" aria-pressed={basis === o.id} data-testid={`citypnl-basis-${o.id}`}
                className={basis === o.id ? styles.on : ""} onClick={() => setBasis(o.id)}>{o.label}</button>
            ))}
          </div>
        </div>

        {/* ── ONE TABLE, SIX COLUMNS, AT EVERY WIDTH (2026-10-10) ──────────────────────────────
            City · Revenue · Field cost · City expenses · City profit · Margin. Costs are plain
            positive amounts; only a negative profit or margin is red. Expanding a city adds its
            expense lines and its fields as indented rows under the SAME columns — no second header,
            no nested box. On a phone the table scrolls sideways inside its own box; the per-city
            cards are gone. The revenue bars came off: drawn under every figure they made the
            Revenue column harder to scan, and the profit and margin columns say what they did. */}
        <div className={`${styles.tblWrap} ${styles.tblWrap6}`}>
          <table className={`${styles.tbl} ${styles.tbl6}`} data-testid="citypnl-table">
            <colgroup>
              <col className={styles.c6City} /><col className={styles.c6Rev} />
              <col className={styles.c6Num} /><col className={styles.c6Num} />
              <col className={styles.c6Net} /><col className={styles.c6Mar} />
            </colgroup>
            <thead>
              <tr>
                {th("city", "City", { left: true })}
                {th("rev", "Revenue", { testid: "citypnl-rev-hover", info: <InfoI pop="netSame" label="What revenue is here" /> })}
                {th("cost", "Field cost")}
                {th("exp", "City expenses")}
                {th("profit", "City profit")}
                {th("margin", "Margin")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((k) => (
                <CityRows key={k.city} k={k} open={open === k.city}
                  onToggle={() => setOpen(open === k.city ? null : k.city)} />
              ))}
              {!single && blank.map((k) => (
                <tr key={k.city} className={styles.blank} data-testid="citypnl-blank-row">
                  <td className={styles.city6}>{k.city}</td>
                  <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                </tr>
              ))}
              {showUn && (
                <tr className={styles.pinned6} data-testid="citypnl-unassigned-row" data-city="Unassigned">
                  <td className={styles.city6} title="Revenue with no city on file — members with no city. The Revenue page's Unassigned row.">Unassigned</td>
                  <td data-testid="citypnl-rev" data-cents={Math.round(unassigned * 100)}>{usd(unassigned)}</td>
                  <td>—</td><td>—</td><td className={styles.net6}>{usd(unassigned)}</td><td>—</td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr data-testid="citypnl-total-row">
                <td className={styles.city6}>{single ? scope : "All cities"}</td>
                <td data-testid="citypnl-total-rev" data-cents={Math.round(T.total * 100)}>{usd(T.total)}</td>
                <td>{usd(T.cost)}</td>
                <td>{usd(T.over)}</td>
                <td className={`${styles.net6} ${T.net < 0 ? styles.neg6 : ""}`} data-testid="citypnl-total-net">{usd(T.net)}</td>
                <td className={T.total && T.net < 0 ? styles.neg6 : styles.mar6} data-testid="citypnl-total-margin">
                  {T.total ? pctInt(T.net / T.total) : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

      </div>
    </div>
  );
}

type SortKey = "city" | "rev" | "cost" | "exp" | "profit" | "margin";

/* A CITY AND, WHEN OPEN, ITS CHILD ROWS — all in the city table's six columns.
 *   City expenses: one row per category, the amount in the City expenses column only.
 *   Fields: revenue, field cost, field profit (City profit column) and margin (blank at $0
 *   revenue); highest field profit first, a field with no cost basis after them; then "No field",
 *   the city's revenue that sits at no field, so the field rows add up to the city's revenue. */
function CityRows({ k, open, onToggle }: { k: CityPnl; open: boolean; onToggle: () => void }) {
  const loss = k.net < 0;
  const fields = sortBy(k.fields, (f) => f.net, -1);
  const showNoField = Math.abs(k.noFieldRev) >= 0.005;
  return (
    <>
      <tr className={styles.row6} onClick={onToggle} aria-expanded={open}
        data-testid="citypnl-row" data-city={k.city} data-loss={loss ? "true" : "false"}>
        <td className={styles.city6}>
          <span className={styles.tw6}>{open ? "▾" : "▸"}</span>{k.city}
        </td>
        <td data-testid="citypnl-rev" data-cents={Math.round(k.gross * 100)}>{usd(k.gross)}</td>
        <td data-testid="citypnl-field" data-cents={Math.round(k.fieldCost * 100)}>{usd(k.fieldCost)}</td>
        <td data-testid="citypnl-overhead-cell">{usd(k.overheadTotal)}</td>
        <td className={`${styles.net6} ${loss ? styles.neg6 : ""}`} data-testid="citypnl-net">{usd(k.net)}</td>
        <td className={loss ? styles.neg6 : styles.mar6} data-testid="citypnl-margin">{pctInt(k.margin)}</td>
      </tr>
      {open && (
        <>
          {k.overhead.length > 0 && (
            <tr className={styles.group6} data-testid="citypnl-group" data-parent={k.city}><td colSpan={6}>City expenses</td></tr>
          )}
          {k.overhead.map((o) => (
            <tr key={o.label} className={styles.child6} data-testid="citypnl-expense-row" data-parent={k.city} data-expense={o.label}>
              <td className={styles.childName6}>{o.label}</td>
              <td /><td />
              <td>{usd(o.value)}</td>
              <td /><td />
            </tr>
          ))}
          <tr className={styles.group6} data-testid="citypnl-group" data-parent={k.city}><td colSpan={6}>Fields</td></tr>
          {fields.map((f) => (
            <FieldRow key={f.venue} f={f} city={k.city} />
          ))}
          {showNoField && (
            <tr className={styles.child6} data-testid="citypnl-nofield-row" data-parent={k.city} data-field="No field"
              title="Revenue with no field on it: DPP without a field, and membership no member spot placed.">
              <td className={styles.childName6}><i>No field</i></td>
              <td>{usd(k.noFieldRev)}</td>
              <td /><td /><td /><td />
            </tr>
          )}
          {k.untracked > 0 && (
            <tr className={styles.note6} data-testid="citypnl-untracked" data-parent={k.city}>
              <td colSpan={6}>{usd(k.untracked)} of this revenue is at fields with no cost basis on file: in the revenue, with no field cost counted against it.</td>
            </tr>
          )}
        </>
      )}
    </>
  );
}

function FieldRow({ f, city }: { f: PnlField; city: string }) {
  const neg = f.net != null && f.net < 0;
  return (
    <tr className={styles.child6} data-testid="citypnl-field-row" data-parent={city} data-field={f.venue}>
      <td className={styles.childName6}>{f.venue}</td>
      <td>{usd(f.totalRev)}</td>
      <td className={f.cost == null ? styles.na : ""}>{f.cost == null ? "—" : usd(f.cost)}</td>
      <td />
      <td className={`${f.net == null ? styles.na : ""} ${neg ? styles.neg6 : ""}`}>{f.net == null ? "—" : usd(f.net)}</td>
      <td className={neg ? styles.neg6 : styles.mar6}>{f.net == null ? "" : f.totalRev === 0 ? "" : pctInt(f.net / f.totalRev)}</td>
    </tr>
  );
}
