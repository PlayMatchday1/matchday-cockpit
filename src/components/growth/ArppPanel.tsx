"use client";

import { useMemo, useState } from "react";
import type { ArppPoint, GrowthData } from "@/lib/growthAnalytics";
import styles from "./growth.module.css";
import { fmtInt, fmtMoney, fmtPct, monthLabel } from "./format";

// Average revenue per player. Monthly split table is the source of truth (kept
// intact — split sums to the denominator and net/denominator reproduces ARPP to
// the cent, both asserted). Above it: a headline row with a trend sparkline whose
// final segment is dashed + hollow-ringed because the current month is still in
// progress (its denominator already holds every active member while play is only
// days in). Prior-year is always a dash — there is no 2025 revenue, so "$0.00" is
// never rendered. Below: a real per-city ARPP breakdown, and the deleted-account
// numerator diagnostic (PART 7).
const CANONICAL = ["Austin", "Houston", "San Antonio", "Dallas", "Atlanta", "OKC", "St. Louis", "El Paso"];

const usd = (v: number) => fmtMoney(v, 2);
const usd0 = (v: number) => fmtMoney(v, 0);

function Dash() {
  return <span style={{ color: "var(--ns-ink)", fontWeight: 600 }}>—</span>;
}

// Sparkline with a solid body and a DASHED final segment + hollow endpoint for
// the in-progress month.
function ArppSparkline({ values, inProgress }: { values: number[]; inProgress: boolean }) {
  const w = 104, h = 28, pad = 3;
  if (values.length < 2) return <Dash />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i): [number, number] => [
    pad + (i * (w - pad * 2)) / (values.length - 1),
    h - pad - ((v - lo) / span) * (h - pad * 2),
  ]);
  const solid = (inProgress ? pts.slice(0, -1) : pts).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const tail = pts.slice(-2).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }} aria-hidden>
      {solid && (
        <polyline data-seg="solid" points={solid} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      )}
      {inProgress && (
        <polyline data-seg="progress" points={tail} fill="none" stroke="var(--gold-dot)" strokeWidth={2} strokeDasharray="3 3" strokeLinecap="round" />
      )}
      {inProgress ? (
        <circle cx={last[0]} cy={last[1]} r={3} fill="var(--surface)" stroke="var(--gold-ink)" strokeWidth={2} />
      ) : (
        <circle cx={last[0]} cy={last[1]} r={2.6} fill="var(--forest)" />
      )}
    </svg>
  );
}

