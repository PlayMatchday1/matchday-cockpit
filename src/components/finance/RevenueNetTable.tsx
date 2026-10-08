"use client";

/* CITY AND FIELD TABLES ON fin_txn — Matches, DPP, Membership, Refunds & disputes, Net revenue,
 * Share, with the Unassigned row (city) or the no-field rows (field), so the Total equals the net
 * revenue figure above, to the cent. Columns and testids follow the mock's By-city table. Every
 * money cell is a GroupRow from src/lib/revenueTxn.ts — the same integer per-row amounts the
 * headline sums. */
import { money, UNASSIGNED, NO_FIELD_MEMBERSHIP, NO_FIELD_OTHER, type GroupRow } from "@/lib/revenueTxn";
import { InfoI } from "./RevenueInfo";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dollars = (c: number) => (c / 100).toFixed(2);

export default function RevenueNetTable({ grain, groups, matchesOf, launchOf }: {
  grain: "city" | "field";
  groups: GroupRow[];
  /** Matches in the period for a row, from the roster; null where a row has no matches to count. */
  matchesOf: (g: GroupRow) => number | null;
  launchOf?: (g: GroupRow) => string | null;
}) {
  if (groups.length === 0) return <div style={{ padding: 16, color: "#7b8b82" }}>No revenue for this selection.</div>;
  const T = groups.reduce((a, g) => ({
    dpp: a.dpp + g.dpp, membership: a.membership + g.membership, reversals: a.reversals + g.reversals,
    net: a.net + g.net, matches: a.matches + (matchesOf(g) ?? 0),
  }), { dpp: 0, membership: 0, reversals: 0, net: 0, matches: 0 });
  const isNoRow = (g: GroupRow) => g.label === UNASSIGNED || g.label === NO_FIELD_MEMBERSHIP || g.label === NO_FIELD_OTHER;
  const share = (c: number) => (T.net ? `${((c / T.net) * 100).toFixed(1)}%` : "—");
  const field = grain === "field";

  return (
    <div className="tw" style={{ overflowX: "auto" }}>
      <table className="city" data-testid={field ? "field-table" : "city-table"}>
        <thead><tr>
          <th className="l"><span className="lbl">{field ? "Field" : "City"}</span></th>
          {field && <th className="l"><span className="lbl">City</span></th>}
          {field && <th className="l"><span className="lbl">Launched</span></th>}
          <th><span className="lbl">Matches</span></th>
          <th><span className="lbl">DPP <InfoI pop="dpp" label="What DPP is" /></span></th>
          <th><span className="lbl">Membership <InfoI pop="mem" label="What membership is" /></span></th>
          <th><span className="lbl">Refunds &amp; disputes <InfoI pop="rev" label="Refunds and disputes" /></span></th>
          <th className="net"><span className="lbl">Net revenue</span></th>
          <th><span className="lbl">Share</span></th>
        </tr></thead>
        <tbody>
          {groups.map((g) => {
            const un = isNoRow(g);
            const m = matchesOf(g);
            const others = Object.entries(g.otherByType).filter(([, v]) => v !== 0);
            return (
              <tr key={g.key} className={un ? "un" : ""} data-testid={g.label === UNASSIGNED ? "row-un" : `row-${slug(g.label)}`}
                data-label={g.label}>
                <td className="l"><span className="lbl">{g.label}
                  {g.label === UNASSIGNED && <InfoI pop="unassigned" label="Unassigned" />}
                  {others.length > 0 && (
                    <InfoI pop="other" label={`Also in ${g.label}'s net revenue`}>
                      <table><tbody>{others.map(([k, v]) => <tr key={k}><td>{k}</td><td>{money(v, true)}</td></tr>)}</tbody></table>
                    </InfoI>
                  )}</span></td>
                {field && <td className="l">{g.city ?? "—"}</td>}
                {field && <td className="l">{(launchOf && launchOf(g)) ?? "—"}</td>}
                <td className="num" data-testid="nt-matches">{m == null ? "—" : m.toLocaleString("en-US")}</td>
                <td className="num" data-testid="nt-dpp" data-cents={g.dpp}>{money(g.dpp)}</td>
                <td className="num" data-testid="nt-mem" data-cents={g.membership}>{money(g.membership)}</td>
                <td className={`num ${g.reversals < 0 ? "neg" : ""}`} data-testid="nt-rev" data-cents={g.reversals}>{g.reversals ? money(g.reversals) : "$0"}</td>
                <td className="num net" data-net={dollars(g.net)} data-cents={g.net}>{money(g.net)}</td>
                <td className="num">{share(g.net)}</td>
              </tr>
            );
          })}
          <tr className="tot" data-testid="row-total">
            <td className="l">Total</td>
            {field && <td className="l">—</td>}
            {field && <td className="l">—</td>}
            <td className="num">{T.matches.toLocaleString("en-US")}</td>
            <td className="num">{money(T.dpp)}</td>
            <td className="num">{money(T.membership)}</td>
            <td className={`num ${T.reversals < 0 ? "neg" : ""}`}>{money(T.reversals)}</td>
            <td className="num net" data-net={dollars(T.net)} data-cents={T.net}>{money(T.net)}</td>
            <td className="num">100%</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
