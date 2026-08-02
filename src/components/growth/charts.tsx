"use client";

// Hand-rolled SVG charts for the Growth dashboard. Single Y axis only — no
// dual-axis (PART 9). Colour is never the sole encoding: every chart ships with
// a companion values table rendered by its panel, and points expose values on
// hover. Nulls in a series break the line (a series that has no data yet is not
// drawn at zero) — this is how the behaviour chart shows each series' own start.

import { useState } from "react";
import styles from "./growth.module.css";

export type Series = { label: string; color: string; values: (number | null)[] };

const PAD_L = 46;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 34;

export function LineChart({
  axis,
  series,
  height = 240,
  step = 46,
  formatValue = (v: number) => v.toLocaleString("en-US"),
  formatAxis = (s: string) => s,
  startMarkers = [],
  yUnit = "",
}: {
  axis: string[];
  series: Series[];
  height?: number;
  step?: number;
  formatValue?: (v: number) => string;
  formatAxis?: (s: string) => string;
  startMarkers?: { index: number; label: string }[];
  yUnit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(1, axis.length - 1) * step;
  const width = PAD_L + plotW + PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const allVals = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const rawMax = allVals.length ? Math.max(...allVals) : 1;
  const yMax = niceMax(rawMax);
  const x = (i: number) => PAD_L + i * step;
  const y = (v: number) => PAD_T + plotH - (v / yMax) * plotH;

  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (yMax / ticks) * i);
  const labelEvery = Math.max(1, Math.ceil(axis.length / Math.max(1, Math.floor(plotW / 70))));

  return (
    <div className={styles.chartScroll}>
      <svg
        className={styles.chartSvg}
        width={width}
        height={height}
        role="img"
        aria-label="line chart"
        onMouseLeave={() => setHover(null)}
      >
        {/* horizontal grid + y labels */}
        {gridVals.map((gv, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={width - PAD_R} y1={y(gv)} y2={y(gv)} stroke="var(--hair)" />
            <text x={PAD_L - 6} y={y(gv) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
              {gv >= 1000 ? (gv / 1000).toFixed(gv % 1000 === 0 ? 0 : 1) + "k" : Math.round(gv)}
            </text>
          </g>
        ))}
        {/* series-start markers */}
        {startMarkers.map((m, i) => (
          <g key={i}>
            <line
              x1={x(m.index)}
              x2={x(m.index)}
              y1={PAD_T}
              y2={PAD_T + plotH}
              stroke="var(--gold-dot)"
              strokeDasharray="3 3"
            />
            <text x={x(m.index) + 4} y={PAD_T + 10} fontSize="9.5" fill="var(--gold-ink)" fontWeight="600">
              {m.label}
            </text>
          </g>
        ))}
        {/* x labels */}
        {axis.map((a, i) =>
          i % labelEvery === 0 ? (
            <text key={i} x={x(i)} y={height - 12} textAnchor="middle" fontSize="10" fill="var(--muted)">
              {formatAxis(a)}
            </text>
          ) : null,
        )}
        {/* series polylines (break at nulls) */}
        {series.map((s) => (
          <g key={s.label}>
            {segments(s.values).map((seg, si) => (
              <polyline
                key={si}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                points={seg.map((i) => `${x(i)},${y(s.values[i]!)}`).join(" ")}
              />
            ))}
            {s.values.map((v, i) =>
              v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 3.5 : 2} fill={s.color} />,
            )}
          </g>
        ))}
        {/* hover cursor + hit areas */}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--forest)" strokeOpacity="0.25" />
        )}
        {axis.map((_, i) => (
          <rect
            key={i}
            x={x(i) - step / 2}
            y={PAD_T}
            width={step}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover != null && (
        <div className={styles.summaryLine} role="status">
          <b style={{ color: "var(--forest)" }}>{formatAxis(axis[hover])}</b>
          {"  "}
          {series.map((s) => (
            <span key={s.label} style={{ marginLeft: 12 }}>
              <span className={styles.legendDot} style={{ background: s.color, display: "inline-block" }} />{" "}
              {s.label}: {s.values[hover] == null ? "no data" : formatValue(s.values[hover]!) + yUnit}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// contiguous index runs where the value is non-null.
function segments(values: (number | null)[]): number[][] {
  const runs: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else {
      cur.push(i);
    }
  });
  if (cur.length) runs.push(cur);
  // single-point runs still need a visible dot (polyline of one point draws
  // nothing) — the circle layer handles that, so keep runs of length ≥2 for lines.
  return runs.filter((r) => r.length >= 2);
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}
