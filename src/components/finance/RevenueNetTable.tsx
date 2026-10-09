"use client";

/* CITY AND FIELD TABLES ON fin_txn — two column groups (Ryan, 2026-10-08; narrowed 2026-10-09).
 *
 * NARROWED TO FIT 1,440 px (2026-10-09): Launched, DPP, Membership and Share are off the table and
 * stay in the Export; DPP and Membership are in the Net revenue cell's hover. The first column is
 * pinned, so it stays put when a narrow screen scrolls the table inside its own box. "Provisional"
 * is no longer printed in cells — the Field cost / match hover says it once.
 *
 * THE SELECTED PERIOD (follows the month picker): Venues (city), Matches, DPP, Membership, Net
 * revenue, Avg revenue / venue (city), Member mix, Share — with the Unassigned row (city) or the
 * no-field rows (field), so the Total equals the net revenue figure above, to the cent. Every money
 * cell is a GroupRow from src/lib/revenueTxn.ts. Refunds & disputes is not a column here any more;
 * it is in the MatchDay Revenue table, and Net revenue is after it.
 *
 * THE LAST 4 COMPLETED WEEKS (does NOT follow the picker): Matches, Revenue / match, Field cost /
 * match, Net / match, from src/lib/fieldPnL.ts — the calculation Slate Review shows, on its basis
 * (play revenue, before tax, refunds and Stripe fees). A field row is that field's Slate line; a
 * city row is match-weighted across the city's fields that have a cost, with "60 of 113 matches"
 * when that is not all of them. */
import { money, UNASSIGNED, NO_FIELD_MEMBERSHIP, NO_FIELD_OTHER, type GroupRow } from "@/lib/revenueTxn";
import { InfoI } from "./RevenueInfo";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dollars = (c: number) => (c / 100).toFixed(2);
const m2 = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One row's 4-week cells. `cost` is a label in place of a number when there is no computed cost. */
export type PnLCell = {
  matches: number;
  revPM: number | null; costPM: number | null; netPM: number | null;
  /** "60 of 113 matches" — the averages cover fewer matches than the window holds. */
  coverage: string | null;
  /** In place of a cost: the model's name ("Monthly fee", …). */
  costText: string | null;
  profitShare: boolean;
  provisionalMonths: string[];
  /** The field's cost per match override note (Field Costs), when its cost is overridden. */
  costNote?: string | null;
};

export default function RevenueNetTable({ grain, groups, matchesOf, venuesOf, launchOf, pnl }: {
  grain: "city" | "field";
  groups: GroupRow[];
  /** Matches that have kicked off in the period for a row; null where a row has no matches to count. */
  matchesOf: (g: GroupRow) => number | null;
  /** City grain: fields with a kicked-off match in the period. */
  venuesOf?: (g: GroupRow) => number | null;
  launchOf?: (g: GroupRow) => string | null;
  pnl: { label: string; loading: boolean; error: string | null; of: (g: GroupRow) => PnLCell | null; total: PnLCell | null };
}) {
  if (groups.length === 0) return <div style={{ padding: 16, color: "#7b8b82" }}>No revenue for this selection.</div>;
  const field = grain === "field";
  const T = groups.reduce((a, g) => ({
    dpp: a.dpp + g.dpp, membership: a.membership + g.membership,
    net: a.net + g.net, matches: a.matches + (matchesOf(g) ?? 0), venues: a.venues + ((venuesOf && venuesOf(g)) ?? 0),
  }), { dpp: 0, membership: 0, net: 0, matches: 0, venues: 0 });
  const isNoRow = (g: GroupRow) => g.label === UNASSIGNED || g.label === NO_FIELD_MEMBERSHIP || g.label === NO_FIELD_OTHER;
  const mix = (mem: number, net: number) => (net > 0 ? `${((mem / net) * 100).toFixed(1)}%` : "—");
  const perVenue = (net: number, v: number | null) => (v ? money(Math.round(net / v)) : "—");
  const monthCols = field ? 4 : 6;
  const netTitle = (dpp: number, mem: number) => `DPP ${money(dpp)} · Membership ${money(mem)} (both before refunds and disputes)`;

  const pnlCells = (c: PnLCell | null) => {
    if (pnl.error) return <td className="num w4 w4l" colSpan={4} data-testid="nt-w4-error">Did not load: {pnl.error}</td>;
    if (pnl.loading) return <td className="num w4 w4l" colSpan={4} data-testid="nt-w4-loading">Loading…</td>;
    if (!c) return (<><td className="num w4 w4l">—</td><td className="num w4">—</td><td className="num w4">—</td><td className="num w4">—</td></>);
    return (
      <>
        <td className="num w4 w4l" data-testid="nt-w4-matches">{c.matches.toLocaleString("en-US")}
          {c.coverage && <span className="sub" data-testid="nt-w4-coverage">averages cover {c.coverage}</span>}</td>
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
            <th className="l pin"><span className="lbl">{field ? "Field" : "City"}</span></th>
            {field && <th className="l"><span className="lbl">City</span></th>}
            {!field && <th><span className="lbl">Venues</span></th>}
            <th><span className="lbl">Matches <InfoI pop="matchesMonth" label="Which matches are counted" /></span></th>
            <th className="net"><span className="lbl">Net revenue <InfoI pop="netTable" label="What net revenue is here" /></span></th>
            {!field && <th><span className="lbl">Avg / venue</span></th>}
            <th><span className="lbl">Member mix</span></th>
            <th className="w4 w4l"><span className="lbl">Matches <InfoI pop="matches4w" label="Which matches are counted in the 4 weeks" /></span></th>
            <th className="w4"><span className="lbl">Revenue / match</span></th>
            <th className="w4"><span className="lbl">Field cost / match <InfoI pop="fieldCost4w" label="What field cost per match is" /></span></th>
            <th className="w4"><span className="lbl">Net / match</span></th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const un = isNoRow(g);
            const m = matchesOf(g);
            const v = venuesOf ? venuesOf(g) : null;
            const others = Object.entries(g.otherByType).filter(([, x]) => x !== 0);
            return (
              <tr key={g.key} className={un ? "un" : ""} data-testid={g.label === UNASSIGNED ? "row-un" : `row-${slug(g.label)}`}
                data-label={g.label}>
                <td className="l pin"><span className="lbl">{g.label}
                  {g.label === UNASSIGNED && <InfoI pop="unassigned" label="Unassigned" />}
                  {others.length > 0 && (
                    <InfoI pop="other" label={`Also in ${g.label}'s net revenue`}>
                      <table><tbody>{others.map(([k, x]) => <tr key={k}><td>{k}</td><td>{money(x, true)}</td></tr>)}</tbody></table>
                    </InfoI>
                  )}</span></td>
                {field && <td className="l nt-city">{g.city ?? "—"}</td>}
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
