"use client";

// City P&L — one ranked table row per city, replacing the old stacked city
// cards. Ranked by net descending. Applies the unmapped-cost rule (unknown-cost
// fields held out of net, surfaced as "untracked"). Basis controls live behind a
// gear popover with the current selection printed next to it; the city filter
// stays visible. See src/lib/cityPnl.ts for the arithmetic + assertions.

import { useMemo, useState } from "react";
import { useFinanceData } from "@/lib/useFinanceData";
import { useMatchData } from "@/lib/useMatchData";
import { useFinanceQuarter } from "@/lib/financeQuarter";
import { quarterTabToMonths, CITY_DISPLAY_ORDER } from "@/lib/financeStats";
import { isCurrentMonth, type QuarterInfo } from "@/lib/quarters";
import { isCityHidden } from "@/lib/types";
import { computeCityPnl, type CityCostMode, type CityCostScope, type CityPnl } from "@/lib/cityPnl";
import styles from "./cityPnl.module.css";

const OH_HUES = ["var(--gold-dot)", "var(--forest)", "var(--accent)", "var(--muted)", "var(--ns-ink)"];
const usd = (v: number) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString("en-US");
const pctInt = (x: number) => Math.round(x * 100) + "%";

function defaultTab(quarter: QuarterInfo, now = new Date()): string {
  const cur = quarter.months.find((m) => isCurrentMonth(m, now));
  return (cur ?? quarter.months[quarter.months.length - 1]).shortName;
}

