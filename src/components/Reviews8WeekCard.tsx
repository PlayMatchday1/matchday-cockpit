"use client";

import { getRecentReviewStats, type WeekStat } from "@/lib/reviewStats";
import type { ReviewRow } from "@/lib/useReviewData";

const W = 800;
const H = 180;
const TOP_PAD = 26;
const BOTTOM_PAD = 44;
const PLOT_H = H - TOP_PAD - BOTTOM_PAD;
const BAR_FRAC = 0.7;

const SCALE_MIN = 3.5;
const SCALE_MAX = 5.0;
const SCALE_RANGE = SCALE_MAX - SCALE_MIN;

export default function Reviews8WeekCard({
  rows,
  city = null,
}: {
  rows: ReviewRow[];
  city?: string | null;
}) {
  const stats = getRecentReviewStats(rows, city, 8);
  const weeklyAvg = stats.count > 0 ? Math.round(stats.count / 8) : 0;

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
        Last 8 weeks
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-5xl uppercase leading-none tracking-tight text-deep-green md:text-6xl">
          {stats.count > 0 ? stats.avgRating.toFixed(1) : "—"}
        </span>
        <span className="text-2xl text-mint">★</span>
        <span className="text-sm font-medium text-deep-green/60">
          avg rating
        </span>
      </div>
      <div className="mt-1 text-sm text-deep-green/70">
        {stats.count.toLocaleString()} reviews · ~{weeklyAvg} per week
      </div>

      {stats.count > 0 && (
        <div className="mt-6">
          <ReviewsBarChart weeks={stats.weeks} />
        </div>
      )}
    </section>
  );
}

function ReviewsBarChart({ weeks }: { weeks: WeekStat[] }) {
  const slot = W / weeks.length;
  const barW = slot * BAR_FRAC;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full"
      role="img"
      aria-label="Avg rating per week (3.5-5.0 scale)"
    >
      <defs>
        <pattern
          id="reviews-stripes"
          patternUnits="userSpaceOnUse"
          width="10"
          height="10"
          patternTransform="rotate(45)"
        >
          <rect width="10" height="10" fill="#2cdb87" />
          <rect x="5" width="5" height="10" fill="#ffffff" fillOpacity="0.45" />
        </pattern>
      </defs>
      {weeks.map((w, i) => {
        const isCurrent = i === weeks.length - 1;
        const hasData = w.count > 0;
        const clamped = Math.max(
          SCALE_MIN,
          Math.min(SCALE_MAX, w.avgRating),
        );
        const fraction = hasData ? (clamped - SCALE_MIN) / SCALE_RANGE : 0;
        const h = hasData ? Math.max(fraction * PLOT_H, 1) : 0;
        const cx = slot * i + slot / 2;
        const x = cx - barW / 2;
        const y = TOP_PAD + (PLOT_H - h);
        const fill = isCurrent ? "url(#reviews-stripes)" : "#2cdb87";
        const topLabel = hasData ? w.avgRating.toFixed(2) : "—";
        const countLabel = hasData
          ? `${w.count.toLocaleString()} ${w.count === 1 ? "review" : "reviews"}`
          : "no reviews";
        return (
          <g key={i}>
            <text
              x={cx}
              y={TOP_PAD - 8}
              textAnchor="middle"
              fontSize={13}
              fontWeight={700}
              fill="#003326"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {topLabel}
            </text>
            {hasData && (
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                fill={fill}
                rx={4}
              >
                <title>
                  {w.weekLabel}: {topLabel}★ · {countLabel}
                </title>
              </rect>
            )}
            <text
              x={cx}
              y={H - 24}
              textAnchor="middle"
              fontSize={11}
              fill="#003326"
              fillOpacity="0.6"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {w.weekLabel}
            </text>
            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              fontSize={10}
              fill="#003326"
              fillOpacity="0.45"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {countLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
