"use client";

/* CITY AND FIELD TABLES ON fin_txn — two views (Ryan, 2026-10-08; reworked 2026-10-09).
 *
 * SELECTED PERIOD (follows the month picker): Launched, Venues (city), Matches, Net revenue, Avg /
 * venue (city), Member mix, then the last 4 completed weeks — with the Unassigned row (city) or the
 * no-field rows (field), so the Total equals the net revenue figure above, to the cent. Every money
 * cell is a GroupRow from src/lib/revenueTxn.ts; DPP and Membership are in the Net revenue cell's
 * hover and in the Export.
 *
 * BY MONTH (follows the monthly card's range): one column per month, newest first, then Range total
 * and Change (the last full month against the first month in range).
 *
 * EVERY HEADER SORTS (a button, so Tab and Enter work): numbers highest first, text A to Z, a second
 * click reverses, dashes last both ways. The pinned rows — Unassigned, the no-field rows and Total —
 * stay at the bottom whatever the sort. Clicking a row sets the page's City or Field filter.
 *
 * THE LAST 4 COMPLETED WEEKS (does NOT follow the picker): Matches, Revenue / match, Field cost /
 * match, Net / match, from src/lib/fieldPnL.ts — the calculation Slate Review shows, on its basis
 * (play revenue, before tax, refunds and Stripe fees). A city row is match-weighted across the
 * city's fields that have a cost. ("averages cover X of Y matches" came off the rows 2026-10-09.) */
import { money, UNASSIGNED, NO_FIELD_MEMBERSHIP, NO_FIELD_OTHER, type GroupRow } from "@/lib/revenueTxn";
import { shortYm, sortBy, type SortState, type Ym } from "@/lib/revenueRange";
import { InfoI } from "./RevenueInfo";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dollars = (c: number) => (c / 100).toFixed(2);
const m2 = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ymNum = (ym: Ym | null) => (ym ? Number(ym.replace("-", "")) : null);

/** One row's 4-week cells. `cost` is a label in place of a number when there is no computed cost. */
export type PnLCell = {
  matches: number;
  revPM: number | null; costPM: number | null; netPM: number | null;
  /** "60 of 113 matches" — kept for the Export's note; no longer printed in the table. */
  coverage: string | null;
  /** In place of a cost: the model's name ("Monthly fee", …). */
  costText: string | null;
  profitShare: boolean;
  provisionalMonths: string[];
  /** The field's cost per match override note (Field Costs), when its cost is overridden. */
  costNote?: string | null;
};

export const isPinnedRow = (g: { label: string }) =>
  g.label === UNASSIGNED || g.label === NO_FIELD_MEMBERSHIP || g.label === NO_FIELD_OTHER;

/** THE ROW ORDER ON SCREEN, which the Export reuses: sortable rows by the sort, pinned rows after
 *  them in their own order. */
export function orderRows<T extends { label: string }>(rows: T[], sort: SortState, valueOf: (r: T, key: string) => number | string | null): T[] {
  const free = rows.filter((r) => !isPinnedRow(r)), pinned = rows.filter(isPinnedRow);
  return [...sortBy(free, (r) => valueOf(r, sort.key), sort.dir), ...pinned];
}

type Pnl = { label: string; loading: boolean; error: string | null; of: (g: GroupRow) => PnLCell | null; total: PnLCell | null };

/** The selected view's sortable value per column. */
export function selectedValue(g: GroupRow, key: string, x: {
  matchesOf: (g: GroupRow) => number | null; venuesOf?: (g: GroupRow) => number | null;
  launchOf: (g: GroupRow) => Ym | null; pnl: Pnl;
}): number | string | null {
  const v = x.venuesOf ? x.venuesOf(g) : null;
  switch (key) {
    case "name": return g.label;
    case "city": return g.city;
    case "launch": return ymNum(x.launchOf(g));
    case "venues": return v;
    case "matches": return x.matchesOf(g);
    case "net": return g.net;
    case "avg": return v ? g.net / v : null;
    case "mix": return g.net > 0 ? g.membership / g.net : null;
  }
  const c = x.pnl.loading || x.pnl.error ? null : x.pnl.of(g);
  if (!c) return null;
  if (key === "w4m") return c.matches;
  if (key === "w4rev") return c.revPM;
  if (key === "w4cost") return c.costPM;
  if (key === "w4net") return c.netPM;
  return null;
}
export const TEXT_KEYS = new Set(["name", "city"]);

