"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type SnapshotRow = {
  month: string; // YYYY-MM-DD (always first-of-month)
  active_count: number;
};

const W = 800;
const H = 220;
const TOP_PAD = 32;
const BOTTOM_PAD = 32;
// Asymmetric horizontal padding: extra room on the left for y-axis
// tick labels, minimal on the right.
const LEFT_PAD = 40;
const RIGHT_PAD = 16;
const PLOT_H = H - TOP_PAD - BOTTOM_PAD;
const PLOT_W = W - LEFT_PAD - RIGHT_PAD;

// Pick a "nice" y-axis step that yields ~5-7 ticks for the given max.
// Hand-rolled so we don't need Recharts for one chart.
function pickStep(max: number): number {
  const target = Math.ceil(Math.max(1, max) / 6);
  if (target <= 5) return 5;
  if (target <= 10) return 10;
  if (target <= 25) return 25;
  if (target <= 50) return 50;
  if (target <= 100) return 100;
  if (target <= 250) return 250;
  return Math.ceil(target / 100) * 100;
}

export default function MembershipActiveChart() {
  const [rows, setRows] = useState<SnapshotRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("members_monthly_snapshots")
      .select("month, active_count")
      .order("month", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setError(error.message);
          return;
        }
        setRows((data ?? []) as SnapshotRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (rows === null && !error) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10 sm:p-7">
        Loading membership history…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-2xl border border-coral/40 bg-coral-soft p-6 text-sm text-coral sm:p-7">
        Couldn&apos;t load membership history: {error}
      </div>
    );
  }

  const data = rows ?? [];

  if (data.length === 0) {
    return (
      <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          Active Members · all-time
        </div>
        <div className="mt-3 text-sm text-deep-green/55">
          No snapshots yet — upload a Members CSV to capture one.
        </div>
      </section>
    );
  }

  if (data.length === 1) {
    const only = data[0];
    return (
      <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          Active Members · all-time
        </div>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
            {only.active_count.toLocaleString()}
          </span>
          <span className="text-sm font-medium text-deep-green/60">
            active · {monthYearLabel(only.month)}
          </span>
        </div>
        <div className="mt-3 text-sm text-deep-green/55">
          Just one data point so far — line chart will appear once you have 2+ months.
        </div>
      </section>
    );
  }

  const current = data[data.length - 1];
  const prev = data[data.length - 2];
  const delta = current.active_count - prev.active_count;

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        Active Members · all-time
      </div>
      <div className="mt-3 text-sm text-deep-green/75">
        <span className="font-bold tabular-nums text-deep-green">
          {current.active_count.toLocaleString()}
        </span>{" "}
        active ·{" "}
        <span className={`font-bold tabular-nums ${deltaClass(delta)}`}>
          {fmtSigned(delta)}
        </span>{" "}
        from last month
      </div>
      <div className="mt-5">
        <Chart rows={data} />
      </div>
    </section>
  );
}

function Chart({ rows }: { rows: SnapshotRow[] }) {
  const max = Math.max(...rows.map((r) => r.active_count));
  // Round max up to the next step boundary so the top tick has a
  // little headroom above the highest data point and the y-axis
  // labels read as round numbers.
  const step = pickStep(max);
  const yMax = Math.max(step, Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= yMax; t += step) ticks.push(t);

  const yScale = (v: number) =>
    TOP_PAD + (PLOT_H - (v / yMax) * PLOT_H);
  const xScale = (i: number) =>
    rows.length === 1
      ? LEFT_PAD + PLOT_W / 2
      : LEFT_PAD + (i / (rows.length - 1)) * PLOT_W;

  const path = rows
    .map((r, i) => `${i === 0 ? "M" : "L"} ${xScale(i)} ${yScale(r.active_count)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full"
      role="img"
      aria-label="Active members over time"
    >
      <defs>
        <pattern
          id="active-current-stripes"
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill="#2cdb87" />
          <rect x="3" width="3" height="6" fill="#ffffff" fillOpacity="0.55" />
        </pattern>
      </defs>

      {/* Y-axis gridlines + tick labels. Rendered before the path
          so the data line draws on top of the gridlines. */}
      {ticks.map((t) => {
        const y = yScale(t);
        return (
          <g key={`tick-${t}`}>
            <line
              x1={LEFT_PAD}
              y1={y}
              x2={W - RIGHT_PAD}
              y2={y}
              stroke="#003326"
              strokeOpacity={0.08}
              strokeWidth={1}
            />
            <text
              x={LEFT_PAD - 8}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="#003326"
              fillOpacity="0.55"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {t}
            </text>
          </g>
        );
      })}

      <path d={path} fill="none" stroke="#2cdb87" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

      {rows.map((r, i) => {
        const cx = xScale(i);
        const cy = yScale(r.active_count);
        const isCurrent = i === rows.length - 1;
        // Render an x-axis tick label every 3 months (quarterly
        // cadence) so 28 points stay readable. Hover tooltip on the
        // dot still surfaces the exact month + count for any point.
        const showTick = i % 3 === 0;
        return (
          <g key={r.month}>
            <circle
              cx={cx}
              cy={cy}
              r={5}
              fill={isCurrent ? "url(#active-current-stripes)" : "#2cdb87"}
              stroke="#003326"
              strokeWidth={isCurrent ? 1 : 0}
              strokeOpacity={0.25}
            >
              <title>
                {monthYearLabel(r.month)} · {r.active_count.toLocaleString()} active
              </title>
            </circle>
            {showTick && (
              <text
                x={cx}
                y={H - 10}
                textAnchor="middle"
                fontSize={11}
                fill="#003326"
                fillOpacity="0.6"
                fontFamily="var(--font-geist-sans), system-ui, sans-serif"
              >
                {monthShortYearTick(r.month)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function fmtSigned(n: number): string {
  if (n === 0) return "—";
  return n > 0 ? `+${n}` : String(n);
}

function deltaClass(n: number): string {
  if (n > 0) return "text-mint-hover";
  if (n < 0) return "text-coral";
  return "text-deep-green/55";
}

// "2026-04-01" → Date at local midnight (avoids UTC shift).
function parseFirstOfMonth(s: string): Date {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(s);
}

function monthYearLabel(s: string): string {
  return parseFirstOfMonth(s).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function monthShortYearTick(s: string): string {
  const d = parseFirstOfMonth(s);
  const month = d.toLocaleDateString("en-US", { month: "short" });
  const yr = String(d.getFullYear()).slice(-2);
  return `${month} '${yr}`;
}
