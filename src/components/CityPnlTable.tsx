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

import { useMemo, useState } from "react";
import { useFinancePeriodData } from "@/lib/useFinancePeriodData";
import { useMatchRangeData } from "@/lib/useMatchData";
import { useFinancePeriod } from "@/lib/financePeriodContext";
import { matchRange } from "@/lib/financePeriod";
import { CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { isCityHidden } from "@/lib/types";
import { computeCityPnl, type CityCostMode, type CityCostScope, type CityPnl, type PnlField } from "@/lib/cityPnl";
import styles from "./cityPnl.module.css";

const usd = (v: number) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString("en-US");
const usdNeg = (v: number) => (v === 0 ? "$0" : "−$" + Math.abs(Math.round(v)).toLocaleString("en-US"));
// The same minus sign as the money cells — a hyphen next to "−$1,611" reads as a different mark.
const pctInt = (x: number) => {
  const n = Math.round(x * 100);
  return (n < 0 ? "−" : "") + Math.abs(n) + "%";
};

// BASIS IS ONE CONTROL over two dimensions; MONTH is its own. Folding the month in with them (the
// old gear popover printed "Aug · Per-Match · Realized" as one string) made the month look like a
// property of the cost basis, which it is not.
type BasisId = `${CityCostMode}|${CityCostScope}`;
const BASIS_OPTIONS: { id: BasisId; label: string }[] = [
  { id: "per_match|realized", label: "Per-match · Realized" },
  { id: "per_match|fullMonth", label: "Per-match · Full month" },
  { id: "as_billed|realized", label: "As billed · Realized" },
  { id: "as_billed|fullMonth", label: "As billed · Full month" },
];

export default function CityPnlTable() {
  // THE WINDOW COMES FROM THE PAGE, NOT FROM THIS CARD. The in-card Month segment (Q3 / Jul / Aug /
  // Sep) is gone: it could only ever offer the selected quarter's three months, so reaching August
  // meant first knowing August is in Q3. The period bar answers that question once for every
  // section, at whichever grain is asked for.
  const { period, now } = useFinancePeriod();
  const { data, loading } = useFinancePeriodData(period);
  // THE PERIOD'S OWN WINDOW. This used to call useMatchData(), which fetches mdapi_match_players
  // UNFILTERED — ~203,000 rows in 203 paginated round-trips, on every view. The table is bucketed
  // by month against `period.months`, so anything outside the period was fetched and discarded.
  const { fromDate, toDate } = useMemo(() => matchRange(period.start, period.end), [period]);
  const { rows: matchRegistrations, loading: matchLoading } = useMatchRangeData(fromDate, toDate);

  const [basis, setBasis] = useState<BasisId>("per_match|realized");
  const [scope, setScope] = useState<string>("All cities");
  const [open, setOpen] = useState<string | null>(null);

  const [costMode, costScope] = basis.split("|") as [CityCostMode, CityCostScope];
  const months = period.months;
  const cities = useMemo(() => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)), []);

  const rows = useMemo(() => {
    if (!data) return [];
    return cities.map((c) => computeCityPnl(data, matchRegistrations, c, months, costMode, costScope, now));
  }, [data, matchRegistrations, cities, months, costMode, costScope, now]);

  // BOTH loaders gate the render. useMatchData carries every DPP dollar and resolves long after
  // the finance fetch; rendering on the first alone printed a real-looking $0 in the DPP column of
  // every city until the second landed.
  if (loading || matchLoading || !data) {
    return <div className={styles.loading}>Loading…</div>;
  }

  const hasData = (k: CityPnl) => k.gross !== 0 || k.overheadTotal !== 0 || k.untracked !== 0;
  const live = rows.filter(hasData).sort((a, b) => b.net - a.net);
  const blank = rows.filter((k) => !hasData(k));
  const single = scope !== "All cities";
  const shown = single ? live.filter((k) => k.city === scope) : live;

  const T = shown.reduce(
    (a, k) => ({
      dpp: a.dpp + k.mappedDpp,
      memb: a.memb + k.membership,
      total: a.total + k.gross,
      cost: a.cost + k.fieldCost,
      afterCost: a.afterCost + k.netAfterFieldCost,
      over: a.over + k.overheadTotal,
      net: a.net + k.net,
    }),
    { dpp: 0, memb: 0, total: 0, cost: 0, afterCost: 0, over: 0, net: 0 },
  );

  const maxRev = Math.max(1, ...shown.map((k) => k.gross));

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.top}>
          <div>
            <p className={styles.eyebrow}>Finance · Cities</p>
            <h1 className={styles.title}>City P&amp;L</h1>
          </div>
          <div className={styles.ctrls}>
            {/* BASIS STAYS. It describes how field cost is COMPUTED, not which period is shown —
                a different kind of choice, so a different home from the period bar. */}
            <div className={styles.crow}>
              <span className={styles.clab}>Basis</span>
              <select className={styles.basis} aria-label="Cost basis" value={basis} onChange={(e) => setBasis(e.target.value as BasisId)}>
                {BASIS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>
        {/* FULL MONTH ON A PARTIAL PERIOD IS A PROJECTION OF COST. venueChargedMatchCountFor counts
            every match SCHEDULED in the window, including the ones that have not been played, so
            the cost column carries the whole period while revenue has only accrued to today. Field
            net and both margins are understated for as long as the period is open. Realized is the
            like-for-like basis; this says so rather than leaving it to be discovered. */}
        {costScope === "fullMonth" && period.isCurrent && (
          <p className={styles.basisNote} data-testid="citypnl-fullmonth-note">
            <b>Full month against a partial period.</b> Cost covers all {period.totalDays} days —
            every match scheduled in {period.label}, played or not — while revenue has only accrued
            over {period.elapsedDays}. Field net and both margins read low until the period closes.
            Switch to Realized to compare like with like.
          </p>
        )}

        <div className={styles.cities}>
          <button type="button" aria-pressed={!single} className={!single ? styles.on : ""} onClick={() => { setScope("All cities"); setOpen(null); }}>
            All cities
          </button>
          {live.map((k) => (
            <button key={k.city} type="button" aria-pressed={scope === k.city} className={scope === k.city ? styles.on : ""}
              onClick={() => { setScope(k.city); setOpen(k.city); }}>
              {k.city}
            </button>
          ))}
        </div>

        {/* SCALE IS INFORMATION. Every bar is drawn against the largest city's revenue, so a
            27:1 gap reads as 27:1 instead of as two identical rows. */}
        {/* ── DESKTOP: SIX COLUMNS, IN P&L ORDER ───────────────────────────
            City · Revenue · − Field cost · − Overhead · Net P&L · Margin.
            The minus signs live in the headers because it is a CHAIN, and the reader was
            reconstructing revenue − field − overhead = net in their head on every row.
            DPP rev, member rev, field net and field margin are not deleted — they moved into
            the expansion, where they are the subject rather than four more numbers competing
            with the answer. */}
        <div className={`${styles.tblWrap} ${styles.tblWrap6}`}>
          <table className={`${styles.tbl} ${styles.tbl6}`} data-testid="citypnl-table">
            <colgroup>
              <col className={styles.c6City} /><col className={styles.c6Rev} />
              <col className={styles.c6Num} /><col className={styles.c6Num} />
              <col className={styles.c6Net} /><col className={styles.c6Mar} />
            </colgroup>
            <thead>
              <tr>
                <th className={styles.thCity6}>City</th>
                <th>Revenue</th>
                <th>&minus; Field cost</th>
                <th>&minus; Overhead</th>
                <th>Net P&amp;L</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => (
                <CityRows key={k.city} k={k} maxRev={maxRev} open={open === k.city}
                  onToggle={() => setOpen(open === k.city ? null : k.city)} />
              ))}
              {!single && blank.map((k) => (
                <tr key={k.city} className={styles.blank} data-testid="citypnl-blank-row">
                  <td className={styles.city6}>{k.city}</td>
                  <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-testid="citypnl-total-row">
                <td className={styles.city6}>{single ? scope : "All cities"}</td>
                <td className={styles.rev6}>{usd(T.total)}</td>
                <td className={styles.cost}>{usdNeg(T.cost)}</td>
                <td className={styles.cost}>{usdNeg(T.over)}</td>
                <td className={`${styles.net6} ${T.net < 0 ? styles.net6dn : ""}`} data-testid="citypnl-total-net">{usd(T.net)}</td>
                <td className={styles.mar6} data-testid="citypnl-total-margin">
                  {T.total ? pctInt(T.net / T.total) : "—"}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── PHONE: A CARD PER CITY. A six-column table does not survive 393px, so it is
            not attempted. Name and Net P&L on the first line with the answer right-aligned and
            dominant, the revenue bar full width beneath, then revenue / field / overhead
            three-up. Tapping opens the same detail the desktop expansion carries. */}
        <div className={styles.cards6}>
          {shown.map((k) => (
            <CityCard key={k.city} k={k} maxRev={maxRev} open={open === k.city}
              onToggle={() => setOpen(open === k.city ? null : k.city)} />
          ))}
          <div className={`${styles.card6} ${styles.mtotal}`} data-testid="citypnl-card-total">
            <div className={styles.card6head}>
              <span className={styles.card6city}>{single ? scope : "All cities"}</span>
              <span className={`${styles.card6net} ${T.net < 0 ? styles.net6dn : ""}`}>{usd(T.net)}</span>
            </div>
            <div className={styles.card6bar}><RevBar rev={T.total} net={T.net} maxRev={T.total} /></div>
            <dl className={styles.card6three}>
              <div><dt>Revenue</dt><dd className={styles.rev6}>{usd(T.total)}</dd></div>
              <div><dt>&minus; Field</dt><dd className={styles.cost}>{usdNeg(T.cost)}</dd></div>
              <div><dt>&minus; Overhead</dt><dd className={styles.cost}>{usdNeg(T.over)}</dd></div>
            </dl>
          </div>
        </div>

        <p className={styles.foot}>Click a city for its pitches and its overhead.</p>
      </div>
    </div>
  );
}

