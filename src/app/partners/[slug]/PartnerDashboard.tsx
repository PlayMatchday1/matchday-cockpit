"use client";

import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "@/lib/supabase";
import {
  partnerLabelForType,
  type PartnerMonthStat,
  type PartnerPaymentInfo,
  type PartnerStats,
  type PartnerWeeklyPayment,
  type PartnerWeekStat,
} from "@/lib/partnerStats";

const FMT_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function fmtDateYmd(ymd: string | null): string {
  if (!ymd) return "—";
  return FMT_DATE.format(new Date(`${ymd}T12:00:00Z`));
}

function fmtUsd(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

const FMT_MONTH_YEAR = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function fmtMonthYear(ymd: string | null): string {
  if (!ymd) return "—";
  return FMT_MONTH_YEAR.format(new Date(`${ymd}T12:00:00Z`));
}

// Period label for a Weekly Payments / Monthly Payments row.
//   - pre-system → "Through Apr 30, 2026"
//   - weekly     → "Week of May 3, 2026"
//   - monthly    → "May 2026"
function periodLabel(
  weekStartDate: string,
  isPreSystem: boolean,
  cadence: "weekly" | "monthly",
): string {
  if (isPreSystem) return `Through ${fmtDateYmd(weekStartDate)}`;
  if (cadence === "monthly") return fmtMonthYear(weekStartDate);
  return `Week of ${fmtDateYmd(weekStartDate)}`;
}

export default function PartnerDashboard({
  partnerDashboardId,
  partnerName,
  stats,
  payment,
  dataBaseline,
}: {
  partnerDashboardId: string;
  partnerName: string;
  stats: PartnerStats;
  payment: PartnerPaymentInfo;
  // YYYY-MM-DD when set; means stats sections were scoped to rows on
  // or after this date. null = no scoping (default partner behavior).
  // See PARTNER_DATA_BASELINE in the page.tsx server component.
  dataBaseline: string | null;
}) {
  const subtitle = stats.lastMatchDate
    ? `Launch through ${fmtDateYmd(stats.lastMatchDate)} · Staff excluded · Revenue = match price paid`
    : "Staff excluded · Revenue = match price paid";

  const totalsLabel = dataBaseline
    ? `Totals since ${fmtDateYmd(dataBaseline)}`
    : "All-time totals";

  if (stats.weeks.length === 0) {
    return (
      <main className="mx-auto max-w-7xl px-6 py-10 sm:px-8 sm:py-12">
        <Header partnerName={partnerName} subtitle={subtitle} />
        <div className="mt-12 rounded-2xl border border-cream-line bg-white p-10 text-center text-sm text-deep-green/60">
          No registration data yet for this venue. Check back after the
          first scheduled match.
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-10 sm:px-8 sm:py-12">
      <Header partnerName={partnerName} subtitle={subtitle} />

      <SecLabel className="mt-10">{totalsLabel}</SecLabel>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {/* The 5 header cards are identical across every partner
            dashboard. They were previously gated on dataBaseline (only
            Hattrick had one), so partners without a baseline showed
            "MatchDay players" / "Total revenue" instead of "MatchDay
            registrations" / "Unique players". uniquePlayers is computed
            for every partner regardless of baseline, so the same layout
            renders everywhere. dataBaseline keeps its other jobs (date-
            scoping the stats, ISO-week labels) — it just no longer
            drives this header. Revenue still appears in By-month and
            Week-by-week below. */}
        <Metric label="Total spots filled" value={stats.totals.spots.toLocaleString()} sub="players who showed up" />
        <Metric label="MatchDay registrations" value={stats.totals.md.toLocaleString()} sub="registered app users" />
        <Metric label="Guests brought" value={stats.totals.guests.toLocaleString()} sub="guest spots purchased by players" />
        <Metric label="Cancellations" value={stats.totals.cancels.toLocaleString()} sub="non-refundable cancel within 24 hrs" />
        <Metric label="Unique players" value={stats.totals.uniquePlayers.toLocaleString()} sub="distinct people who showed up" />
      </div>

      {stats.byMonth.length > 0 && (
        <>
          <SecLabel className="mt-10">By month</SecLabel>
          <MonthlySummary months={stats.byMonth} />
        </>
      )}

      {payment.enabled && (
        <WeeklyPaymentsSection
          partnerDashboardId={partnerDashboardId}
          payment={payment}
        />
      )}

      <SecLabel className="mt-10">Week by week</SecLabel>
      <WeekGrid weeks={stats.weeks} useIsoDateLabels={!!dataBaseline} />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <SecLabel>New vs returning MatchDay players</SecLabel>
          <PlayerChart weeks={stats.weeks} useIsoDateLabels={!!dataBaseline} />
          <Legend
            items={[
              { color: "#2e79ff", label: "New MatchDay" },
              { color: "#21bf72", label: "Returning MatchDay" },
              { color: "#ff6955", label: "Guests" },
            ]}
          />
        </Card>
        <Card>
          <SecLabel>Revenue by week</SecLabel>
          <RevenueChart weeks={stats.weeks} useIsoDateLabels={!!dataBaseline} />
          <Legend
            items={[
              { color: "#21bf72", label: "Total revenue" },
              { color: "#ff9b8b", label: "Cancel portion" },
            ]}
          />
        </Card>
      </div>

      <p className="mt-10 text-center text-xs text-deep-green/45">
        <a
          href="https://playmatchday.com"
          target="_blank"
          rel="noopener noreferrer"
          className="transition hover:text-deep-green hover:underline"
        >
          playmatchday.com
        </a>
      </p>
    </main>
  );
}

function Header({
  partnerName,
  subtitle,
}: {
  partnerName: string;
  subtitle: string;
}) {
  return (
    <div>
      <h1 className="font-display text-4xl uppercase leading-none tracking-tight text-deep-green md:text-5xl">
        {partnerName}{" "}
        <span className="text-deep-green/55">— partner dashboard</span>
      </h1>
      <p className="mt-2 text-sm text-deep-green/60">{subtitle}</p>
    </div>
  );
}

function SecLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      className={`text-[11px] font-bold uppercase tracking-[0.07em] text-deep-green/55 ${className}`}
    >
      {children}
    </p>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl bg-cream-soft px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-deep-green/55">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-medium text-deep-green tabular-nums">
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-deep-green/45">{sub}</p>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-cream-line bg-white p-5">
      {children}
    </div>
  );
}

