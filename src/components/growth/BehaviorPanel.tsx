"use client";

import { useMemo, useState } from "react";
import type { BehaviorPoint, GrowthData } from "@/lib/growthAnalytics";
import type { Period } from "./GlobalPeriod";
import styles from "./growth.module.css";
import { downloadCsv, fmtInt, monthLabel, plural } from "./format";

// PART 1+2: Player behavior as a table. New players / Total players / Spots are
// play-LOCATION based; registrations are declared-city (City View only). Total
// players is range-distinct — computed from each player's event set, so it is a
// real "played here at any point in the range", never a last-month snapshot.
// Invariant asserted per row: Total players ≥ New players (new is a subset).
// Tiny inline sparkline for the summary "Trend" column.
function Sparkline({ values }: { values: number[] }) {
  const w = 92, h = 22, pad = 3;
  if (values.length < 2) return <span style={{ color: "var(--muted)" }}>—</span>;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => {
    // last point lands on x = w (the SVG's right edge) so, right-aligned in its
    // cell, it sits under the right edge of the TREND header.
    const x = pad + (i * (w - pad)) / (values.length - 1);
    const y = h - pad - ((v - lo) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1].split(",");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }} aria-hidden>
      <polyline points={pts.join(" ")} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lx} cy={ly} r={2.4} fill="var(--forest)" />
    </svg>
  );
}
// First→last % change over the period's non-null values.
function pctDelta(values: number[]): { txt: string; pos: boolean } | null {
  if (values.length < 2 || !values[0]) return null;
  const chg = ((values[values.length - 1] - values[0]) / values[0]) * 100;
  return { txt: (chg >= 0 ? "+" : "−") + Math.abs(chg).toFixed(0) + "%", pos: chg >= 0 };
}

const METRICS: { key: keyof Omit<BehaviorPoint, "m">; label: string }[] = [
  { key: "registrations", label: "Registrations" },
  { key: "newPlayers", label: "New players" },
  { key: "totalPlayers", label: "Total players" },
  { key: "spots", label: "Spots booked" },
];

type Row = {
  name: string;
  registrations: number | null;
  newPlayers: number;
  totalPlayers: number;
  spots: number;
  spp: number | null;
  noMatches: boolean;
};