// The stacked chain used by the phone cards. Same order and same colours as the table row.
function Chain({ dpp, memb, total, cost, afterCost, over, net }: {
  dpp: number; memb: number; total: number; cost: number; afterCost: number; over: number; net: number;
}) {
  const fieldMargin = total ? afterCost / total : null;
  return (
    <dl className={styles.chain}>
      <div><dt>DPP rev</dt><dd>{usd(dpp)}</dd></div>
      <div><dt>+ Member rev</dt><dd>{usd(memb)}</dd></div>
      <div className={styles.chainSum}><dt>= Total rev</dt><dd>{usd(total)}</dd></div>
      <div><dt>Field cost</dt><dd className={styles.cost}>{usdNeg(cost)}</dd></div>
      <div className={styles.chainSum}><dt>= Field net</dt><dd className={afterCost < 0 ? styles.negv : ""}>{usd(afterCost)}</dd></div>
      <div><dt>Field margin</dt>
        <dd><span className={`${styles.pill} ${afterCost >= 0 ? styles.pillUp : styles.pillDn}`}>
          {fieldMargin == null ? "\u2014" : pctInt(fieldMargin)}</span></dd></div>
      <div><dt>Overhead</dt><dd className={styles.cost}>{usdNeg(over)}</dd></div>
      <div className={styles.chainSum}><dt>= Net P&amp;L</dt>
        <dd className={`${styles.res} ${net >= 0 ? styles.up : styles.dn}`}>{usd(net)}</dd></div>
    </dl>
  );
}