/** A sortable header: the label is a button; an info icon stays a sibling (a button cannot hold one). */
function SortTh({ k, label, sort, onSort, className, info, testid }: {
  k: string; label: React.ReactNode; sort: SortState; onSort: (k: string) => void;
  className?: string; info?: React.ReactNode; testid?: string;
}) {
  const on = sort.key === k;
  return (
    <th className={className} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} data-testid={testid}>
      <span className="lbl">
        <button type="button" className="nt-sort" data-sort={k} onClick={() => onSort(k)}>
          {label}<span className={on ? "arr on" : "arr"} aria-hidden="true">{on && sort.dir === 1 ? "▲" : "▼"}</span>
        </button>
        {info}
      </span>
    </th>
  );
}

/** Row click → the page filter. Ignores clicks on a control inside the row (the info icons). */
function rowProps(onOpen: (() => void) | null, label: string) {
  if (!onOpen) return {};
  return {
    tabIndex: 0, className: "go", title: `Show ${label} above`,
    onClick: (e: React.MouseEvent) => { if (!(e.target as HTMLElement).closest("button")) onOpen(); },
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" && e.target === e.currentTarget) onOpen(); },
  };
}

export default function RevenueNetTable({ grain, groups, matchesOf, venuesOf, launchOf, pnl, sort, onSort, onOpen }: {
  grain: "city" | "field";
  groups: GroupRow[];
  /** Matches that have kicked off in the period for a row; null where a row has no matches to count. */
  matchesOf: (g: GroupRow) => number | null;
  /** City grain: fields with a kicked-off match in the period. */
  venuesOf?: (g: GroupRow) => number | null;
  launchOf: (g: GroupRow) => Ym | null;
  pnl: Pnl;
  sort: SortState;
  onSort: (k: string) => void;
  /** Set the page filter to this row; null for rows that are not a city or a field. */
  onOpen: (g: GroupRow) => (() => void) | null;
}) {
  if (groups.length === 0) return <div style={{ padding: 16, color: "#7b8b82" }}>No revenue for this selection.</div>;
  const field = grain === "field";
  const T = groups.reduce((a, g) => ({
    dpp: a.dpp + g.dpp, membership: a.membership + g.membership,
    net: a.net + g.net, matches: a.matches + (matchesOf(g) ?? 0), venues: a.venues + ((venuesOf && venuesOf(g)) ?? 0),
  }), { dpp: 0, membership: 0, net: 0, matches: 0, venues: 0 });
  const mix = (mem: number, net: number) => (net > 0 ? `${((mem / net) * 100).toFixed(1)}%` : "—");
  const perVenue = (net: number, v: number | null) => (v ? money(Math.round(net / v)) : "—");
  const monthCols = field ? 5 : 6;
  const netTitle = (dpp: number, mem: number) => `DPP ${money(dpp)} · Membership ${money(mem)} (both before refunds and disputes)`;
  const rows = orderRows(groups, sort, (g, k) => selectedValue(g, k, { matchesOf, venuesOf, launchOf, pnl }));
  const th = (k: string, label: React.ReactNode, cls?: string, info?: React.ReactNode) =>
    <SortTh k={k} label={label} sort={sort} onSort={onSort} className={cls} info={info} testid={`nt-h-${k}`} />;

  const pnlCells = (c: PnLCell | null) => {
    if (pnl.error) return <td className="num w4 w4l" colSpan={4} data-testid="nt-w4-error">Did not load: {pnl.error}</td>;
    if (pnl.loading) return <td className="num w4 w4l" colSpan={4} data-testid="nt-w4-loading">Loading…</td>;
    if (!c) return (<><td className="num w4 w4l">—</td><td className="num w4">—</td><td className="num w4">—</td><td className="num w4">—</td></>);
    return (
      <>
        <td className="num w4 w4l" data-testid="nt-w4-matches">{c.matches.toLocaleString("en-US")}</td>
        <td className="num w4" data-testid="nt-w4-rev">{c.revPM == null ? "—" : m2(c.revPM)}</td>
        <td className="num w4" data-testid="nt-w4-cost" title={c.costNote ? `Cost per match override: ${c.costNote}` : undefined}>
          {c.costPM != null ? m2(c.costPM) : c.costText ?? "—"}
          {c.costNote && <span className="sub tag" data-testid="nt-w4-override">Override</span>}
          {c.profitShare && c.costPM != null && <span className="sub tag" data-testid="nt-w4-share">Profit share</span>}
        </td>
        <td className={`num w4 ${c.netPM != null && c.netPM < 0 ? "neg" : ""}`} data-testid="nt-w4-net">{c.netPM == null ? "—" : m2(c.netPM)}</td>
      </>
    );
  };

  return (
    <div className="tw nt-wrap">
      <table className="city nt" data-testid={field ? "field-table" : "city-table"}>
        <thead>
          <tr className="grp">
            <th className="l pin" colSpan={1}><span className="lbl">Selected period</span></th>
            <th className="l" colSpan={monthCols} />
            <th className="l w4 w4l" colSpan={4} data-testid="nt-w4-head">
              <span className="lbl">Last 4 completed weeks · {pnl.label}</span>
              <span className="sub">play revenue, before tax, refunds and Stripe fees</span>
            </th>
          </tr>
          <tr>
            {th("name", field ? "Field" : "City", "l pin")}
            {field && th("city", "City", "l")}
            {th("launch", "Launched")}
            {!field && th("venues", "Venues")}
            {th("matches", "Matches", undefined, <InfoI pop="matchesMonth" label="Which matches are counted" />)}
            {th("net", "Net revenue", "net", <InfoI pop="netTable" label="What net revenue is here" />)}
            {!field && th("avg", "Avg / venue")}
            {th("mix", "Member mix")}
            {th("w4m", "Matches", "w4 w4l", <InfoI pop="matches4w" label="Which matches are counted in the 4 weeks" />)}
            {th("w4rev", "Revenue / match", "w4")}
            {th("w4cost", "Field cost / match", "w4", <InfoI pop="fieldCost4w" label="What field cost per match is" />)}
            {th("w4net", "Net / match", "w4")}
          </tr>
        </thead>
        <tbody>
          {rows.map((g) => {
            const un = isPinnedRow(g);
            const m = matchesOf(g);
            const v = venuesOf ? venuesOf(g) : null;
            const l = launchOf(g);
            const others = Object.entries(g.otherByType).filter(([, x]) => x !== 0);
            const rp = rowProps(un ? null : onOpen(g), g.label);
            return (
              <tr key={g.key} {...rp} className={[un ? "un" : "", rp.className ?? ""].join(" ").trim()}
                data-testid={g.label === UNASSIGNED ? "row-un" : `row-${slug(g.label)}`} data-label={g.label}>
                <td className="l pin"><span className="lbl">{g.label}
                  {g.label === UNASSIGNED && <InfoI pop="unassigned" label="Unassigned" />}
                  {others.length > 0 && (
                    <InfoI pop="other" label={`Also in ${g.label}'s net revenue`}>
                      <table><tbody>{others.map(([k, x]) => <tr key={k}><td>{k}</td><td>{money(x, true)}</td></tr>)}</tbody></table>
                    </InfoI>
                  )}</span></td>
                {field && <td className="l nt-city">{g.city ?? "—"}</td>}
                <td className="num" data-testid="nt-launch">{l ? shortYm(l) : "—"}</td>
                {!field && <td className="num" data-testid="nt-venues">{v == null ? "—" : v}</td>}
                <td className="num" data-testid="nt-matches">{m == null ? "—" : m.toLocaleString("en-US")}</td>
                <td className="num net" data-net={dollars(g.net)} data-cents={g.net} data-dpp={g.dpp} data-mem={g.membership}
                  title={netTitle(g.dpp, g.membership)}>{money(g.net)}</td>
                {!field && <td className="num" data-testid="nt-avgvenue">{perVenue(g.net, v)}</td>}
                <td className="num" data-testid="nt-mix">{un ? "—" : mix(g.membership, g.net)}</td>
                {pnlCells(un ? null : pnl.of(g))}
              </tr>
            );
          })}
          <tr className="tot" data-testid="row-total">
            <td className="l pin">Total</td>
            {field && <td className="l">—</td>}
            <td className="num" />
            {!field && <td className="num">{T.venues}</td>}
            <td className="num">{T.matches.toLocaleString("en-US")}</td>
            <td className="num net" data-net={dollars(T.net)} data-cents={T.net} title={netTitle(T.dpp, T.membership)}>{money(T.net)}</td>
            {!field && <td className="num">{perVenue(T.net, T.venues)}</td>}
            <td className="num">{mix(T.membership, T.net)}</td>
            {pnlCells(pnl.total)}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ── BY MONTH ─────────────────────────────────────────────────────────────────────────────────── */

/** One row of the By month view. `byMonth` holds cents; a month that is absent is "no revenue
 *  that month", and `dash` says which of those months print a dash rather than $0 (before launch,
 *  or not loaded). */
export type MonthRow = {
  key: string; label: string; city: string | null; launch: Ym | null;
  byMonth: Map<Ym, number>;
  /** Months whose figure is unknown (member spots not loaded): a dash, and left out of the total. */
  unknown: Set<Ym>;
  range: number | null; change: number | null;
  open: (() => void) | null;
};

/** A cell's value, null for a dash. */
export function monthCell(r: MonthRow, ym: Ym): number | null {
  if (r.unknown.has(ym)) return null;
  const v = r.byMonth.get(ym);
  if (v != null) return v;
  return r.launch && ym < r.launch ? null : 0;
}

export function monthValue(r: MonthRow, key: string): number | string | null {
  if (key === "name") return r.label;
  if (key === "city") return r.city;
  if (key === "launch") return ymNum(r.launch);
  if (key === "range") return r.range;
  if (key === "change") return r.change;
  if (key.startsWith("m:")) return monthCell(r, key.slice(2));
  return null;
}

export function RevenueByMonthTable({ grain, rows, months, currentYm, sort, onSort, unknownNote, pending }: {
  grain: "city" | "field";
  rows: MonthRow[];
  /** Newest first. */
  months: Ym[];
  currentYm: Ym;
  sort: SortState;
  onSort: (k: string) => void;
  unknownNote: string;
  /** Member spots for the unknown months are still loading: "…" rather than a dash. */
  pending?: boolean;
}) {
  if (rows.length === 0) return <div style={{ padding: 16, color: "#7b8b82" }}>No revenue for this selection.</div>;
  const field = grain === "field";
  const ordered = orderRows(rows, sort, monthValue);
  const th = (k: string, label: React.ReactNode, cls?: string) =>
    <SortTh k={k} label={label} sort={sort} onSort={onSort} className={cls} testid={`bm-h-${k.replace(":", "-")}`} />;
  const total = (ym: Ym) => rows.reduce((a, r) => a + (monthCell(r, ym) ?? 0), 0);
  const anyUnknown = (ym: Ym) => rows.some((r) => r.unknown.has(ym));
  const rangeTotal = rows.reduce((a, r) => a + (r.range ?? 0), 0);
  const cell = (r: MonthRow, ym: Ym) => {
    const v = monthCell(r, ym);
    if (v == null) {
      if (r.unknown.has(ym) && pending) return <td key={ym} className="num dim" data-month={ym}>…</td>;
      const why = r.unknown.has(ym) ? unknownNote : `Before ${r.label} launched`;
      return <td key={ym} className="num dim" title={why} data-month={ym}>—</td>;
    }
    return <td key={ym} className="num" data-month={ym} data-cents={v}>{money(v)}</td>;
  };
  return (
    <div className="tw nt-wrap">
      <table className="city nt bm" data-testid={field ? "field-month-table" : "city-month-table"}>
        <thead>
          <tr>
            {th("name", field ? "Field" : "City", "l pin")}
            {field && th("city", "City", "l")}
            {th("launch", "Launched")}
            {months.map((ym) => th(`m:${ym}`, <>{shortYm(ym)}{ym === currentYm && <span className="sub">so far</span>}</>))}
            {th("range", "Range total", "net")}
            {th("change", "Change")}
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => {
            const un = isPinnedRow(r);
            const rp = rowProps(un ? null : r.open, r.label);
            return (
              <tr key={r.key} {...rp} className={[un ? "un" : "", rp.className ?? ""].join(" ").trim()}
                data-testid={r.label === UNASSIGNED ? "bm-row-un" : `bm-row-${slug(r.label)}`} data-label={r.label}>
                <td className="l pin">{r.label}</td>
                {field && <td className="l nt-city">{r.city ?? "—"}</td>}
                <td className="num">{r.launch ? shortYm(r.launch) : "—"}</td>
                {months.map((ym) => cell(r, ym))}
                <td className="num net" data-cents={r.range ?? ""}>{r.range == null ? "—" : money(r.range)}</td>
                <td className={`num ${r.change == null ? "dim" : r.change < 0 ? "neg" : "up"}`} data-testid="bm-change">
                  {r.change == null ? "—" : `${r.change > 0 ? "+" : ""}${r.change}%`}</td>
              </tr>
            );
          })}
          <tr className="tot" data-testid="bm-row-total">
            <td className="l pin">Total</td>
            {field && <td className="l">—</td>}
            <td className="num" />
            {months.map((ym) => <td key={ym} className="num" data-cents={total(ym)} title={anyUnknown(ym) ? unknownNote : undefined}>
              {anyUnknown(ym) ? (pending ? "…" : "—") : money(total(ym))}</td>)}
            <td className="num net" data-cents={rangeTotal}>{money(rangeTotal)}</td>
            <td className="num" />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
