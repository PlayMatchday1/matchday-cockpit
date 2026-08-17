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
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import { quarterTabToMonths, CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { isCurrentMonth, type QuarterInfo } from "@/lib/quarters";
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

function defaultTab(quarter: QuarterInfo, now = new Date()): string {
  const cur = quarter.months.find((m) => isCurrentMonth(m, now));
  return (cur ?? quarter.months[quarter.months.length - 1]).shortName;
}

export default function CityPnlTable() {
  const { data, loading } = useFinanceData();
  const { rows: matchRegistrations, loading: matchLoading } = useMatchData();
  const quarter = useFinanceQuarter();

  const [basis, setBasis] = useState<BasisId>("per_match|realized");
  const [tab, setTab] = useState<string>(() => defaultTab(quarter));
  const [scope, setScope] = useState<string>("All cities");
  const [open, setOpen] = useState<string | null>(null);

  const [costMode, costScope] = basis.split("|") as [CityCostMode, CityCostScope];
  const now = useMemo(() => new Date(), []);
  const months = useMemo(() => quarterTabToMonths(quarter, tab), [quarter, tab]);
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

  const periodTabs = [`Q${quarter.quarter}`, ...quarter.months.map((m) => m.shortName)];

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.top}>
          <div>
            <p className={styles.eyebrow}>Finance · Cities</p>
            <h1 className={styles.title}>City P&amp;L</h1>
          </div>
          <div className={styles.ctrls}>
            <div className={styles.crow}>
              <span className={styles.clab}>Month</span>
              <div className={styles.seg} role="group" aria-label="Month">
                {periodTabs.map((t) => (
                  <button key={t} type="button" aria-pressed={t === tab} className={t === tab ? styles.on : ""} onClick={() => setTab(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.crow}>
              <span className={styles.clab}>Basis</span>
              <select className={styles.basis} aria-label="Cost basis" value={basis} onChange={(e) => setBasis(e.target.value as BasisId)}>
                {BASIS_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

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

        {/* ── DESKTOP: the nine-column chain ───────────────────────────────── */}
        <div className={styles.tblWrap}>
          <table className={styles.tbl} data-testid="citypnl-table">
            <colgroup>
              <col className={styles.cCity} />
              <col className={styles.cNum} /><col className={styles.cNum} /><col className={styles.cNum} />
              <col className={styles.cNum} /><col className={styles.cNum} />
              <col className={styles.cMar} />
              <col className={styles.cNum} /><col className={styles.cNum} />
              <col className={styles.cMar} />
            </colgroup>
            <thead>
              <tr>
                <th className={styles.thCity}>City</th>
                <th>DPP rev</th>
                {/* The equation, stated quietly in the header: DPP + Member = Total. */}
                <th className={styles.plus}>Member rev</th>
                <th className={styles.eq}>Total rev</th>
                <th className={styles.gsep}>Field cost</th>
                <th className={styles.gsep}>Field net</th>
                <th className={styles.thMar}>Field margin</th>
                <th className={styles.gsep}>Overhead</th>
                <th className={styles.gsep}>Net P&amp;L</th>
                <th className={styles.thMar}>Margin</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((k, i) => (
                <CityRows key={k.city} k={k} rank={i + 1} open={open === k.city}
                  onToggle={() => setOpen(open === k.city ? null : k.city)} />
              ))}
              {!single && blank.map((k) => (
                <tr key={k.city} className={styles.blank} data-testid="citypnl-blank-row">
                  <td className={styles.tdCity}><span className={styles.rkSpacer} />{k.city}</td>
                  <td>—</td><td>—</td><td>—</td>
                  <td className={styles.gsep}>—</td><td className={styles.gsep}>—</td>
                  <td>—</td>
                  <td className={styles.gsep}>—</td><td className={styles.gsep}>—</td>
                  <td className={styles.tdMar}>—</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr data-testid="citypnl-total-row">
                <td className={styles.tdCity}>{single ? scope : "All cities"}</td>
                <td>{usd(T.dpp)}</td>
                <td>{usd(T.memb)}</td>
                <td>{usd(T.total)}</td>
                <td className={`${styles.gsep} ${styles.cost}`}>{usdNeg(T.cost)}</td>
                <td className={`${styles.gsep} ${T.afterCost < 0 ? styles.negv : ""}`}>{usd(T.afterCost)}</td>
                <td className={styles.tdMar} data-testid="citypnl-fieldmargin">
                  <span className={`${styles.pill} ${T.afterCost >= 0 ? styles.pillUp : styles.pillDn}`}>
                    {T.total ? pctInt(T.afterCost / T.total) : "\u2014"}
                  </span>
                </td>
                <td className={`${styles.gsep} ${styles.cost}`}>{usdNeg(T.over)}</td>
                <td className={`${styles.gsep} ${styles.res} ${T.net >= 0 ? styles.up : styles.dn}`} data-testid="citypnl-total-net">{usd(T.net)}</td>
                <td className={styles.tdMar}>
                  <span className={`${styles.pill} ${T.net >= 0 ? styles.pillUp : styles.pillDn}`}>
                    {T.total ? pctInt(T.net / T.total) : "—"}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* ── PHONE: one card per city, the chain stacked ──────────────────── */}
        <div className={styles.cards}>
          {shown.map((k, i) => (
            <CityCard key={k.city} k={k} rank={i + 1} open={open === k.city}
              onToggle={() => setOpen(open === k.city ? null : k.city)} />
          ))}
          <div className={`${styles.mcard} ${styles.mtotal}`} data-testid="citypnl-card-total">
            <div className={styles.mhead}><span className={styles.mcity}>{single ? scope : "All cities"}</span>
              <span className={`${styles.pill} ${T.net >= 0 ? styles.pillUp : styles.pillDn}`}>
                {T.total ? pctInt(T.net / T.total) : "—"}
              </span>
            </div>
            <Chain dpp={T.dpp} memb={T.memb} total={T.total} cost={T.cost} afterCost={T.afterCost} over={T.over} net={T.net} />
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

function CityCard({ k, rank, open, onToggle }: { k: CityPnl; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <div className={styles.mcard} data-testid="citypnl-card">
      <button type="button" className={styles.mhead} onClick={onToggle} aria-expanded={open}>
        <span className={styles.mcity}><span className={styles.rk}>{rank}</span>{k.city}</span>
        <span className={`${styles.pill} ${k.net >= 0 ? styles.pillUp : styles.pillDn}`}>{pctInt(k.margin)}</span>
      </button>
      <Chain dpp={k.mappedDpp} memb={k.membership} total={k.gross} cost={k.fieldCost}
        afterCost={k.netAfterFieldCost} over={k.overheadTotal} net={k.net} />
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

function CityRows({ k, rank, open, onToggle }: { k: CityPnl; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={styles.row} onClick={onToggle} data-testid="citypnl-row">
        <td className={styles.tdCity}>
          <span className={styles.rk}>{rank}</span>
          <span className={styles.city}>{k.city}</span>
          <span className={styles.caret}>{open ? "▾" : "▸"}</span>
        </td>
        <td className={styles.dim}>{usd(k.mappedDpp)}</td>
        <td className={styles.dim}>{usd(k.membership)}</td>
        <td className={styles.subT}>{usd(k.gross)}</td>
        <td className={`${styles.gsep} ${styles.cost}`}>{usdNeg(k.fieldCost)}</td>
        <td className={`${styles.gsep} ${k.netAfterFieldCost < 0 ? styles.negv : ""}`}>{usd(k.netAfterFieldCost)}</td>
        <td className={styles.tdMar} data-testid="citypnl-fieldmargin">
          <span className={`${styles.pill} ${k.netAfterFieldCost >= 0 ? styles.pillUp : styles.pillDn}`}>
            {k.gross ? pctInt(k.netAfterFieldCost / k.gross) : "\u2014"}
          </span>
        </td>
        <td className={`${styles.gsep} ${styles.cost}`}>{usdNeg(k.overheadTotal)}</td>
        <td className={`${styles.gsep} ${styles.res} ${k.net >= 0 ? styles.up : styles.dn}`} data-testid="citypnl-net">{usd(k.net)}</td>
        <td className={styles.tdMar}>
          <span className={`${styles.pill} ${k.net >= 0 ? styles.pillUp : styles.pillDn}`}>{pctInt(k.margin)}</span>
        </td>
      </tr>
      {open && <Drill k={k} />}
    </>
  );
}

// The pitches, IN THE SAME NINE COLUMNS. No nested table, no second set of widths.
function Drill({ k }: { k: CityPnl }) {
  return (
    <>
      <tr className={styles.subhd}><td colSpan={10}>{k.city} · by pitch</td></tr>
      {k.fields.map((f) => (
        <tr key={f.venue} className={styles.sub} data-testid="citypnl-pitch-row">
          <td className={styles.tdCity}>
            <span className={styles.ven}>{f.venue}</span>
            <span className={styles.vmeta}>{pitchMeta(f)}</span>
          </td>
          <td className={styles.dim}>{usd(f.dppRev)}</td>
          <td className={f.memberRev == null ? styles.na : styles.dim}>
            {f.memberRev == null ? "—" : usd(f.memberRev)}
            {f.memberRev != null && <i className={styles.alloc}>alloc</i>}
          </td>
          <td className={styles.subT}>{usd(f.totalRev)}</td>
          <td className={`${styles.gsep} ${f.cost == null ? styles.na : styles.cost}`}>
            {f.cost == null ? "—" : usdNeg(f.cost)}
          </td>
          <td className={`${styles.gsep} ${f.net == null ? styles.na : f.net < 0 ? styles.negv : ""}`}>
            {f.net == null ? "—" : usd(f.net)}
          </td>
          {/* MEASURABLE AT A PITCH: its own revenue against its own venue cost. */}
          <td className={styles.tdMar} data-testid="citypnl-pitch-fieldmargin">
            {f.net == null || !f.totalRev ? <span className={styles.na}>—</span> : (
              <span className={`${styles.pill} ${f.net >= 0 ? styles.pillUp : styles.pillDn}`}>
                {pctInt(f.net / f.totalRev)}
              </span>
            )}
          </td>
          {/* A PITCH HAS NO OVERHEAD AND NO NET — those are city facts. */}
          <td className={`${styles.gsep} ${styles.na}`}>—</td>
          <td className={`${styles.gsep} ${styles.na}`}>—</td>
          <td className={`${styles.tdMar} ${styles.na}`}>—</td>
        </tr>
      ))}
      {k.untracked > 0 && (
        <tr className={styles.sub}>
          <td colSpan={10} className={styles.gapNote} data-testid="citypnl-untracked">
            <b>{usd(k.untracked)} of DPP is untracked</b> — it sits at pitches with no cost basis on
            file, so it is held out of DPP rev and Field net entirely rather than counted at $0.
          </td>
        </tr>
      )}
      <tr className={styles.ohrow}><td colSpan={10}><OverheadMakeup k={k} /></td></tr>
    </>
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