function CityCard({ k, maxRev, open, onToggle }: { k: CityPnl; maxRev: number; open: boolean; onToggle: () => void }) {
  const loss = k.net < 0;
  return (
    <div className={`${styles.card6} ${loss ? styles.card6loss : ""}`} data-testid="citypnl-card"
      data-city={k.city} data-loss={loss ? "true" : "false"}>
      {/* NAME AND THE ANSWER ON THE FIRST LINE, the answer right-aligned and dominant. The whole
          head is the tap target — 48px tall, never a chevron someone has to hit. */}
      <button type="button" className={styles.card6head} onClick={onToggle} aria-expanded={open}
        data-testid="citypnl-card-head">
        <span className={styles.card6city}>{k.city}</span>
        <span className={`${styles.card6net} ${loss ? styles.net6dn : ""}`} data-testid="citypnl-card-net">{usd(k.net)}</span>
      </button>
      <div className={styles.card6bar}><RevBar rev={k.gross} net={k.net} maxRev={maxRev} /></div>
      <dl className={styles.card6three}>
        <div><dt>Revenue</dt><dd className={styles.rev6} data-testid="citypnl-card-rev">{usd(k.gross)}</dd></div>
        <div><dt>&minus; Field</dt><dd className={styles.cost}>{usdNeg(k.fieldCost)}</dd></div>
        <div><dt>&minus; Overhead</dt><dd className={styles.cost}>{usdNeg(k.overheadTotal)}</dd></div>
      </dl>
      {open && (
        <div className={styles.mpitches}>
          <p className={styles.subhdText}>{k.city} · by pitch</p>
          {k.fields.map((f) => (
            <div key={f.venue} className={styles.mpitch}>
              <span className={styles.ven}>{f.venue}</span>
              <span className={styles.vmeta}>{pitchMeta(f)}</span>
              <dl className={styles.chain}>
                <div><dt>DPP rev</dt><dd>{usd(f.dppRev)}</dd></div>
                <div><dt>+ Member rev <i className={styles.alloc}>alloc</i></dt>
                  <dd className={f.memberRev == null ? styles.na : ""}>{f.memberRev == null ? "—" : usd(f.memberRev)}</dd></div>
                <div className={styles.chainSum}><dt>= Total rev</dt><dd>{usd(f.totalRev)}</dd></div>
                <div><dt>Field cost</dt>
                  <dd className={f.cost == null ? styles.na : styles.cost}>{f.cost == null ? "—" : usdNeg(f.cost)}</dd></div>
                <div className={styles.chainSum}><dt>= Field net</dt>
                  <dd className={f.net == null ? styles.na : f.net < 0 ? styles.negv : ""}>{f.net == null ? "—" : usd(f.net)}</dd></div>
                <div><dt>Field margin</dt>
                  <dd>{f.net == null || !f.totalRev ? <span className={styles.na}>—</span> : (
                    <span className={`${styles.pill} ${f.net >= 0 ? styles.pillUp : styles.pillDn}`}>{pctInt(f.net / f.totalRev)}</span>
                  )}</dd></div>
              </dl>
            </div>
          ))}
          <OverheadMakeup k={k} />
        </div>
      )}
    </div>
  );
}

