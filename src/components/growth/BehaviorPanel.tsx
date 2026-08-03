"use client";

// Player behavior — metric-driven drill-down. Pick a metric; the chart AND both
// breakdowns follow it (network trend → the market that moved it → the pitch).
// Ported from docs/mockups/player-behavior-v2.html (authoritative). All grid /
// series values come from the ONE shared computation (growthMetricGrid), also
// used by the Player Data Room, so the two panels can never disagree.

import { useMemo, useState } from "react";
import type { GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import {
  GRID_METRICS,
  METRIC_LABEL,
  buildMetricGrid,
  networkSeries,
  isRatio,
  hasFieldDimension,
  type GridMetric,
} from "@/lib/growthMetricGrid";
import { downloadCsv } from "./format";
import styles from "./playerBehavior.module.css";

const HUE: Record<GridMetric, string> = {
  registrations: "var(--c1)",
  newPlayers: "var(--c2)",
  totalPlayers: "var(--c3)",
  spots: "var(--c4)",
  spotsPerPlayer: "var(--c1)",
};
const INDEXED_METRICS: GridMetric[] = ["registrations", "newPlayers", "totalPlayers", "spots"];
const HEAT = ["var(--h1)", "var(--h2)", "var(--h3)", "var(--h4)", "var(--h5)", "var(--h6)"];
const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortMonth = (m: string) => MON_ABBR[Number(m.slice(5, 7)) - 1] ?? m;
const fullMonth = (m: string) => `${shortMonth(m)} ${m.slice(0, 4)}`;
const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
const fmtV = (v: number, ratio: boolean) => (ratio ? v.toFixed(2) : n0(v));

// heat step index for a value against its OWN row's [lo,hi] (per-row scale).
function heatIndex(v: number, lo: number, hi: number): number {
  if (v <= 0) return -1; // transparent
  if (hi <= lo) return 1; // single distinct value → mid step
  return Math.min(5, Math.floor(((v - lo) / (hi - lo)) * 6));
}

export default function BehaviorPanel({ data, period }: { data: GrowthData; period: Period }) {
  const [metric, setMetric] = useState<GridMetric>("spots");
  const [view, setView] = useState<"city" | "field">("city");
  const [indexed, setIndexed] = useState(false);

  const months = useMemo(
    () => data.behaviorOverall.map((p) => p.m).filter((m) => m >= period.start && m <= period.end),
    [data.behaviorOverall, period],
  );
  const ratio = isRatio(metric);
  const fieldOk = hasFieldDimension(metric);
  const effView: "city" | "field" = view === "field" && !fieldOk ? "city" : view;

  // ---- chart ----
  const chart = useMemo(() => {
    if (months.length < 2) return null;
    const W = 1000, H = 190, L = 52, R = 74, T = 14, B = 26;
    type S = { key: string; label: string; hue: string; v: (number | null)[] };
    const series: S[] = indexed
      ? INDEXED_METRICS.map((m) => {
          const raw = networkSeries(data, m, months);
          const base = raw.find((x) => x != null) ?? null;
          return { key: m, label: METRIC_LABEL[m], hue: HUE[m], v: raw.map((x) => (x != null && base ? (x / base) * 100 : null)) };
        })
      : [{ key: metric, label: METRIC_LABEL[metric], hue: HUE[metric], v: networkSeries(data, metric, months) }];

    const all = series.flatMap((s) => s.v).filter((x): x is number => x != null);
    if (!all.length) return null;
    const lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo) * 0.18 || 1;
    const rawLo = indexed ? Math.min(90, lo - pad) : Math.max(0, lo - pad);
    const rawHi = hi + pad;
    const rough = (rawHi - rawLo) / (indexed ? 5 : 3);
    const mag = Math.pow(10, Math.floor(Math.log10(rough || 1)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((f) => f >= rough) || 10 * mag;
    const y0 = indexed ? Math.max(0, Math.floor((lo - pad) / step) * step) : Math.floor(rawLo / step) * step;
    const y1 = Math.ceil(rawHi / step) * step;
    const ticks = Math.max(2, Math.round((y1 - y0) / step));
    const px = (i: number) => L + (i * (W - L - R)) / (months.length - 1);
    const py = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);

    const gridlines = Array.from({ length: ticks + 1 }, (_, g) => {
      const yy = T + (g * (H - T - B)) / ticks;
      const val = y1 - (g * (y1 - y0)) / ticks;
      return { yy, label: indexed ? String(Math.round(val)) : ratio ? val.toFixed(1) : n0(val) };
    });
    // right-edge direct labels, pushed apart so they never overlap
    const labs = series
      .map((s) => {
        const lastIdx = [...s.v].map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0).pop() ?? 0;
        return { y: py(s.v[lastIdx] as number), label: s.label, hue: s.hue };
      })
      .sort((a, b) => a.y - b.y);
    const GAP = 14;
    for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < GAP) labs[i].y = labs[i - 1].y + GAP;

    const polys = series.map((s) => ({
      key: s.key,
      hue: s.hue,
      pts: s.v.map((v, i) => (v != null ? { x: px(i), y: py(v) } : null)).filter((p): p is { x: number; y: number } => !!p),
    }));

    const m0 = networkSeries(data, metric, months).filter((x): x is number => x != null);
    const chg = m0.length >= 2 && m0[0] ? ((m0[m0.length - 1] - m0[0]) / m0[0]) * 100 : null;
    return { W, H, L, R, gridlines, px, py, polys, labs, chg };
  }, [data, months, metric, indexed, ratio]);

  // ---- grid (shared computation; throws on footing mismatch) ----
  const grid = useMemo(() => buildMetricGrid(data, metric, effView, months), [data, metric, effView, months]);

  // Assert per-row heat monotonicity (a bigger month is never lighter). Throw
  // rather than render a scale that lies.
  const heated = useMemo(() => {
    return grid.rows.map((r) => {
      const live = r.cells.filter((c): c is number => c != null && c > 0);
      const lo = live.length ? Math.min(...live) : 0;
      const hi = live.length ? Math.max(...live) : 0;
      const idx = r.cells.map((c) => (c != null ? heatIndex(c, lo, hi) : -1));
      // monotonicity: for any two positive cells, larger value ⇒ index not lower.
      for (let i = 0; i < r.cells.length; i++)
        for (let j = 0; j < r.cells.length; j++) {
          const a = r.cells[i], b = r.cells[j];
          if (a != null && b != null && a > 0 && b > 0 && a > b && idx[i] < idx[j])
            throw new Error(`BehaviorPanel heat non-monotonic in ${r.label}: ${a}→${idx[i]} lighter than ${b}→${idx[j]}`);
        }
      return { ...r, idx };
    });
  }, [grid]);

  const exportCsv = () => {
    const header = [effView === "city" ? "Market" : "Pitch", ...months.map(fullMonth), "Period"];
    const body = heated.map((r) => [
      r.city ? `${r.label} · ${r.city}` : r.label,
      ...r.cells.map((c) => (c == null ? "" : ratio ? c.toFixed(2) : String(Math.round(c)))),
      r.period == null ? "" : String(Math.round(r.period)),
    ]);
    downloadCsv(`player-behavior-${metric}-${effView}.csv`, [header, ...body]);
  };

  const known = grid.hasData;

  return (
    <div className={styles.root}>
      <div className={styles.hd}>
        <div>
          <p className={styles.title}>Player behavior</p>
          <p className={styles.sub}>
            Pick a metric. The chart and both breakdowns below follow it, so you can read the network trend, find the
            market that moved it, then find the pitch.
          </p>
        </div>
        <button type="button" className={styles.exp} onClick={exportCsv}>Export</button>
      </div>

      {/* metric toggle */}
      <div className={styles.mrow}>
        <span className={styles.eyebrow}>Metric</span>
        <span className={styles.mseg}>
          {GRID_METRICS.map((m) => (
            <button key={m} className={m === metric ? styles.on : undefined}
              onClick={() => { setMetric(m); if (!hasFieldDimension(m) && view === "field") setView("city"); }}>
              {METRIC_LABEL[m]}
            </button>
          ))}
        </span>
        <label className={styles.idxwrap}>
          <input type="checkbox" checked={indexed} onChange={(e) => setIndexed(e.target.checked)} />
          Compare all four, indexed to 100
        </label>
      </div>

      {/* chart */}
      <div className={styles.chartbox}>
        <div className={styles.chead}>
          <span className={styles.ctitle}>
            {indexed ? "All four metrics, indexed to 100 at the first month" : `${METRIC_LABEL[metric]} · ${months.length ? `${shortMonth(months[0])} – ${fullMonth(months[months.length - 1])}` : ""}`}
          </span>
          {!indexed && chart?.chg != null && (
            <span className={styles.cdelta}>
              {chart.chg >= 0 ? "+" : "−"}{Math.abs(chart.chg).toFixed(0)}% {shortMonth(months[0])} → {shortMonth(months[months.length - 1])}
            </span>
          )}
        </div>
        {chart ? (
          <svg className={styles.chart} viewBox={`0 0 ${chart.W} ${chart.H}`} preserveAspectRatio="none">
            {chart.gridlines.map((g, i) => (
              <g key={i}>
                <line className={styles.gridline} x1={chart.L} y1={g.yy.toFixed(1)} x2={chart.W - chart.R} y2={g.yy.toFixed(1)} />
                <text className={styles.axlab} x={chart.L - 8} y={(g.yy + 3.5).toFixed(1)} textAnchor="end">{g.label}</text>
              </g>
            ))}
            {months.map((m, i) => (
              <text key={m} className={styles.axlab} x={chart.px(i).toFixed(1)} y={chart.H - 6} textAnchor="middle">{shortMonth(m)}</text>
            ))}
            {chart.polys.map((p) => (
              <g key={p.key}>
                <polyline points={p.pts.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(" ")} fill="none" stroke={p.hue} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                {p.pts.map((pt, i) => (
                  <circle key={i} cx={pt.x.toFixed(1)} cy={pt.y.toFixed(1)} r={3.2} fill={p.hue} stroke="var(--surface)" strokeWidth={2} />
                ))}
              </g>
            ))}
            {chart.labs.map((l, i) => (
              <text key={i} className={styles.serieslab} x={chart.W - chart.R + 8} y={(l.y + 4).toFixed(1)} fill={l.hue}>{l.label}</text>
            ))}
          </svg>
        ) : (
          <div className={styles.sub}>Not enough months in the selected range to chart.</div>
        )}
      </div>
      {indexed && (
        <div className={styles.legend}>
          {INDEXED_METRICS.map((m) => (
            <span key={m} className="k"><i style={{ background: HUE[m] }} />{METRIC_LABEL[m]}</span>
          ))}
        </div>
      )}
      <div className={styles.chartbox} style={{ paddingTop: 8 }}>
        <p className={styles.axisnote}>
          {indexed ? (
            <>Every series starts at 100 in the first month, so all four share one axis and can be compared directly. A
              raw-value chart hides this because <b>spots booked is about five times the size of everything else</b> —
              which is exactly why there is no second axis.</>
          ) : (
            <>One metric, one axis. Spots booked runs about five times the other three, so a second axis would make the
              two scales line up wherever they were drawn to line up — a relationship the chart invented. Use{" "}
              <b>indexed to 100</b> above to compare all four honestly.</>
          )}
        </p>
      </div>

      {/* breakdown */}
      <div className={styles.bd}>
        <div className={styles.bdtop}>
          <span className={styles.eyebrow}>Breakdown</span>
          <span className={styles.seg}>
            <button className={effView === "city" ? styles.on : undefined} onClick={() => setView("city")}>City View</button>
            <button className={effView === "field" ? styles.on : undefined} disabled={!fieldOk}
              title={fieldOk ? "" : "A registration attaches to a market, never to a pitch"}
              onClick={() => fieldOk && setView("field")}>Field View</button>
          </span>
          <span className={styles.scope}>
            {grid.rows.length} {effView === "city" ? (grid.rows.length === 1 ? "market" : "markets") : (grid.rows.length === 1 ? "pitch" : "pitches")} · {METRIC_LABEL[metric].toLowerCase()} by month
          </span>
        </div>

        {effView === "field" && (
          <p className={styles.blocked}>Real pitch names — the third step of the drill-down: network trend, then the market that moved it, then the pitch. Registrations attach to a market, never a pitch, so they are unavailable here.</p>
        )}

        <div className={styles.scroll}>
          <table className={styles.gt}>
            <thead>
              <tr>
                <th className="l">{effView === "city" ? "Market" : "Pitch"}</th>
                {months.map((m) => <th key={m}>{fullMonth(m)}</th>)}
                <th>Period</th>
              </tr>
            </thead>
            <tbody>
              {heated.map((r, i) => (
                <tr key={r.label}>
                  <td className="l">
                    <span className={styles.rk}>{i + 1}</span>
                    <span className={styles.mk}>{r.label}</span>
                    {r.city && <span className={styles.sub2}> · {r.city}</span>}
                  </td>
                  {r.cells.map((c, j) => (
                    <td key={j} className="v">
                      <span className={styles.cell} style={{ background: r.idx[j] >= 0 ? HEAT[r.idx[j]] : "transparent" }}>
                        {c == null ? <span className={styles.dash}>—</span> : fmtV(c, ratio)}
                      </span>
                    </td>
                  ))}
                  <td className="tot">{r.period == null ? <span className={styles.dash}>—</span> : n0(r.period)}</td>
                </tr>
              ))}
              {grid.netByMonth && (
                <tr className={styles.netrow}>
                  <td className="l">All markets</td>
                  {grid.netByMonth.map((v, j) => <td key={j}>{v == null ? <span className={styles.dash}>—</span> : n0(v)}</td>)}
                  <td className="tot">{grid.netPeriod == null ? <span className={styles.dash}>—</span> : n0(grid.netPeriod)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className={styles.foot}>
          {known && grid.additive && (
            <><b>Shading compares each market against its own months, not against other markets</b> — globally scaled, Austin is dark and everything else blank, which is what you already know. Per row, a market fading month to month is the kind of thing this is for. One hue, light to dark. </>
          )}
          {!grid.additive && (
            <><b>{METRIC_LABEL[metric]} is a {ratio ? "ratio" : "distinct count"}, so it is read per month and never summed</b> — a period column would double-count anyone active in two months, so it shows a dash. </>
          )}
          {!fieldOk && (
            <><b>Field View is unavailable for registrations</b> — a registration attaches to a market and never to a pitch. </>
          )}
          Markets with registrations but no matches show real zeros; a dash means the figure is unknown for that month, never a fabricated zero.
        </p>
      </div>
    </div>
  );
}
