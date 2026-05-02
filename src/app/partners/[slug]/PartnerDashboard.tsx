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
import type {
  PartnerMonthStat,
  PartnerPaymentInfo,
  PartnerStats,
  PartnerWeeklyPayment,
  PartnerWeekStat,
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

export default function PartnerDashboard({
  partnerDashboardId,
  partnerName,
  stats,
  payment,
}: {
  partnerDashboardId: string;
  partnerName: string;
  stats: PartnerStats;
  payment: PartnerPaymentInfo;
}) {
  const subtitle = stats.lastMatchDate
    ? `Launch through ${fmtDateYmd(stats.lastMatchDate)} · Staff excluded · Revenue = match price paid`
    : "Staff excluded · Revenue = match price paid";

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

      <SecLabel className="mt-10">All-time totals</SecLabel>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        <Metric label="Total spots filled" value={stats.totals.spots.toLocaleString()} sub="players who showed up" />
        <Metric label="MatchDay players" value={stats.totals.md.toLocaleString()} sub="registered app users" />
        <Metric label="Guests brought" value={stats.totals.guests.toLocaleString()} sub="brought by players" />
        <Metric label="Cancellations" value={stats.totals.cancels.toLocaleString()} sub="paid, didn't show" />
        <Metric label="Total revenue" value={fmtUsd(stats.totals.rev)} sub="match price paid" />
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
      <WeekGrid weeks={stats.weeks} />

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <SecLabel>New vs returning MatchDay players</SecLabel>
          <PlayerChart weeks={stats.weeks} />
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
          <RevenueChart weeks={stats.weeks} />
          <Legend
            items={[
              { color: "#21bf72", label: "Total revenue" },
              { color: "#ff9b8b", label: "Cancel portion" },
            ]}
          />
        </Card>
      </div>

      <p className="mt-10 text-center text-xs text-deep-green/45">
        MatchDay SC · playmatchday.com
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

function WeekGrid({ weeks }: { weeks: PartnerWeekStat[] }) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
      {weeks.map((w, i) => (
        <WeekCard key={w.wkMonday} week={w} index={i} />
      ))}
    </div>
  );
}

function WeekCard({
  week,
  index,
}: {
  week: PartnerWeekStat;
  index: number;
}) {
  const baseCls =
    "rounded-xl border border-cream-line bg-white p-3.5 text-sm";
  if (week.voided) {
    return (
      <div className={`${baseCls} bg-cream-soft/60 opacity-60`}>
        <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-deep-green/45">
          Week {index + 1}
        </p>
        <p className="text-[11px] text-deep-green/55">{week.label}</p>
        <p className="mt-2 font-mono text-2xl font-medium text-deep-green/30">
          —
        </p>
        <p className="text-[11px] text-deep-green/55">all cancelled</p>
        <p className="mt-1 text-xs text-deep-green/55">
          — MatchDay · — guests
        </p>
        <Hr />
        <Row label="New" value="—" />
        <Row label="Returning" value="—" />
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
      <p
        className={`text-[10px] font-semibold uppercase tracking-[0.07em] ${isCurrent ? "text-mint-hover" : "text-deep-green/45"}`}
      >
        Week {index + 1}
        {isCurrent && " · latest"}
      </p>
      <p className="text-[11px] text-deep-green/55">{week.label}</p>
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
      <Row label="New" value={week.newP.toString()} valueColor="text-blue-info" />
      <Row label="Returning" value={week.retP.toString()} valueColor="text-mint-hover" />
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
          label={x.type}
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

function PlayerChart({ weeks }: { weeks: PartnerWeekStat[] }) {
  const data = weeks.map((w, i) => ({
    name: `W${i + 1}`,
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

function RevenueChart({ weeks }: { weeks: PartnerWeekStat[] }) {
  const data = weeks.map((w, i) => ({
    name: `W${i + 1}`,
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

  const subtitle = `${payment.revenueSharePct}% of qualifying revenue (DPP + Private Rental). Paid weekly on ${dowName(payment.paymentDayOfWeek)}s.`;

  return (
    <>
      <div className="mt-10 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SecLabel>Weekly payments</SecLabel>
        <p className="text-xs text-deep-green/55">{subtitle}</p>
      </div>

      {payment.weeklyPayments.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-xl border border-cream-line bg-white">
          <table className="w-full text-sm">
            <thead className="bg-cream-soft/60 text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
              <tr>
                <th className="px-4 py-2.5 text-left">Week of</th>
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
                      {w.isPreSystem ? (
                        <>
                          <div>Through {fmtDateYmd(w.weekStartDate)}</div>
                          <p className="mt-0.5 text-[10px] italic text-deep-green/45">
                            Pre-system settlement
                          </p>
                        </>
                      ) : (
                        fmtDateYmd(w.weekStartDate)
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
      )}

      {/* "First payment week begins …" — coexists with any pre-system
          rows above. Shows when no Sunday-anchored rows have appeared
          yet AND the first qualifying Sunday is in the future. */}
      {(() => {
        const hasSunday = payment.weeklyPayments.some((w) => !w.isPreSystem);
        const todayYmd = new Date().toISOString().slice(0, 10);
        const showMessage =
          !hasSunday &&
          payment.firstQualifyingSunday !== null &&
          payment.firstQualifyingSunday > todayYmd;
        if (!showMessage) return null;
        return (
          <div
            className={`${payment.weeklyPayments.length > 0 ? "mt-3" : "mt-3"} rounded-xl border border-cream-line bg-cream-soft/40 px-4 py-5 text-sm italic text-deep-green/55`}
          >
            First payment week begins{" "}
            {fmtDateYmd(payment.firstQualifyingSunday)}.
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

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dowName(dow: number): string {
  return DOW_NAMES[dow] ?? "Sunday";
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
          Week of {fmtDateYmd(week.weekStartDate)} · Owed{" "}
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