function pitchMeta(f: PnlField): string {
  const spots = f.memberSpots != null ? `${f.memberSpots} spots` : "spots unavailable";
  const rate =
    f.basis === "share" ? "billed as a share of revenue"
    : f.basis === "unmapped" ? "no cost on file"
    : f.unitCost != null ? `per match $${f.unitCost}`
    : "flat billing";
  return `${spots} · ${rate}`;
}


/**
 * THE REVENUE BAR — two facts in one control.
 *   LENGTH        revenue against the largest city on screen.
 *   GREEN PORTION what survives cost, so the green share IS the margin.
 *
 * THE EDGE CASE THIS EXISTS FOR: St. Louis earns $15 on $965. A true-to-scale green segment is
 * 0.08px — "barely profitable" would draw identically to "losing", which is the one distinction
 * the bar is for. ANY positive net therefore gets a minimum visible sliver; a loss gets none, and
 * that asymmetry is deliberate rather than a rounding convenience.
 */
function RevBar({ rev, net, maxRev }: { rev: number; net: number; maxRev: number }) {
  const revW = maxRev > 0 ? Math.max(0, Math.min(100, (rev / maxRev) * 100)) : 0;
  // Clamped at 1, so a city spending more than it earns shows a fully consumed bar rather than a
  // negative-width segment.
  const costShare = rev > 0 ? Math.min(1, Math.max(0, (rev - net) / rev)) : 1;
  const netShare = 1 - costShare;
  return (
    <div className={styles.barwrap6} data-testid="citypnl-bar"
      title="bar length = revenue · green = what survives cost">
      <div className={styles.barrev6} data-testid="citypnl-bar-rev" style={{ width: `${revW.toFixed(2)}%` }}>
        <div className={styles.segcost6} data-testid="citypnl-bar-cost" style={{ width: `${(costShare * 100).toFixed(2)}%` }} />
        <div className={styles.segnet6} data-testid="citypnl-bar-net"
          style={{ width: `${(netShare * 100).toFixed(2)}%`, ...(net > 0 ? { minWidth: 2 } : null) }} />
      </div>
    </div>
  );
}

function CityRows({ k, maxRev, open, onToggle }: { k: CityPnl; maxRev: number; open: boolean; onToggle: () => void }) {
  const loss = k.net < 0;
  return (
    <>
      <tr className={`${styles.row6} ${loss ? styles.row6loss : ""}`} onClick={onToggle}
        data-testid="citypnl-row" data-city={k.city} data-loss={loss ? "true" : "false"}>
        <td className={styles.city6}>
          <span className={styles.tw6}>{open ? "▾" : "▸"}</span>{k.city}
        </td>
        <td>
          <div className={styles.rev6} data-testid="citypnl-rev">{usd(k.gross)}</div>
          <RevBar rev={k.gross} net={k.net} maxRev={maxRev} />
        </td>
        <td className={styles.cost} data-testid="citypnl-field">{usdNeg(k.fieldCost)}</td>
        <td className={styles.cost} data-testid="citypnl-overhead-cell">{usdNeg(k.overheadTotal)}</td>
        <td className={`${styles.net6} ${loss ? styles.net6dn : ""}`} data-testid="citypnl-net">{usd(k.net)}</td>
        {/* BADGES ONLY ON LOSSES. A pill on 69%, 80% and 82% is why the two red ones stopped
            registering — if every row is badged the badge means nothing. */}
        <td className={styles.mar6} data-testid="citypnl-margin">
          {loss ? <span className={styles.flag6} data-testid="citypnl-loss-badge">{pctInt(k.margin)}</span>
                : pctInt(k.margin)}
        </td>
      </tr>
      {open && <Drill k={k} />}
    </>
  );
}