const wipPill = (
  <span style={{ marginLeft: 8, fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--gold-ink)", background: "var(--gold-bg, #fbf2dd)", border: "1px solid var(--gold-line, #e3c369)", borderRadius: 999, padding: "1px 7px" }}>
    in progress
  </span>
);

export default function ArppPanel({ data }: { data: GrowthData }) {
  const [view, setView] = useState<"city" | "field">("city");
  // ARPP is a revenue metric: a month only belongs in the series once it has
  // any net revenue. Before matches were backfilled, play months and revenue
  // months coincided (both 2026-only), so `denom > 0 || net > 0` was harmless.
  // A matches-only backfill adds ~21 pre-revenue play months whose net is 0;
  // without this gate each renders as $0.00 ARPP — a false zero — instead of
  // simply not existing yet. Data-derived, no hardcoded date: the floor is the
  // earliest month with revenue, so it moves back on its own once Stripe
  // revenue is backfilled for those months.
  const revenueFloor = data.arppOverall.reduce<string | null>(
    (f, p) => (p.net > 0 && (f == null || p.m < f) ? p.m : f),
    null,
  );
  const series = data.arppOverall.filter(
    (p) => (revenueFloor == null || p.m >= revenueFloor) && (p.denom > 0 || p.net > 0),
  );
  const nowMonth = data.generatedAt.slice(0, 7);

  // Assertions (throw, never render a lie).
  for (const p of series) {
    if (p.playedOnly + p.subOnly + p.both !== p.denom) {
      throw new Error(`ARPP: played+sub+both (${p.playedOnly}+${p.subOnly}+${p.both}) ≠ denominator ${p.denom} for ${p.m}`);
    }
    if (p.denom && Math.abs(p.net / p.denom - p.arpp) > 0.005) {
      throw new Error(`ARPP: net/denominator ≠ ARPP for ${p.m}`);
    }
  }

  const cur = series[series.length - 1];
  const prev = series[series.length - 2];
  const curInProgress = cur?.m === nowMonth;
  const mom = cur && prev && prev.arpp ? (cur.arpp - prev.arpp) / prev.arpp : null;
  const ytdNet = series.reduce((a, p) => a + p.net, 0);
  const diag = useMemo(() => new Map(data.arppDiagnostics.byMonth.map((x) => [x.m, x])), [data.arppDiagnostics]);

  // City breakdown: real per-city ARPP, ranked by current-month ARPP desc.
  const cityRows = useMemo(() => {
    if (!cur || !prev) return [];
    return CANONICAL.map((c) => {
      const s = data.arppByCity[c];
      const cp = s?.find((x) => x.m === cur.m);
      const pp = s?.find((x) => x.m === prev.m);
      return {
        city: c,
        cur: cp && cp.denom > 0 ? cp.arpp : null,
        curDen: cp?.denom ?? 0,
        prev: pp && pp.denom > 0 ? pp.arpp : null,
      };
    })
      .filter((r) => r.curDen > 0 || (data.arppByCity[r.city]?.some((x) => x.net > 0) ?? false))
      .sort((a, b) => (b.cur ?? -1) - (a.cur ?? -1));
  }, [data.arppByCity, cur, prev]);

  const cityDenSum = cityRows.reduce((a, r) => a + r.curDen, 0);
  const unattributed = data.arppDiagnostics.unattributedMembershipTotal;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Average revenue per player</div>
          <div className={styles.cardSub}>
            Monthly. Numerator is net revenue that month; denominator is players who played that month plus members
            active that month. The selected month against the one before it.
          </div>
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>View</span>
          <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "var(--ink)", padding: "6px 0" }}>General (Matchday)</span>
        </div>
      </div>

      {/* headline row */}
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th className="l" style={{ textAlign: "left" }}>
                View
              </th>
              <th>Trend</th>
              <th>{cur ? monthLabel(cur.m) : "Current"}</th>
              <th>{prev ? monthLabel(prev.m) : "Previous"}</th>
              <th>{cur ? `${monthLabel(cur.m).split(" ")[0]} ${Number(cur.m.slice(0, 4)) - 1}` : "Prior year"}</th>
              <th>MoM</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ textAlign: "left" }}>
                General {curInProgress && wipPill}
              </td>
              <td>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <ArppSparkline values={series.map((p) => p.arpp)} inProgress={curInProgress} />
                </div>
              </td>
              <td style={{ fontSize: 26, fontWeight: 800, color: "var(--forest)" }}>{cur ? usd(cur.arpp) : <Dash />}</td>
              <td>{prev ? usd(prev.arpp) : <Dash />}</td>
              <td>
                <Dash />
              </td>
              <td style={{ color: mom == null ? "var(--ns-ink)" : mom >= 0 ? "var(--ok-ink)" : "var(--negative)", fontWeight: 800 }}>
                {mom == null ? <Dash /> : `${mom >= 0 ? "+" : "−"}${Math.abs(mom * 100).toFixed(1)}%`}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* monthly table — the source of truth */}
      <div style={{ marginTop: 18, fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
        Month by month
      </div>
      <div className={styles.tableWrap} style={{ marginTop: 8 }}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Month</th>
              <th>Net revenue</th>
              <th>Denominator</th>
              <th>Played only</th>
              <th>Subscribed only</th>
              <th>Both</th>
              <th>ARPP</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => {
              const wip = p.m === nowMonth;
              return (
                <tr key={p.m} style={wip ? { background: "var(--gold-bg, #fbf2dd)" } : undefined}>
                  <td>
                    {monthLabel(p.m)}
                    {wip && wipPill}
                  </td>
                  <td>{usd0(p.net)}</td>
                  <td>{fmtInt(p.denom)}</td>
                  <td style={{ color: "var(--ns-ink)" }}>{fmtInt(p.playedOnly)}</td>
                  <td style={{ color: "var(--ns-ink)" }}>{fmtInt(p.subOnly)}</td>
                  <td style={{ color: "var(--ns-ink)" }}>{fmtInt(p.both)}</td>
                  <td style={{ fontWeight: 800 }}>{usd(p.arpp)}</td>
                </tr>
              );
            })}
            <tr>
              {["Year to date", usd0(ytdNet), "—", "—", "—", "—", "—"].map((v, j) => (
                <td key={j} style={{ borderTop: "2px solid var(--line)", fontWeight: 800 }}>
                  {v === "—" ? <Dash /> : v}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className={styles.footnote}>
        The current month carries an &ldquo;in progress&rdquo; tint: its denominator already includes every active member
        (billed on the 1st) while play is only days in, so ARPP is understated and settles upward — the dashed sparkline
        tail and hollow endpoint mark it. Year-on-year is a dash until Jan 2027; there is no 2025 revenue, so it is never
        rendered as $0.00. Year-to-date sums net revenue only — denominators are not additive (a player active in two
        months would be double-counted) and an average of monthly ARPPs is not a number.
      </div>

      {/* PART 7 diagnostic */}
      <div style={{ marginTop: 18, fontSize: "0.7rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
        Numerator check · deleted-account revenue
      </div>
      <div className={styles.tableWrap} style={{ marginTop: 8 }}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Month</th>
              <th>Total net</th>
              <th>Deleted-account</th>
              <th>ARPP (with)</th>
              <th>ARPP (excl.)</th>
            </tr>
          </thead>
          <tbody>
            {series.map((p) => {
              const g = diag.get(p.m);
              const del = g?.deletedNet ?? 0;
              const withArpp = p.denom ? p.net / p.denom : 0;
              const without = p.denom ? (p.net - del) / p.denom : 0;
              return (
                <tr key={p.m}>
                  <td>{monthLabel(p.m)}</td>
                  <td>{usd0(p.net)}</td>
                  <td style={{ color: del > 0 ? "var(--negative)" : "var(--ns-ink)" }}>{del > 0 ? usd0(del) : <Dash />}</td>
                  <td>{usd(withArpp)}</td>
                  <td style={{ fontWeight: 800 }}>{usd(without)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.footnote}>
        <b>{usd0(data.arppDiagnostics.deletedTotal)}</b> of fin_revenue is tagged &ldquo;Deleted Account Revenue&rdquo; —
        money from hard-deleted players whose rows no longer exist. It sits in the numerator but structurally cannot be in
        the denominator, so it overstates ARPP — heavily in Jan/Feb (Jan {usd(series[0] ? series[0].arpp : 0)} →{" "}
        {usd(series[0] && series[0].denom ? (series[0].net - (diag.get(series[0].m)?.deletedNet ?? 0)) / series[0].denom : 0)}{" "}
        excluding it), negligibly from March on. The truer basis excludes it; both are shown so the choice is visible.
        Unattributed membership revenue is {usd0(unattributed)} — {unattributed === 0 ? "nothing is dropped or spread" : "surfaced below, not spread across cities"}.
      </div>

      {/* city / field breakdown */}
      <div className={styles.controlsRow} style={{ margin: "18px 0 10px" }}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Breakdown</span>
          <div className={styles.segmented}>
            {(
              [
                ["city", "City View"],
                ["field", "Field View"],
              ] as ["city" | "field", string][]
            ).map(([v, txt]) => (
              <button key={v} type="button" className={`${styles.segBtn} ${view === v ? styles.segBtnActive : ""}`} aria-pressed={view === v} onClick={() => setView(v)}>
                {txt}
              </button>
            ))}
          </div>
        </div>
        <span className={styles.summaryLine}>
          {view === "city" ? `${cityRows.length} cities · ranked by current-month ARPP` : "per-pitch ARPP is not defined"}
        </span>
      </div>

      {view === "field" ? (
        <div className={styles.footnote}>
          <b>Field View is intentionally empty.</b> Per-pitch ARPP has no numerator: membership revenue attaches to a
          market and never to a pitch, so the top line cannot be split that far down. Showing a pay-per-play-only figure
          here would be a different metric wearing ARPP&rsquo;s name, so this panel refuses rather than fake it.
        </div>
      ) : (
        <>
          <div className={`${styles.tableWrap} ${styles.scrollBody}`}>
            <table className={styles.recordTable}>
              <thead>
                <tr>
                  <th>City</th>
                  <th className="num">{cur ? monthLabel(cur.m) : "Current"}</th>
                  <th className="num">{prev ? monthLabel(prev.m) : "Previous"}</th>
                  <th className="num">Prior year</th>
                  <th className="num">Denominator</th>
                  <th className="num">MoM</th>
                </tr>
              </thead>
              <tbody>
                {cityRows.map((r, i) => {
                  const m = r.cur != null && r.prev ? (r.cur - r.prev) / r.prev : null;
                  return (
                    <tr key={r.city}>
                      <td>
                        <span
                          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 19, height: 19, borderRadius: 999, background: "var(--chip-bg)", border: "1px solid var(--chip-line)", color: "var(--ns-ink)", fontSize: "10.5px", fontWeight: 800, marginRight: 10 }}
                        >
                          {i + 1}
                        </span>
                        {r.city}
                      </td>
                      <td className="num" style={{ fontWeight: 800 }}>{r.cur == null ? <Dash /> : usd(r.cur)}</td>
                      <td className="num">{r.prev == null ? <Dash /> : usd(r.prev)}</td>
                      <td className="num"><Dash /></td>
                      <td className="num">{fmtInt(r.curDen)}</td>
                      <td className="num" style={{ color: m == null ? "var(--ns-ink)" : m >= 0 ? "var(--ok-ink)" : "var(--negative)", fontWeight: 700 }}>
                        {m == null ? <Dash /> : `${m >= 0 ? "+" : "−"}${Math.abs(m * 100).toFixed(1)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className={styles.footnote}>
            No total row: city denominators do <b>not</b> sum to the network denominator (a player who played in two
            markets is counted in both — {fmtInt(cityDenSum)} across cities vs {fmtInt(cur?.denom ?? 0)} network in{" "}
            {cur ? monthLabel(cur.m) : "the current month"}), and a spot-weighted mean of city ARPPs would not equal the
            network ARPP for the same reason. Prior year is a dash until Jan 2027. Cities with no active denominator dash
            rather than read $0.00.
          </div>
        </>
      )}
    </div>
  );
}
