"use client";

import { useFinanceData } from "@/lib/useFinanceData";
import { buildMonthlyBuckets, type MonthBucket } from "@/lib/membershipStats";

const W = 800;
const H = 200;
const TOP_PAD = 28;
const BOTTOM_PAD = 28;
const PLOT_H = H - TOP_PAD - BOTTOM_PAD;
const GROUP_FRAC = 0.72; // each month's two-bar group occupies 72% of slot
const BAR_GAP = 4;

export default function MembershipTrendChart() {
  const { data, loading } = useFinanceData();
  const now = new Date();

  if (loading && !data) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 text-sm text-deep-green/60 shadow-md shadow-deep-green/10 sm:p-7">
        Loading membership data…
      </div>
    );
  }
  if (!data || data.members.length === 0) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          Subscriber Activity · last 6 months
        </div>
        <div className="mt-3 text-sm text-deep-green/55">
          No member data yet.
        </div>
      </div>
    );
  }

  const buckets = buildMonthlyBuckets(data.members, 6, now);
  const current = buckets[buckets.length - 1];
  const netCurrent = current.newCount - current.cancelledCount;
  const cumulativeNet = buckets.reduce(
    (s, b) => s + (b.newCount - b.cancelledCount),
    0,
  );

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10 sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="text-[11px] font-bold uppercase tracking-[0.25em] text-deep-green/60">
          Subscriber Activity · last 6 months
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-deep-green/65">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-mint" />
          <span>New</span>
          <span className="ml-3 inline-block h-2.5 w-2.5 rounded-sm bg-coral" />
          <span>Cancelled</span>
        </div>
      </div>
      <div className="mt-3 text-sm text-deep-green/75">
        <span className="font-bold tabular-nums text-deep-green">
          {fmtSigned(netCurrent)}
        </span>{" "}
        net this month ·{" "}
        <span className="font-bold tabular-nums text-deep-green">
          {fmtSigned(cumulativeNet)}
        </span>{" "}
        cumulative net over 6 months
      </div>
      <p className="mt-2 max-w-3xl text-[12px] italic text-deep-green/55">
        Activation and cancellation events per month. Net activity does not
        directly equal active member changes — grace-period dynamics and
        lifecycle data gaps cause expected differences with the All-Time
        chart above.
      </p>
      <div className="mt-5">
        <Chart buckets={buckets} />
      </div>
    </section>
  );
}

function fmtSigned(n: number): string {
  if (n === 0) return "0";
  return n > 0 ? `+${n}` : String(n);
}

function Chart({ buckets }: { buckets: MonthBucket[] }) {
  const max = Math.max(
    1,
    ...buckets.map((b) => Math.max(b.newCount, b.cancelledCount)),
  );
  const slot = W / buckets.length;
  const groupW = slot * GROUP_FRAC;
  const barW = (groupW - BAR_GAP) / 2;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full"
      role="img"
      aria-label="New vs cancelled members over the last 6 months"
    >
      <defs>
        <pattern
          id="membership-new-stripes"
          patternUnits="userSpaceOnUse"
          width="10"
          height="10"
          patternTransform="rotate(45)"
        >
          <rect width="10" height="10" fill="#2cdb87" />
          <rect x="5" width="5" height="10" fill="#ffffff" fillOpacity="0.45" />
        </pattern>
        <pattern
          id="membership-cancel-stripes"
          patternUnits="userSpaceOnUse"
          width="10"
          height="10"
          patternTransform="rotate(45)"
        >
          <rect width="10" height="10" fill="#ff6955" />
          <rect x="5" width="5" height="10" fill="#ffffff" fillOpacity="0.45" />
        </pattern>
      </defs>
      {buckets.map((b, i) => {
        const cx = slot * i + slot / 2;
        const groupX = cx - groupW / 2;
        const newX = groupX;
        const cancelX = groupX + barW + BAR_GAP;

        const newH = (b.newCount / max) * PLOT_H;
        const cancelH = (b.cancelledCount / max) * PLOT_H;
        const newY = TOP_PAD + (PLOT_H - newH);
        const cancelY = TOP_PAD + (PLOT_H - cancelH);

        const newFill = b.isCurrent ? "url(#membership-new-stripes)" : "#2cdb87";
        const cancelFill = b.isCurrent
          ? "url(#membership-cancel-stripes)"
          : "#ff6955";

        return (
          <g key={b.label + i}>
            {b.newCount > 0 && (
              <text
                x={newX + barW / 2}
                y={newY - 4}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill="#003326"
                fontFamily="var(--font-geist-sans), system-ui, sans-serif"
              >
                {b.newCount}
              </text>
            )}
            <rect
              x={newX}
              y={newY}
              width={barW}
              height={Math.max(newH, b.newCount > 0 ? 1 : 0)}
              fill={newFill}
              rx={3}
            >
              <title>
                {b.label}: {b.newCount} new
              </title>
            </rect>

            {b.cancelledCount > 0 && (
              <text
                x={cancelX + barW / 2}
                y={cancelY - 4}
                textAnchor="middle"
                fontSize={11}
                fontWeight={700}
                fill="#003326"
                fontFamily="var(--font-geist-sans), system-ui, sans-serif"
              >
                {b.cancelledCount}
              </text>
            )}
            <rect
              x={cancelX}
              y={cancelY}
              width={barW}
              height={Math.max(cancelH, b.cancelledCount > 0 ? 1 : 0)}
              fill={cancelFill}
              rx={3}
            >
              <title>
                {b.label}: {b.cancelledCount} cancelled
              </title>
            </rect>

            <text
              x={cx}
              y={H - 8}
              textAnchor="middle"
              fontSize={12}
              fill="#003326"
              fillOpacity="0.6"
              fontFamily="var(--font-geist-sans), system-ui, sans-serif"
            >
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
