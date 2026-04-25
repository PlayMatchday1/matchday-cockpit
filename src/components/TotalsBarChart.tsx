import type { WeeklySpotsEntry } from "@/lib/cityStats";

const W = 800;
const H = 160;
const TOP_PAD = 24;
const BOTTOM_PAD = 24;
const PLOT_H = H - TOP_PAD - BOTTOM_PAD;
const BAR_FRAC = 0.75;

export default function TotalsBarChart({
  weeks,
}: {
  weeks: WeeklySpotsEntry[];
}) {
  if (weeks.length === 0) return null;

  const max = Math.max(...weeks.map((w) => w.matches), 1);
  const slot = W / weeks.length;
  const barW = slot * BAR_FRAC;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full"
      role="img"
      aria-label="Weekly matches over the last 8 weeks"
    >
      <defs>
        <pattern
          id="totals-stripes"
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
        const h = (w.matches / max) * PLOT_H;
        const cx = slot * i + slot / 2;
        const x = cx - barW / 2;
        const y = TOP_PAD + (PLOT_H - h);
        const fill = w.isCurrent ? "url(#totals-stripes)" : "#2cdb87";
        return (
          <g key={w.weekLabel}>
            <text
              x={cx}
              y={TOP_PAD - 8}
              textAnchor="middle"
              fontSize={14}
              fontWeight={700}
              fill="#003326"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {w.matches}
            </text>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(h, 1)}
              fill={fill}
              rx={4}
            >
              <title>
                {w.weekLabel}: {w.matches} matches · {w.spots} spots
              </title>
            </rect>
            <text
              x={cx}
              y={H - 6}
              textAnchor="middle"
              fontSize={12}
              fill="#003326"
              fillOpacity="0.6"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {w.weekLabel}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