function Legend({
  items,
}: {
  items: { color: string; label: string }[];
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-4">
      {items.map((it) => (
        <div
          key={it.label}
          className="flex items-center gap-1.5 text-xs text-deep-green/65"
        >
          <span
            aria-hidden
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ backgroundColor: it.color }}
          />
          {it.label}
        </div>
      ))}
    </div>
  );
}

function MonthlySummary({ months }: { months: PartnerMonthStat[] }) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-cream-line bg-white">
      <table className="w-full text-sm">
        <thead className="bg-cream-soft/60 text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
          <tr>
            <th className="px-4 py-2.5 text-left">Month</th>
            <th className="px-4 py-2.5 text-right">Total matches</th>
            <th className="px-4 py-2.5 text-right">Total revenue</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m, i) => (
            <tr
              key={m.ym}
              className={i > 0 ? "border-t border-cream-line" : ""}
            >
              <td className="px-4 py-2.5 text-deep-green">{m.label}</td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-deep-green">
                {m.matches}
              </td>
              <td className="px-4 py-2.5 text-right font-mono font-medium tabular-nums text-deep-green">
                {fmtUsd(m.revenue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WeekGrid({
  weeks,
  useIsoDateLabels,
}: {
  weeks: PartnerWeekStat[];
  useIsoDateLabels: boolean;
}) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {weeks.map((w, i) => (
        <WeekCard
          key={w.wkMonday}
          week={w}
          index={i}
          useIsoDateLabels={useIsoDateLabels}
        />
      ))}
    </div>
  );
}

// Mon-Sun ISO week label, e.g. "Mar 31 – Apr 5". Includes year only
// when the week straddles a year boundary. Used when the dashboard is
// scoped to a baseline (currently Hattrick) — drops the "Week N" prefix
// since the date range alone is the more useful identifier.
function isoWeekRangeLabel(wkMonday: string): string {
  const start = new Date(`${wkMonday}T12:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const fmtMD = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const fmtMDY = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  if (sameYear) return `${fmtMD.format(start)} – ${fmtMD.format(end)}`;
  return `${fmtMDY.format(start)} – ${fmtMDY.format(end)}`;
}

function WeekCard({
  week,
  index,
  useIsoDateLabels,
}: {
  week: PartnerWeekStat;
  index: number;
  useIsoDateLabels: boolean;
}) {
  const baseCls =
    "rounded-xl border border-cream-line bg-white p-3.5 text-sm";
  const dateRangeLabel = useIsoDateLabels
    ? isoWeekRangeLabel(week.wkMonday)
    : null;

  if (week.voided) {
    return (
      <div className={`${baseCls} bg-cream-soft/60 opacity-60`}>
        {dateRangeLabel ? (
          <p className="text-[11px] font-semibold uppercase tracking-[0.07em] text-deep-green/55">
            {dateRangeLabel}
          </p>
        ) : (
          <>
            <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-deep-green/45">
              Week {index + 1}
            </p>
            <p className="text-[11px] text-deep-green/55">{week.label}</p>
          </>
        )}
        <p className="mt-2 font-mono text-2xl font-medium text-deep-green/30">
          —
        </p>
        <p className="text-[11px] text-deep-green/55">all cancelled</p>
        <p className="mt-1 text-xs text-deep-green/55">
          — MatchDay · — guests
        </p>
        <Hr />
        <Row label="Distinct MatchDay players" value="—" />
        <Row label="New players" value="—" />
        <Row label="Returning players" value="—" />
        <Hr />
        <Row label="Daily paid" value="—" />
        <Row label="Members" value="—" />
        <Row label="Promo" value="—" />
        <Row label="Matches" value="0" />
        <Row label="Avg price/match" value="—" />
        <Hr />
        <Row label="Cancels" value="—" />
        <Row label="Revenue" value="$0" />
      </div>
    );
  }

  const isCurrent = week.isLatest;
  const cls = isCurrent
    ? `${baseCls} border-mint border-2`
    : baseCls;

  return (
    <div className={cls}>
      {dateRangeLabel ? (
        <p
          className={`text-[11px] font-semibold uppercase tracking-[0.07em] ${isCurrent ? "text-mint-hover" : "text-deep-green/55"}`}
        >
          {dateRangeLabel}
          {isCurrent && " · latest"}
        </p>
      ) : (
        <>
          <p
            className={`text-[10px] font-semibold uppercase tracking-[0.07em] ${isCurrent ? "text-mint-hover" : "text-deep-green/45"}`}
          >
            Week {index + 1}
            {isCurrent && " · latest"}
          </p>
          <p className="text-[11px] text-deep-green/55">{week.label}</p>
        </>
      )}
      <p className="mt-2 font-mono text-3xl font-medium leading-none text-deep-green">
        {week.totalPlayers}
      </p>
      <p className="mt-0.5 text-[11px] text-deep-green/55">total players</p>
      <p className="mt-1 text-xs text-deep-green/65">
        <b className="font-semibold text-deep-green">{week.mdPlayers}</b>{" "}
        MatchDay ·{" "}
        <b className="font-semibold text-deep-green">{week.guests}</b>{" "}
        guests
      </p>
      <Hr />
      {/* Distinct MatchDay players = newP + retP (both are counts of
          distinct user_ids — the first-appearance partition). Shown
          above New/Returning so the split visibly reconciles: it sums
          to this line, not to Total players (which counts spots, incl.
          guests and a player's repeat matches in the week). */}
      <Row label="Distinct MatchDay players" value={(week.newP + week.retP).toString()} />
      <Row label="New players" value={week.newP.toString()} valueColor="text-blue-info" />
      <Row label="Returning players" value={week.retP.toString()} valueColor="text-mint-hover" />
      <Hr />
      <Row label="Daily paid" value={week.dp.toString()} />
      <Row label="Members" value={week.mem.toString()} />
      <Row label="Promo" value={week.promo.toString()} />
      <Row label="Matches" value={week.matches.toString()} />
      <Row
        label="Avg price/match"
        value={
          week.dpSpots > 0
            ? `$${(week.dpRev / week.dpSpots).toFixed(2)}`
            : "—"
        }
      />
      <Hr />
      <Row
        label="Cancels"
        value={
          <span>
            <span className="text-coral">{week.cancelCount}</span>
            {" · "}
            <span className="text-mint-hover">+{fmtUsd(week.cancelRev)}</span>
          </span>
        }
      />
      {week.extras.map((x) => (
        <Row
          key={x.type}
          label={partnerLabelForType(x.type)}
          value={fmtUsd(x.amount)}
          valueColor="text-mint-hover"
        />
      ))}
      <Row label="Revenue" value={fmtUsd(week.totalRev)} />
      {week.promoCodes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {week.promoCodes.map((c) => (
            <span
              key={c}
              className="rounded bg-blue-soft px-2 py-0.5 text-[10px] font-semibold text-blue-info"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Hr() {
  return <hr className="my-2 border-cream-line" />;
}

function Row({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: React.ReactNode;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between text-xs text-deep-green/65">
      <span>{label}</span>
      <span
        className={`font-mono text-[13px] font-medium tabular-nums ${valueColor ?? "text-deep-green"}`}
      >
        {value}
      </span>
    </div>
  );
}

// Compact "M/D" label from a YYYY-MM-DD week-Monday string. Used as
// the chart x-axis tick when the dashboard is scoped to a baseline
// (currently Hattrick) — pairs with the date-only "Mar 30 – Apr 5"
// week card headers above. M/D fits ~4 chars in the right-column
// chart at 1fr without rotation, and scales as the visible week
// count grows.
function chartTickLabel(wkMonday: string): string {
  const d = new Date(`${wkMonday}T12:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function PlayerChart({
  weeks,
  useIsoDateLabels,
}: {
  weeks: PartnerWeekStat[];
  useIsoDateLabels: boolean;
}) {
  const data = weeks.map((w, i) => ({
    name: useIsoDateLabels ? chartTickLabel(w.wkMonday) : `W${i + 1}`,
    new: w.voided ? 0 : w.newP,
    returning: w.voided ? 0 : w.retP,
    guests: w.voided ? 0 : w.guests,
  }));
  return (
    <div className="mt-3 h-[220px] w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgba(0,51,38,0.08)" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6f7e76" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 11, fill: "#6f7e76" }} axisLine={false} tickLine={false} />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: "1px solid #e6dec9",
              fontSize: 12,
            }}
          />
          <Bar dataKey="new" stackId="a" fill="#2e79ff" name="New MatchDay" />
          <Bar dataKey="returning" stackId="a" fill="#21bf72" name="Returning MatchDay" />
          <Bar dataKey="guests" stackId="a" fill="#ff6955" name="Guests" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function RevenueChart({
  weeks,
  useIsoDateLabels,
}: {
  weeks: PartnerWeekStat[];
  useIsoDateLabels: boolean;
}) {
  const data = weeks.map((w, i) => ({
    name: useIsoDateLabels ? chartTickLabel(w.wkMonday) : `W${i + 1}`,
    total: w.voided ? 0 : w.totalRev,
    cancelled: w.voided ? 0 : w.cancelRev,
  }));
  return (
    <div className="mt-3 h-[220px] w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -8 }}>
          <CartesianGrid stroke="rgba(0,51,38,0.08)" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#6f7e76" }} axisLine={false} tickLine={false} />
          <YAxis
            tick={{ fontSize: 11, fill: "#6f7e76" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v}`}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: "1px solid #e6dec9",
              fontSize: 12,
            }}
            formatter={(v) => fmtUsd(typeof v === "number" ? v : Number(v) || 0)}
          />
          <Bar dataKey="total" fill="#21bf72" name="Total revenue" />
          <Bar dataKey="cancelled" fill="#ff9b8b" name="Cancel portion" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// =====================================================================
// Weekly Payments section
// =====================================================================

function WeeklyPaymentsSection({
  partnerDashboardId,
  payment,
}: {
  partnerDashboardId: string;
  payment: PartnerPaymentInfo;
}) {
  const [disputeTarget, setDisputeTarget] =
    useState<PartnerWeeklyPayment | null>(null);

  // Header + subtitle vary by cadence. Weekly partners get the original
  // Sunday-anchored copy; monthly partners get a calendar-month version
  // with the "5th of the following month" transfer rule.
  const headerLabel =
    payment.cadence === "monthly" ? "Monthly payments" : "Weekly payments";
  // Revenue-model + cadence drive the subtitle. flat_percentage reads
  // "{pct}% of qualifying revenue"; per_match_minus_manager reads "match
  // revenue minus manager pay" (Crossbar Rowlett).
  const modelClause =
    payment.revenueModel === "per_match_minus_manager"
      ? "Match revenue minus manager pay per match"
      : `${payment.revenueSharePct}% of qualifying revenue`;
  const cadenceClause =
    payment.cadence === "monthly"
      ? "Paid on the 5th of the following month."
      : "Paid weekly on Mondays.";
  const subtitle = `${modelClause}. ${cadenceClause}`;

  return (
    <>
      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SecLabel>{headerLabel}</SecLabel>
        <p className="text-xs text-deep-green/55">{subtitle}</p>
      </div>

      {payment.weeklyPayments.length > 0 && (
        <>
          {/* Desktop (md+): table layout — unchanged from before. */}
          <div className="mt-3 hidden overflow-hidden rounded-xl border border-cream-line bg-white md:block">
            <table className="w-full text-sm">
              <thead className="bg-cream-soft/60 text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
                <tr>
                  <th className="px-4 py-2.5 text-left">Period</th>
                  <th className="px-4 py-2.5 text-right">Qualifying revenue</th>
                  <th className="px-4 py-2.5 text-right">Payment owed</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-left">Paid on</th>
                  <th className="px-4 py-2.5 text-right" />
                </tr>
              </thead>
              <tbody>
                {payment.weeklyPayments.map((w, i) => {
                  const displayAmount =
                    w.status === "paid" && w.calculatedAmount != null
                      ? w.calculatedAmount
                      : w.owedAmount;
                  return (
                    <tr
                      key={`${w.isPreSystem ? "pre" : "wk"}-${w.weekStartDate}`}
                      className={i > 0 ? "border-t border-cream-line" : ""}
                    >
                      <td className="px-4 py-2.5 text-deep-green">
                        <div>
                          {periodLabel(
                            w.weekStartDate,
                            w.isPreSystem,
                            payment.cadence,
                          )}
                        </div>
                        {w.isPreSystem && (
                          <p className="mt-0.5 text-[10px] italic text-deep-green/45">
                            Pre-system settlement
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-deep-green/80">
                        {w.isPreSystem ? "—" : fmtUsd(w.qualifyingRevenue)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-medium tabular-nums text-deep-green">
                        ${displayAmount.toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusPill status={w.status} />
                        {w.status === "disputed" && w.disputeNote && (
                          <p className="mt-1 max-w-[16rem] text-[11px] italic text-deep-green/55">
                            “{w.disputeNote}”
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-deep-green/65">
                        {fmtDateYmd(w.paidAt ? w.paidAt.slice(0, 10) : null)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {/* Dispute is meaningful for any row with a
                            persisted record — including pre-system rows
                            (in case the partner contests the historical
                            settlement). */}
                        {w.status === "paid" && (
                          <button
                            type="button"
                            onClick={() => setDisputeTarget(w)}
                            className="text-xs font-semibold text-deep-green/55 transition hover:text-deep-green hover:underline"
                          >
                            Didn&apos;t receive this?
                          </button>
                        )}
                        {w.status === "disputed" && (
                          <button
                            type="button"
                            onClick={() => setDisputeTarget(w)}
                            className="text-xs font-semibold text-coral/65 transition hover:text-coral hover:underline"
                          >
                            Update dispute note
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile (<md): stacked card per row. The table compresses to
              ~70px per column at 390px viewport — labels wrap to 4 lines
              and right-side cells get cut off. The card layout puts each
              field on its own line with clear typographic hierarchy. */}
          <div className="mt-3 space-y-2 md:hidden">
            {payment.weeklyPayments.map((w) => {
              const displayAmount =
                w.status === "paid" && w.calculatedAmount != null
                  ? w.calculatedAmount
                  : w.owedAmount;
              return (
                <div
                  key={`m-${w.isPreSystem ? "pre" : "wk"}-${w.weekStartDate}`}
                  className="rounded-xl border border-cream-line bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="whitespace-nowrap text-sm font-semibold text-deep-green">
                        {periodLabel(
                          w.weekStartDate,
                          w.isPreSystem,
                          payment.cadence,
                        )}
                      </div>
                      {w.isPreSystem && (
                        <p className="mt-0.5 text-[10px] italic text-deep-green/45">
                          Pre-system settlement
                        </p>
                      )}
                    </div>
                    <StatusPill status={w.status} />
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                    <MobileField
                      label="Qualifying revenue"
                      value={
                        w.isPreSystem ? "—" : fmtUsd(w.qualifyingRevenue)
                      }
                      mono
                    />
                    <MobileField
                      label="Payment owed"
                      value={`$${displayAmount.toFixed(2)}`}
                      mono
                      strong
                    />
                    <MobileField
                      label="Paid on"
                      value={fmtDateYmd(
                        w.paidAt ? w.paidAt.slice(0, 10) : null,
                      )}
                    />
                  </div>

                  {w.status === "disputed" && w.disputeNote && (
                    <p className="mt-3 text-[12px] italic text-deep-green/60">
                      “{w.disputeNote}”
                    </p>
                  )}

                  {(w.status === "paid" || w.status === "disputed") && (
                    <div className="mt-3 border-t border-cream-line pt-2.5">
                      {w.status === "paid" && (
                        <button
                          type="button"
                          onClick={() => setDisputeTarget(w)}
                          className="text-xs font-semibold text-deep-green/55 transition hover:text-deep-green hover:underline"
                        >
                          Didn&apos;t receive this?
                        </button>
                      )}
                      {w.status === "disputed" && (
                        <button
                          type="button"
                          onClick={() => setDisputeTarget(w)}
                          className="text-xs font-semibold text-coral/65 transition hover:text-coral hover:underline"
                        >
                          Update dispute note
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* "Next payment {week|month} begins …" — coexists with any
          pre-system rows above. Shows when no generated rows have
          appeared yet AND the first qualifying period is in the
          future. */}
      {(() => {
        const hasGenerated = payment.weeklyPayments.some((w) => !w.isPreSystem);
        const todayYmd = new Date().toISOString().slice(0, 10);
        const showMessage =
          !hasGenerated &&
          payment.firstQualifyingPeriod !== null &&
          payment.firstQualifyingPeriod > todayYmd;
        if (!showMessage) return null;
        const label =
          payment.cadence === "monthly"
            ? `Next payment month begins ${fmtMonthYear(payment.firstQualifyingPeriod)}.`
            : `Next payment week begins ${fmtDateYmd(payment.firstQualifyingPeriod)}.`;
        return (
          <div className="mt-3 rounded-xl border border-cream-line bg-cream-soft/40 px-4 py-5 text-sm italic text-deep-green/55">
            {label}
          </div>
        );
      })()}

      {disputeTarget && (
        <DisputeModal
          partnerDashboardId={partnerDashboardId}
          week={disputeTarget}
          onCancel={() => setDisputeTarget(null)}
          onDone={() => {
            setDisputeTarget(null);
            // Reload the page so the new dispute state surfaces. Server
            // component re-runs against fresh DB state.
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      )}
    </>
  );
}

// Mobile-only label/value pair for the Weekly Payments card layout.
// `mono` aligns dollar amounts with the rest of the dashboard's tabular
// numerals; `strong` bumps weight for the headline "Payment owed" cell.
function MobileField({
  label,
  value,
  mono = false,
  strong = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
        {label}
      </div>
      <div
        className={`mt-0.5 text-sm ${mono ? "font-mono tabular-nums" : ""} ${strong ? "font-semibold text-deep-green" : "text-deep-green/80"}`}
      >
        {value}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "pending" | "paid" | "disputed" }) {
  if (status === "paid") {
    return (
      <span className="inline-block rounded-full bg-mint-soft px-2.5 py-0.5 text-[11px] font-semibold text-mint-hover">
        Paid
      </span>
    );
  }
  if (status === "disputed") {
    return (
      <span className="inline-block rounded-full bg-coral-soft px-2.5 py-0.5 text-[11px] font-semibold text-coral">
        Disputed
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full bg-muted-soft px-2.5 py-0.5 text-[11px] font-semibold text-muted">
      Pending
    </span>
  );
}

function DisputeModal({
  partnerDashboardId,
  week,
  onCancel,
  onDone,
}: {
  partnerDashboardId: string;
  week: PartnerWeeklyPayment;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState(week.disputeNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      // If a partner_weekly_payments row already exists, UPDATE it.
      // Otherwise INSERT a new one. RLS allows anon UPDATE (status,
      // dispute_note) on enabled dashboards' rows; INSERT is admin-
      // only so for new rows we ask the admin path — but if no row
      // exists yet, status is implicitly 'pending' with no record,
      // and there's no INSERT permission for anon. So this UI only
      // shows the dispute action on rows that already have a record
      // OR pre-creates via the same mechanism… but anon can't INSERT.
      //
      // Resolution: when no record exists, anon disputes don't reach
      // the DB. The admin path creates the row when marking paid;
      // weeks without records can't be disputed (status='pending'
      // with no row = nothing to dispute against). The UI hides the
      // "Didn't receive this?" link when recordId is null and status
      // is pending. (Disputable surface is "row exists, not yet
      // received".)
      if (!week.recordId) {
        setError(
          "This week has no payment record yet — there's nothing to dispute. Wait until the payment is marked paid, then flag it if you didn't receive the funds.",
        );
        setBusy(false);
        return;
      }
      const { error } = await supabase
        .from("partner_weekly_payments")
        .update({
          status: "disputed",
          dispute_note: note.trim() || null,
        })
        .eq("id", week.recordId);
      if (error) {
        setError(error.message);
        return;
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border-l-4 border-coral border-y-[1.5px] border-r-[1.5px] border-y-cream-line border-r-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
          Flag missing payment
        </h2>
        <p className="mt-3 text-sm text-deep-green/65">
          {fmtDateYmd(week.weekStartDate)} · Owed{" "}
          <b className="text-deep-green">${week.owedAmount.toFixed(2)}</b>
          {week.paidAt && (
            <>
              {" "}
              · Marked paid on{" "}
              {fmtDateYmd(week.paidAt.slice(0, 10))}
            </>
          )}
        </p>
        <p className="mt-3 rounded-md border border-cream-line bg-cream-soft/40 px-3 py-2 text-xs text-deep-green/65">
          Flagging this week alerts MatchDay that you didn&apos;t receive
          the payment. Add a note (optional) so we can track down where
          it went.
        </p>

        <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
          Note (optional)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="e.g., 'Checked Venmo through Tuesday — nothing received.'"
          className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-coral focus:outline-none"
        />

        {error && (
          <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
            {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-cream-line bg-white px-3 py-2 text-sm font-semibold text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy}
            className="rounded-md bg-coral px-3 py-2 text-sm font-bold text-white transition hover:bg-coral-hover disabled:opacity-60"
          >
            {busy ? "Submitting…" : "Flag as not received"}
          </button>
        </div>
      </div>
    </div>
  );
}