export default function BehaviorPanel({ data, period }: { data: GrowthData; period: Period }) {
  const [view, setView] = useState<"city" | "field">("city");
  const months = data.behaviorOverall.map((p) => p.m).filter((m) => m >= period.start && m <= period.end);
  const byMonth = useMemo(() => new Map(data.behaviorOverall.map((p) => [p.m, p])), [data.behaviorOverall]);

  // play-month indexes inside the selected range (empty ⇒ no play era in range).
  const playIdxSet = useMemo(() => {
    const s = new Set<number>();
    data.playMonths.forEach((m, i) => {
      if (m >= period.start && m <= period.end) s.add(i);
    });
    return s;
  }, [data.playMonths, period]);
  const hasPlayEra = playIdxSet.size > 0;

  const sumOver = (pts: BehaviorPoint[] | undefined, key: keyof Omit<BehaviorPoint, "m">) =>
    (pts ?? []).filter((p) => p.m >= period.start && p.m <= period.end).reduce((a, p) => a + (p[key] ?? 0), 0);

  const rows: Row[] = useMemo(() => {
    // range-distinct total + new per entity, from player event sets.
    const totalCity = new Map<number, Set<number>>();
    const newCity = new Map<number, number>();
    const totalField = new Map<number, Set<number>>();
    const newField = new Map<number, number>();
    for (const p of data.players) {
      if (playIdxSet.has(p.firstMonthIdx)) {
        newCity.set(p.firstCityIdx, (newCity.get(p.firstCityIdx) ?? 0) + 1);
        newField.set(p.firstFieldIdx, (newField.get(p.firstFieldIdx) ?? 0) + 1);
      }
      for (let i = 0; i < p.ev.length; i += 3) {
        const m = p.ev[i];
        if (!playIdxSet.has(m)) continue;
        const c = p.ev[i + 1];
        const f = p.ev[i + 2];
        if (!totalCity.has(c)) totalCity.set(c, new Set());
        totalCity.get(c)!.add(p.u);
        if (!totalField.has(f)) totalField.set(f, new Set());
        totalField.get(f)!.add(p.u);
      }
    }

    let out: Row[];
    if (view === "city") {
      out = data.cityIndex.map((c, ci) => {
        const total = totalCity.get(ci)?.size ?? 0;
        const nw = newCity.get(ci) ?? 0;
        const spots = sumOver(data.behaviorByCity[c], "spots");
        return {
          name: c,
          registrations: sumOver(data.behaviorByCity[c], "registrations"),
          newPlayers: nw,
          totalPlayers: total,
          spots,
          spp: total > 0 ? spots / total : null,
          noMatches: !data.cityHasMatches[ci],
        };
      });
    } else {
      out = data.fieldIndex.map((f, fi) => {
        const total = totalField.get(fi)?.size ?? 0;
        const nw = newField.get(fi) ?? 0;
        const spots = sumOver(data.behaviorByField[f.label]?.points, "spots");
        return {
          name: `${f.label} · ${f.city}`,
          registrations: null,
          newPlayers: nw,
          totalPlayers: total,
          spots,
          spp: total > 0 ? spots / total : null,
          noMatches: false,
        };
      });
    }
    // PART 1 assertion — new ⊆ total, always. Throw rather than render a lie.
    for (const r of out) {
      if (r.totalPlayers < r.newPlayers) {
        throw new Error(`behavior invariant violated (${view}): ${r.name} total ${r.totalPlayers} < new ${r.newPlayers}`);
      }
    }
    return out.sort((a, b) => b.spots - a.spots);
  }, [view, data, playIdxSet]);

  function exportCsv() {
    const header = ["Metric", ...months.map((m) => monthLabel(m))];
    const body = METRICS.map((mt) => [
      mt.label,
      ...months.map((m) => {
        const p = byMonth.get(m);
        const v = p ? p[mt.key] : null;
        return v == null ? "" : v;
      }),
    ]);
    downloadCsv(`player-behavior-${period.start}_${period.end}.csv`, [header, ...body]);
  }

  const cityCount = data.cityIndex.length;
  // Spots share-bar denominator: rows with matches. Field spots sum to the same
  // total as market spots (every spot is at exactly one pitch in one market), so
  // the bar is valid in both views.
  const totSpots = rows.filter((r) => !r.noMatches).reduce((a, r) => a + r.spots, 0);

  // City-View totals row + integrity check: the market breakdown must tie to the
  // monthly rows above for registrations / new players / spots (total players is a
  // distinct count and legitimately does not sum). Throw on a mismatch — that is a
  // real bug, not a number to render.
  const cityTot =
    view === "city"
      ? rows.reduce(
          (a, r) => ({
            reg: a.reg + (r.registrations ?? 0),
            newp: a.newp + r.newPlayers,
            totp: a.totp + r.totalPlayers,
            spots: a.spots + r.spots,
          }),
          { reg: 0, newp: 0, totp: 0, spots: 0 },
        )
      : null;
  if (cityTot) {
    const monthly = months.reduce(
      (a, m) => {
        const p = byMonth.get(m);
        return { reg: a.reg + (p?.registrations ?? 0), newp: a.newp + (p?.newPlayers ?? 0), spots: a.spots + (p?.spots ?? 0) };
      },
      { reg: 0, newp: 0, spots: 0 },
    );
    for (const [label, a, b] of [
      ["registrations", cityTot.reg, monthly.reg],
      ["new players", cityTot.newp, monthly.newp],
      ["spots booked", cityTot.spots, monthly.spots],
    ] as [string, number, number][]) {
      if (Math.round(a) !== Math.round(b)) {
        throw new Error(`Player behavior: market ${label} total ${a} ≠ monthly total ${b}`);
      }
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Player behavior</div>
          <div className={styles.cardSub}>
            Registrations, new players, total players and spots booked · oldest to newest, over the selected period.
          </div>
        </div>
        <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={exportCsv}>
          Export
        </button>
      </div>

      {/* summary: metrics × months */}
      <div className={styles.tableWrap}>
        <table className={styles.dataTable}>
          <thead>
            <tr>
              <th>Metric</th>
              {months.map((m) => (
                <th key={m}>{monthLabel(m)}</th>
              ))}
              <th>Trend</th>
              <th>
                {months.length ? `${monthLabel(months[0]).split(" ")[0]} → ${monthLabel(months[months.length - 1]).split(" ")[0]}` : "Δ"}
              </th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((mt) => {
              const vals = months
                .map((m) => {
                  const p = byMonth.get(m);
                  return p ? p[mt.key] : null;
                })
                .filter((v): v is number => v != null);
              const d = pctDelta(vals);
              return (
                <tr key={mt.key}>
                  <td>{mt.label}</td>
                  {months.map((m) => {
                    const p = byMonth.get(m);
                    const v = p ? p[mt.key] : null;
                    return <td key={m}>{v == null ? <span className={styles.tableGap}>—</span> : fmtInt(v)}</td>;
                  })}
                  <td style={{ paddingTop: 4, paddingBottom: 4 }}>
                    <div style={{ display: "flex", justifyContent: "flex-end" }}>
                      <Sparkline values={vals} />
                    </div>
                  </td>
                  <td style={{ color: d ? (d.pos ? "var(--ok-ink)" : "var(--negative)") : "var(--muted)", fontWeight: 800 }}>
                    {d ? d.txt : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* breakdown */}
      <div className={styles.controlsRow} style={{ margin: "16px 0 10px" }}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Breakdown</span>
          <div className={styles.segmented}>
            {(
              [
                ["city", "City View"],
                ["field", "Field View"],
              ] as ["city" | "field", string][]
            ).map(([v, txt]) => (
              <button
                key={v}
                type="button"
                className={`${styles.segBtn} ${view === v ? styles.segBtnActive : ""}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {txt}
              </button>
            ))}
          </div>
        </div>
        <span className={styles.summaryLine}>
          {view === "city" ? `${cityCount} ${plural(cityCount, "market")}` : `${rows.length} ${plural(rows.length, "field")}`} ·
          ranked by spots
          {view === "field"
            ? " · Registrations attach to a market, never a pitch, so they dash here — a dash is not a zero. spots/player = spots ÷ distinct players at this pitch, not comparable to the city figure (~32% of players use more than one pitch)"
            : ""}
        </span>
      </div>

      {!hasPlayEra && (
        <div className={styles.footnote}>
          The selected period predates any matches (play data starts {monthLabel(data.floors.play)}), so new / total /
          spots are shown as dashes — unknown, not zero.
        </div>
      )}

      <div className={`${styles.tableWrap} ${styles.scrollBody}`}>
        <table className={styles.recordTable}>
          <thead>
            <tr>
              <th>{view === "city" ? "Market" : "Field"}</th>
              <th className="num">Registrations</th>
              <th className="num">New players</th>
              <th className="num">Total players</th>
              <th className="num">Spots booked</th>
              <th className="num">Spots / player</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const share = totSpots ? (r.spots / totSpots) * 100 : 0;
              return (
                <tr key={r.name}>
                  <td>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 19,
                        height: 19,
                        borderRadius: 999,
                        background: "var(--chip-bg)",
                        border: "1px solid var(--chip-line)",
                        color: "var(--ns-ink)",
                        fontSize: "10.5px",
                        fontWeight: 800,
                        marginRight: 10,
                        verticalAlign: "middle",
                      }}
                    >
                      {i + 1}
                    </span>
                    {r.name}
                    {r.noMatches && (
                      <span className={styles.pillAmber} style={{ marginLeft: 8 }}>
                        no matches
                      </span>
                    )}
                  </td>
                  {/* A registration attaches to a MARKET, never to a pitch — so Field
                      View dashes it rather than dropping the column. */}
                  <td className="num">
                    {view === "field" ? (
                      <span className={styles.tableGap}>—</span>
                    ) : r.registrations == null ? (
                      <span className={styles.tableGap}>—</span>
                    ) : (
                      fmtInt(r.registrations)
                    )}
                  </td>
                  <td className="num">{hasPlayEra ? fmtInt(r.newPlayers) : <span className={styles.tableGap}>—</span>}</td>
                  <td className="num">{hasPlayEra ? fmtInt(r.totalPlayers) : <span className={styles.tableGap}>—</span>}</td>
                  <td className="num">
                    {!hasPlayEra ? (
                      <span className={styles.tableGap}>—</span>
                    ) : !r.noMatches ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                        {fmtInt(r.spots)}
                        <span style={{ width: 52, height: 6, borderRadius: 3, background: "var(--hair)", overflow: "hidden", flex: "0 0 auto" }}>
                          <span style={{ display: "block", height: "100%", width: `${share}%`, background: "var(--accent)" }} />
                        </span>
                        <span style={{ color: "var(--muted)", fontSize: "0.7rem", minWidth: 36, textAlign: "right" }}>{share.toFixed(1)}%</span>
                      </span>
                    ) : (
                      fmtInt(r.spots)
                    )}
                  </td>
                  <td className="num">
                    {hasPlayEra && r.spp != null ? r.spp.toFixed(2) : <span className={styles.tableGap}>—</span>}
                  </td>
                </tr>
              );
            })}
            {cityTot && (
              <tr>
                {(
                  [
                    ["All markets", "l"],
                    [fmtInt(cityTot.reg), "num"],
                    [fmtInt(cityTot.newp), "num"],
                    [fmtInt(cityTot.totp), "num"],
                    [fmtInt(cityTot.spots), "num"],
                    ["—", "num"],
                  ] as [string, string][]
                ).map(([val, cls], j) => (
                  <td key={j} className={cls === "num" ? "num" : undefined} style={{ borderTop: "2px solid var(--line)", fontWeight: 800 }}>
                    {val === "—" ? <span className={styles.tableGap}>—</span> : val}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {view === "field" && data.eventFields.length > 0 && (
        <div className={`${styles.tableWrap}`} style={{ marginTop: 14 }}>
          <div className={styles.footnote} style={{ marginBottom: 6, fontWeight: 700 }}>
            Special events — tournaments &amp; combines — kept out of the pitch ranking above. Real spots booked in a real
            market, but not regular per-pitch play, so they do not inflate a field&rsquo;s spots or spots/player.
          </div>
          <table className={styles.recordTable}>
            <thead>
              <tr>
                <th>Event pitch</th>
                <th className="num">Spots booked</th>
                <th className="num">Distinct players</th>
              </tr>
            </thead>
            <tbody>
              {data.eventFields.map((e) => (
                <tr key={e.label}>
                  <td>
                    {e.label}{" "}
                    <span style={{ color: "var(--muted)", fontSize: "0.72rem" }}>· {e.city}</span>
                  </td>
                  <td className="num">{fmtInt(e.spots)}</td>
                  <td className="num">{fmtInt(e.players)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {view === "city" && (
        <div className={styles.footnote}>
          Registrations, new players and spots booked add up across markets and match the monthly rows above.{" "}
          <b>Total players does not</b> — it counts each market&rsquo;s distinct players, so anyone who played in two
          markets is counted in both. El Paso and New York City have registrations but have never run a match, so their
          zeros are real zeros, not missing data.
        </div>
      )}
    </div>
  );
}