export default function CityPnlTable() {
  const { data, loading } = useFinanceData();
  const { rows: matchRegistrations } = useMatchData();
  const quarter = useFinanceQuarter();

  const [costMode, setCostMode] = useState<CityCostMode>("per_match");
  const [costScope, setCostScope] = useState<CityCostScope>("realized");
  const [tab, setTab] = useState<string>(() => defaultTab(quarter));
  const [scope, setScope] = useState<string>("All cities");
  const [open, setOpen] = useState<string | null>(null);
  const [gearOpen, setGearOpen] = useState(false);

  const now = useMemo(() => new Date(), []);
  const months = useMemo(() => quarterTabToMonths(quarter, tab), [quarter, tab]);
  const cities = useMemo(() => CITY_DISPLAY_ORDER.filter((c) => !isCityHidden(c)), []);

  const rows = useMemo(() => {
    if (!data) return [];
    return cities.map((c) => computeCityPnl(data, matchRegistrations, c, months, costMode, costScope, now));
  }, [data, matchRegistrations, cities, months, costMode, costScope, now]);

  if (loading) {
    return <div className="rounded-2xl border border-cream-line bg-white p-8 text-sm text-deep-green/60">Loading…</div>;
  }
  if (!data) return null;

  const hasData = (k: CityPnl) => k.gross !== 0 || k.overheadTotal !== 0 || k.untracked !== 0;
  const live = rows.filter(hasData).sort((a, b) => b.net - a.net);
  const blank = rows.filter((k) => !hasData(k));
  const single = scope !== "All cities";
  const shown = single ? live.filter((k) => k.city === scope) : live;

  const T = shown.reduce(
    (a, k) => ({
      dpp: a.dpp + k.mappedDpp,
      memb: a.memb + k.membership,
      fieldNet: a.fieldNet + k.fieldNet,
      over: a.over + k.overheadTotal,
      net: a.net + k.net,
      gross: a.gross + k.gross,
    }),
    { dpp: 0, memb: 0, fieldNet: 0, over: 0, net: 0, gross: 0 },
  );

  const billed = costMode === "as_billed";
  const gearNow = [tab, billed ? "As Billed" : "Per-Match", billed ? "Full Month" : costScope === "realized" ? "Realized" : "Full Month"].join(" · ");

  const seg = <V extends string>(opts: readonly V[], cur: V, onPick: (v: V) => void, disabled = false) => (
    <div className={`${styles.seg} ${disabled ? styles.segOff : ""}`}>
      {opts.map((o) => (
        <button key={o} type="button" disabled={disabled} className={o === cur ? styles.on : ""} onClick={() => !disabled && onPick(o)}>
          {o}
        </button>
      ))}
    </div>
  );

  const periodTabs = [`Q${quarter.quarter}`, ...quarter.months.map((m) => m.shortName)];

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>Finance · Cities</p>
            <h1 className={styles.title}>City P&amp;L</h1>
            <p className={styles.sub}>Every city on one line, ranked by net. Click a city for its pitches and its overhead.</p>
          </div>
          <div className={styles.ctrls}>
            <div className={styles.segwrap}>
              <span className={styles.seglab}>City</span>
              {seg(["All cities", ...live.map((k) => k.city)] as const, scope, (v) => {
                setScope(v);
                if (v !== "All cities") setOpen(v);
              })}
            </div>
            <div className={styles.gearwrap}>
              <button
                type="button"
                className={`${styles.gear} ${gearOpen ? styles.gearOpen : ""}`}
                aria-expanded={gearOpen}
                onClick={() => setGearOpen((o) => !o)}
              >
                <span className={styles.gearico} aria-hidden>
                  ⚙
                </span>
                <span className={styles.gearnow}>{gearNow}</span>
              </button>
              {gearOpen && (
                <div className={styles.panel}>
                  <div className={styles.segwrap}>
                    <span className={styles.seglab}>Period</span>
                    {seg(periodTabs, tab, setTab)}
                  </div>
                  <div className={styles.segwrap}>
                    <span className={styles.seglab}>Field cost</span>
                    {seg(["as_billed", "per_match"] as const, costMode, setCostMode)}
                  </div>
                  <div className={styles.segwrap}>
                    <span className={styles.seglab}>Period window</span>
                    {seg(["realized", "fullMonth"] as const, billed ? "fullMonth" : costScope, setCostScope, billed)}
                  </div>
                  {billed && (
                    <div className={styles.why}>An invoice is a whole-month object — it does not partially realise, so the window is inert under As Billed.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.tblWrap}>
          <table className={styles.tbl}>
            <thead>
              <tr>
                <th className="l">City</th>
                <th>DPP rev</th>
                <th>Member rev</th>
                <th>Field net</th>
                <th>Overhead</th>
                <th>Net P&amp;L</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((k, i) => (
                <CityRows key={k.city} k={k} rank={i + 1} open={open === k.city} onToggle={() => setOpen(open === k.city ? null : k.city)} />
              ))}
              {!single &&
                blank.map((k) => (
                  <tr key={k.city} className={`${styles.row} ${styles.blank}`}>
                    <td className="l" style={{ paddingLeft: 41 }}>
                      {k.city}
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                    <td>—</td>
                  </tr>
                ))}
              <tr className={styles.total}>
                <td className="l">{single ? scope : "All cities"}</td>
                <td>{usd(T.dpp)}</td>
                <td className={styles.pos}>{usd(T.memb)}</td>
                <td className={T.fieldNet >= 0 ? styles.pos : styles.neg}>{usd(T.fieldNet)}</td>
                <td className={styles.neg}>{usd(-T.over)}</td>
                <td className={`${styles.net} ${T.net >= 0 ? styles.pos : styles.neg}`}>{usd(T.net)}</td>
                <td>
                  <span className={`${styles.marg} ${T.net >= 0 ? "" : styles.margNeg}`}>{T.gross ? pctInt(T.net / T.gross) : "—"}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CityRows({ k, rank, open, onToggle }: { k: CityPnl; rank: number; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className={styles.row} onClick={onToggle}>
        <td className="l">
          <span className={styles.rank}>{rank}</span>
          <span className={styles.city}>{k.city}</span>
          <span className={styles.caret}>{open ? "▾" : "▸"}</span>
          {k.untracked > 0 && <span className={styles.flag}>cost gap</span>}
        </td>
        <td>{usd(k.mappedDpp)}</td>
        <td className={styles.pos}>{usd(k.membership)}</td>
        <td className={k.fieldNet >= 0 ? styles.pos : styles.neg}>{usd(k.fieldNet)}</td>
        <td className={styles.neg}>{usd(-k.overheadTotal)}</td>
        <td className={`${styles.net} ${k.net >= 0 ? styles.pos : styles.neg}`}>{usd(k.net)}</td>
        <td>
          <span className={`${styles.marg} ${k.net >= 0 ? "" : styles.margNeg}`}>{pctInt(k.margin)}</span>
        </td>
      </tr>
      {open && <Drill k={k} />}
    </>
  );
}

function Drill({ k }: { k: CityPnl }) {
  const alloc = (spots: number | null) =>
    k.citySpots && spots != null ? usd(k.membership * (spots / k.citySpots)) : "—";
  const ohTot = k.overheadTotal || 1;

  return (
    <tr className={styles.drill}>
      <td colSpan={7}>
        <div className={styles.din}>
          <p className={styles.dh}>{k.city} · by pitch</p>
          <table className={styles.ftbl}>
            <thead>
              <tr>
                <th className="l">Venue</th>
                <th>Spots</th>
                <th>DPP rev</th>
                <th>Member rev</th>
                <th>Field cost</th>
                <th>Field net</th>
              </tr>
            </thead>
            <tbody>
              {k.fields.map((f) => {
                const sub =
                  f.basis === "share"
                    ? "billed as a share of revenue"
                    : f.basis === "unmapped"
                      ? "held out of net until a rate is mapped"
                      : f.perMatchRate != null
                        ? `per match · $${f.perMatchRate}`
                        : "flat billing";
                return (
                  <tr key={f.venue}>
                    <td className="l">
                      {f.venue}
                      {f.basis === "share" && <span className={`${styles.bucket} ${styles.bucketShare}`}>Profit share</span>}
                      {f.basis === "unmapped" && <span className={`${styles.bucket} ${styles.bucketUnmapped}`}>No cost on file</span>}
                      <span className={styles.rate}>{sub}</span>
                    </td>
                    <td className={f.memberSpots == null ? styles.mut : ""}>{f.memberSpots ?? "—"}</td>
                    <td>{usd(f.dppRev)}</td>
                    <td className={f.memberSpots == null ? styles.mut : ""}>{alloc(f.memberSpots)}</td>
                    <td className={f.cost == null ? styles.mut : styles.neg}>{f.cost == null ? "—" : usd(-f.cost)}</td>
                    <td className={f.net == null ? styles.mut : f.net >= 0 ? styles.pos : styles.neg}>{f.net == null ? "—" : usd(f.net)}</td>
                  </tr>
                );
              })}
              <tr className={styles.ftot}>
                <td className="l">Measured</td>
                <td className={styles.mut}>—</td>
                <td>{usd(k.mappedDpp)}</td>
                <td className={styles.mut}>—</td>
                <td className={styles.neg}>{usd(-k.fieldCost)}</td>
                <td className={k.fieldNet >= 0 ? styles.pos : styles.neg}>{usd(k.fieldNet)}</td>
              </tr>
            </tbody>
          </table>

          {k.untracked > 0 && (
            <p className={styles.dnote}>
              <b>{usd(k.untracked)} of DPP is untracked</b> — it sits at fields with no cost basis on file, so it is held out of
              DPP rev and Field net entirely rather than counted at $0. Map a rate to bring it in.
            </p>
          )}
          <p className={`${styles.dnote} ${styles.dnoteInfo}`}>
            <b>Member rev per pitch</b> = city member revenue ÷ city member-spots × that pitch&rsquo;s member-spots
            {k.citySpots ? ` (${usd(k.membership)} ÷ ${k.citySpots} spots).` : " — spots unavailable, so it shows a dash."}
          </p>

          <div className={styles.mk}>
            <p className={styles.mkH}>Overhead makeup · field cost excluded</p>
            <div className={styles.mkBar}>
              {k.overhead.map((o, i) => (
                <span key={o.label} className={styles.mkSeg} style={{ width: `${(o.value / ohTot) * 100}%`, background: OH_HUES[i % OH_HUES.length] }} />
              ))}
            </div>
            <div className={styles.mkRows}>
              {k.overhead.map((o, i) => (
                <span key={o.label} className={styles.mkRow}>
                  <span className={styles.mkDot} style={{ background: OH_HUES[i % OH_HUES.length] }} />
                  {o.label} <span className={styles.mkV}>{usd(o.value)}</span>
                  <span className={styles.mkP}>{Math.round((o.value / ohTot) * 100)}%</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}