// The pitches, IN THE SAME NINE COLUMNS. No nested table, no second set of widths.
function Drill({ k }: { k: CityPnl }) {
  const fieldMargin = k.gross ? k.netAfterFieldCost / k.gross : null;
  return (
    <tr className={styles.exp6} data-testid="citypnl-expansion">
      <td colSpan={6}>
        <div className={styles.expWrap6}>
          {/* THE FOUR COLUMNS THAT LEFT THE TOP LEVEL. Not deleted — moved here, where they are
              the subject rather than four more numbers competing with the answer. */}
          <p className={styles.expHead6}>{k.city} · revenue split and field result</p>
          <div className={styles.split6} data-testid="citypnl-split">
            <span>DPP rev <b data-testid="citypnl-dpp">{usd(k.mappedDpp)}</b></span>
            <span>+ Member rev <b data-testid="citypnl-member">{usd(k.membership)}</b></span>
            <span>= Total <b>{usd(k.gross)}</b></span>
            <span>Field net <b data-testid="citypnl-fieldnet" className={k.netAfterFieldCost < 0 ? styles.negv : ""}>{usd(k.netAfterFieldCost)}</b></span>
            <span>Field margin <b data-testid="citypnl-fieldmargin">{fieldMargin == null ? "—" : pctInt(fieldMargin)}</b></span>
          </div>

          <p className={styles.expHead6}>{k.city} · by pitch</p>
          <table className={styles.ptable6} data-testid="citypnl-pitch-table">
            <tbody>
              {k.fields.map((f) => (
                <tr key={f.venue} data-testid="citypnl-pitch-row">
                  <td className={styles.city6}>
                    <span className={styles.ven}>{f.venue}</span>
                    <span className={styles.vmeta}>{pitchMeta(f)}</span>
                  </td>
                  <td className={styles.rev6} data-testid="citypnl-pitch-rev">{usd(f.totalRev)}</td>
                  <td className={f.cost == null ? styles.na : styles.cost}>
                    {f.cost == null ? "—" : usdNeg(f.cost)}
                  </td>
                  <td className={f.net == null ? styles.na : f.net < 0 ? styles.negv : ""} data-testid="citypnl-pitch-net">
                    {f.net == null ? "—" : usd(f.net)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {k.untracked > 0 && (
            <p className={styles.gapNote} data-testid="citypnl-untracked">
              <b>{usd(k.untracked)} of DPP is untracked</b> — it sits at pitches with no cost basis
              on file, so it is held out of DPP rev and Field net entirely rather than counted at $0.
            </p>
          )}

          {/* THE OVERHEAD MAKEUP — the other half of what the top level now only totals. */}
          <OverheadMakeup k={k} />
        </div>
      </td>
    </tr>
  );
}

const OH_HUES = ["#2f7a4f", "var(--hdr, #0f2e1f)", "var(--gold-dot, #d8a72b)", "var(--accent, #5b7568)", "#93a89c"];

function OverheadMakeup({ k }: { k: CityPnl }) {
  const total = k.overheadTotal;
  if (total === 0) return null;
  return (
    <div data-testid="citypnl-overhead">
      <div className={styles.ohlab}>Overhead makeup · field cost excluded</div>
      <div className={styles.ohbar}>
        {k.overhead.map((o, i) => (
          <span key={o.label} className={styles.ohseg}
            style={{ width: `${(o.value / total) * 100}%`, background: OH_HUES[i % OH_HUES.length] }} />
        ))}
      </div>
      <div className={styles.ohkey}>
        {k.overhead.map((o, i) => (
          <span key={o.label} data-testid="citypnl-oh-item">
            <i className={styles.k} style={{ background: OH_HUES[i % OH_HUES.length] }} />
            {o.label} <b>{usd(o.value)}</b> <span className={styles.ohpct}>{Math.round((o.value / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
