"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  computeWeeklyPayments,
  type PartnerExtraRevRow,
  type PartnerPaymentInfo,
  type PartnerRegRow,
  type PartnerWeeklyPayment,
  type PartnerWeeklyPaymentRecord,
} from "@/lib/partnerStats";
import { supabase } from "@/lib/supabase";

const FMT_DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function fmtDateYmd(ymd: string | null): string {
  if (!ymd) return "—";
  return FMT_DATE.format(new Date(`${ymd}T12:00:00Z`));
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type DashboardRow = {
  id: string;
  slug: string;
  partner_name: string;
  enabled: boolean;
  venue_id: number;
  revenue_share_pct: number;
  payment_start_date: string | null;
  payment_day_of_week: number;
};

type Venue = {
  id: number;
  venue_name: string;
  city: string | null;
};

export default function PartnerDetailAdmin({
  partnerDashboardId,
}: {
  partnerDashboardId: string;
}) {
  const [dashboard, setDashboard] = useState<DashboardRow | null>(null);
  const [venue, setVenue] = useState<Venue | null>(null);
  const [matchRows, setMatchRows] = useState<PartnerRegRow[]>([]);
  const [extraRows, setExtraRows] = useState<PartnerExtraRevRow[]>([]);
  const [records, setRecords] = useState<PartnerWeeklyPaymentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paidTarget, setPaidTarget] = useState<PartnerWeeklyPayment | null>(null);
  const [pendingTarget, setPendingTarget] = useState<PartnerWeeklyPayment | null>(null);
  const [resolveTarget, setResolveTarget] = useState<PartnerWeeklyPayment | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { data: pd, error: pdErr } = await supabase
        .from("partner_dashboards")
        .select(
          "id, slug, partner_name, enabled, venue_id, revenue_share_pct, payment_start_date, payment_day_of_week",
        )
        .eq("id", partnerDashboardId)
        .maybeSingle();
      if (pdErr) throw new Error(pdErr.message);
      if (!pd) throw new Error("Partner dashboard not found.");
      const dash = pd as DashboardRow;
      setDashboard(dash);

      const { data: vn, error: vnErr } = await supabase
        .from("fin_venues")
        .select("id, venue_name, city")
        .eq("id", dash.venue_id)
        .maybeSingle();
      if (vnErr) throw new Error(vnErr.message);
      setVenue((vn ?? null) as Venue | null);

      // Active upload + match_registrations + fin_revenue (mirrors
      // the partner page's server-side fetch).
      const { data: upload } = await supabase
        .from("data_uploads")
        .select("id")
        .eq("is_current", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const venueName = (vn as Venue | null)?.venue_name ?? "";
      let mr: PartnerRegRow[] = [];
      if (upload && venueName) {
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("match_registrations")
            .select(
              "user_id, email, field, match_start, match_canceled, player_canceled_at, payment_type, promocode, match_price_paid",
            )
            .eq("upload_id", upload.id)
            .ilike("field", `%${venueName}%`)
            .order("match_start")
            .range(from, from + PAGE - 1);
          if (error) throw new Error(`Reg fetch: ${error.message}`);
          if (!data || data.length === 0) break;
          mr.push(...(data as PartnerRegRow[]));
          if (data.length < PAGE) break;
        }
      }
      setMatchRows(mr);

      let ex: PartnerExtraRevRow[] = [];
      if (venueName) {
        const { data: rev, error: revErr } = await supabase
          .from("fin_revenue")
          .select("date, type, gross, source, notes")
          .ilike("venue", `%${venueName}%`)
          .neq("source", "PROJECTION")
          .not("type", "in", '("DPP","Membership")');
        if (revErr) throw new Error(`fin_revenue: ${revErr.message}`);
        ex = (rev ?? []).map((r) => ({
          date: String(r.date ?? "").slice(0, 10),
          type: String(r.type ?? ""),
          gross: Number(r.gross ?? 0),
          source: String(r.source ?? ""),
          notes: r.notes ?? null,
        }));
      }
      setExtraRows(ex);

      const { data: wp, error: wpErr } = await supabase
        .from("partner_weekly_payments")
        .select(
          "id, partner_dashboard_id, week_start_date, calculated_amount, status, paid_at, paid_notes, dispute_note, disputed_at",
        )
        .eq("partner_dashboard_id", partnerDashboardId)
        .order("week_start_date", { ascending: true });
      if (wpErr) throw new Error(`weekly payments: ${wpErr.message}`);
      setRecords(
        (wp ?? []).map((r) => ({
          id: r.id,
          partner_dashboard_id: r.partner_dashboard_id,
          week_start_date: String(r.week_start_date).slice(0, 10),
          calculated_amount: Number(r.calculated_amount ?? 0),
          status: r.status as "pending" | "paid" | "disputed",
          paid_at: r.paid_at ?? null,
          paid_notes: r.paid_notes ?? null,
          dispute_note: r.dispute_note ?? null,
          disputed_at: r.disputed_at ?? null,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerDashboardId]);

  const payment: PartnerPaymentInfo | null = useMemo(() => {
    if (!dashboard) return null;
    return computeWeeklyPayments(
      matchRows,
      extraRows,
      {
        revenueSharePct: Number(dashboard.revenue_share_pct ?? 50),
        paymentStartDate: dashboard.payment_start_date,
        paymentDayOfWeek: dashboard.payment_day_of_week ?? 0,
      },
      records,
    );
  }, [dashboard, matchRows, extraRows, records]);

  // Sort weekly payments most-recent-first for the admin table.
  const weeksDesc = useMemo(() => {
    if (!payment) return [];
    return [...payment.weeklyPayments].sort((a, b) =>
      a.weekStartDate < b.weekStartDate ? 1 : -1,
    );
  }, [payment]);

  if (loading) {
    return <p className="text-sm text-deep-green/60">Loading…</p>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-coral/40 bg-coral-soft p-4 text-sm text-coral">
        {error}
      </div>
    );
  }
  if (!dashboard) return null;

  return (
    <>
      <Link
        href="/admin/finance/partners"
        className="text-sm text-deep-green/60 hover:text-deep-green"
      >
        ← Back to Partner Dashboards
      </Link>

      <div className="mt-3 mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl uppercase leading-none tracking-tight text-deep-green md:text-5xl">
            {dashboard.partner_name}
          </h1>
          <p className="mt-2 text-sm text-deep-green/65">
            {venue ? `${venue.city ? venue.city + " · " : ""}${venue.venue_name}` : "—"}{" "}
            · slug{" "}
            <span className="font-mono text-xs text-deep-green/50">
              {dashboard.slug}
            </span>{" "}
            ·{" "}
            {dashboard.enabled ? (
              <span className="font-semibold text-mint-hover">Enabled</span>
            ) : (
              <span className="font-semibold text-muted">Disabled</span>
            )}
          </p>
        </div>
      </div>

      <PaymentSettingsForm
        dashboard={dashboard}
        onSaved={load}
      />

      <div className="mt-10">
        <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
          Weekly Payments
        </h2>
        <p className="mt-1 text-sm text-deep-green/60">
          Most recent first. Past + current week only.
        </p>

        {!payment?.enabled ? (
          <div className="mt-4 rounded-xl border border-cream-line bg-cream-soft/40 px-4 py-5 text-sm italic text-deep-green/55">
            Payment tracking is off for this partner. Set a Start date above to enable.
          </div>
        ) : weeksDesc.length === 0 ? (
          <div className="mt-4 rounded-xl border border-cream-line bg-cream-soft/40 px-4 py-5 text-sm italic text-deep-green/55">
            First payment week begins{" "}
            {fmtDateYmd(payment.firstQualifyingSunday)}.
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-cream-line bg-white">
            <table className="w-full text-sm">
              <thead className="bg-cream-soft/60 text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/55">
                <tr>
                  <th className="px-4 py-2.5 text-left">Week of</th>
                  <th className="px-4 py-2.5 text-right">Qualifying revenue</th>
                  <th className="px-4 py-2.5 text-right">Payment owed</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-left">Paid on</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {weeksDesc.map((w, i) => {
                  const displayAmount =
                    w.status === "paid" && w.calculatedAmount != null
                      ? w.calculatedAmount
                      : w.owedAmount;
                  return (
                    <tr
                      key={w.weekStartDate}
                      className={i > 0 ? "border-t border-cream-line" : ""}
                    >
                      <td className="px-4 py-2.5 text-deep-green">
                        {fmtDateYmd(w.weekStartDate)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-deep-green/80">
                        ${w.qualifyingRevenue.toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono font-medium tabular-nums text-deep-green">
                        ${displayAmount.toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusPill status={w.status} />
                        {w.status === "disputed" && w.disputeNote && (
                          <p className="mt-1 max-w-[20rem] text-[11px] italic text-deep-green/55">
                            “{w.disputeNote}”
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-deep-green/65">
                        {fmtDateYmd(w.paidAt ? w.paidAt.slice(0, 10) : null)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {w.status === "pending" && (
                            <button
                              type="button"
                              onClick={() => setPaidTarget(w)}
                              className="rounded-md bg-mint px-2.5 py-1 text-[11px] font-bold text-deep-green transition hover:bg-mint-hover"
                            >
                              Mark Paid
                            </button>
                          )}
                          {w.status === "paid" && (
                            <button
                              type="button"
                              onClick={() => setPendingTarget(w)}
                              className="rounded-md border border-cream-line bg-white px-2.5 py-1 text-[11px] font-semibold text-deep-green/70 transition hover:bg-cream-soft hover:text-deep-green"
                            >
                              Mark Pending
                            </button>
                          )}
                          {w.status === "disputed" && (
                            <button
                              type="button"
                              onClick={() => setResolveTarget(w)}
                              className="rounded-md bg-mint px-2.5 py-1 text-[11px] font-bold text-deep-green transition hover:bg-mint-hover"
                            >
                              Resolve as Paid
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {paidTarget && (
        <MarkPaidModal
          partnerDashboardId={partnerDashboardId}
          week={paidTarget}
          onCancel={() => setPaidTarget(null)}
          onDone={() => {
            setPaidTarget(null);
            load();
          }}
        />
      )}
      {pendingTarget && (
        <MarkPendingModal
          week={pendingTarget}
          onCancel={() => setPendingTarget(null)}
          onDone={() => {
            setPendingTarget(null);
            load();
          }}
        />
      )}
      {resolveTarget && (
        <ResolveDisputeModal
          week={resolveTarget}
          onCancel={() => setResolveTarget(null)}
          onDone={() => {
            setResolveTarget(null);
            load();
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

function PaymentSettingsForm({
  dashboard,
  onSaved,
}: {
  dashboard: DashboardRow;
  onSaved: () => void | Promise<void>;
}) {
  const [pct, setPct] = useState(String(dashboard.revenue_share_pct ?? 50));
  const [startDate, setStartDate] = useState(dashboard.payment_start_date ?? "");
  const [dow, setDow] = useState(String(dashboard.payment_day_of_week ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function handleSave() {
    setError(null);
    const pctNum = Number(pct);
    if (Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100) {
      setError("Revenue share % must be between 0 and 100.");
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase
        .from("partner_dashboards")
        .update({
          revenue_share_pct: pctNum,
          payment_start_date: startDate || null,
          payment_day_of_week: Number(dow),
        })
        .eq("id", dashboard.id);
      if (error) {
        setError(error.message);
        return;
      }
      setSavedAt(Date.now());
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border-[1.5px] border-cream-line bg-white p-6 shadow-md shadow-deep-green/10">
      <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
        Payment Settings
      </h2>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
            Revenue share %
          </label>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={pct}
            onChange={(e) => setPct(e.target.value)}
            className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
          />
        </div>

        <div>
          <label
            className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65"
            title="First qualifying week is the first Sunday on or after this date. Weeks whose Sunday falls before this date are skipped."
          >
            Start date
            <span
              aria-hidden
              className="ml-1 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-deep-green/15 text-[8px] font-bold text-deep-green/65"
              title="First qualifying week is the first Sunday on or after this date. Weeks whose Sunday falls before this date are skipped."
            >
              i
            </span>
          </label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
          />
          <p className="mt-1 text-[11px] text-deep-green/50">
            Leave blank to disable payment tracking.
          </p>
        </div>

        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
            Paid on (display)
          </label>
          <select
            value={dow}
            onChange={(e) => setDow(e.target.value)}
            className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
          >
            {DOW_NAMES.map((name, idx) => (
              <option key={idx} value={idx}>
                {name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-deep-green/50">
            Label only — week buckets are always Sun→Sat.
          </p>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}

      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="rounded-md bg-mint px-3 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
        {savedAt && Date.now() - savedAt < 2500 && (
          <span className="text-xs text-mint-hover">Saved.</span>
        )}
      </div>
    </section>
  );
}

function MarkPaidModal({
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
  const today = new Date().toISOString().slice(0, 10);
  const [paidOn, setPaidOn] = useState(today);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    try {
      const paidAtIso = new Date(`${paidOn}T12:00:00Z`).toISOString();
      if (week.recordId) {
        const { error } = await supabase
          .from("partner_weekly_payments")
          .update({
            status: "paid",
            paid_at: paidAtIso,
            paid_notes: notes.trim() || null,
            calculated_amount: week.owedAmount,
          })
          .eq("id", week.recordId);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase
          .from("partner_weekly_payments")
          .insert({
            partner_dashboard_id: partnerDashboardId,
            week_start_date: week.weekStartDate,
            calculated_amount: week.owedAmount,
            status: "paid",
            paid_at: paidAtIso,
            paid_notes: notes.trim() || null,
          });
        if (error) throw new Error(error.message);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Mark week as paid" onCancel={onCancel}>
      <p className="text-sm text-deep-green/65">
        Week of {fmtDateYmd(week.weekStartDate)} · Owed{" "}
        <b className="text-deep-green">${week.owedAmount.toFixed(2)}</b>
      </p>
      <p className="mt-2 text-xs text-deep-green/55">
        The owed amount is snapshotted on the row at this moment, so later
        revenue changes don&apos;t alter what you paid.
      </p>
      <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
        Paid on
      </label>
      <input
        type="date"
        value={paidOn}
        onChange={(e) => setPaidOn(e.target.value)}
        className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
      />
      <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
        Notes (optional)
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder="e.g., 'Sent via Venmo @pacglobal'"
        className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
      />
      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}
      <ModalFooter>
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
          onClick={handleConfirm}
          disabled={busy}
          className="rounded-md bg-mint px-3 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-60"
        >
          {busy ? "Saving…" : "Confirm paid"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function MarkPendingModal({
  week,
  onCancel,
  onDone,
}: {
  week: PartnerWeeklyPayment;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!week.recordId) {
      onDone();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase
        .from("partner_weekly_payments")
        .update({
          status: "pending",
          paid_at: null,
          paid_notes: null,
        })
        .eq("id", week.recordId);
      if (error) throw new Error(error.message);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Revert to pending?" onCancel={onCancel}>
      <p className="text-sm text-deep-green/65">
        Week of {fmtDateYmd(week.weekStartDate)} will go back to{" "}
        <b className="text-deep-green">Pending</b>. Paid date and notes will
        clear. The owed amount recomputes live again.
      </p>
      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}
      <ModalFooter>
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
          onClick={handleConfirm}
          disabled={busy}
          className="rounded-md bg-coral px-3 py-2 text-sm font-bold text-white transition hover:bg-coral-hover disabled:opacity-60"
        >
          {busy ? "Saving…" : "Revert to pending"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function ResolveDisputeModal({
  week,
  onCancel,
  onDone,
}: {
  week: PartnerWeeklyPayment;
  onCancel: () => void;
  onDone: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [paidOn, setPaidOn] = useState(
    week.paidAt ? week.paidAt.slice(0, 10) : today,
  );
  const [notes, setNotes] = useState(week.paidNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!week.recordId) return;
    setBusy(true);
    setError(null);
    try {
      const paidAtIso = new Date(`${paidOn}T12:00:00Z`).toISOString();
      const { error } = await supabase
        .from("partner_weekly_payments")
        .update({
          status: "paid",
          paid_at: paidAtIso,
          paid_notes: notes.trim() || null,
        })
        .eq("id", week.recordId);
      if (error) throw new Error(error.message);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Resolve dispute as paid" onCancel={onCancel}>
      <p className="text-sm text-deep-green/65">
        Week of {fmtDateYmd(week.weekStartDate)} ·{" "}
        <b className="text-deep-green">${week.owedAmount.toFixed(2)}</b>
      </p>
      {week.disputeNote && (
        <p className="mt-2 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm italic text-coral">
          Partner note: “{week.disputeNote}”
        </p>
      )}
      <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
        Paid on
      </label>
      <input
        type="date"
        value={paidOn}
        onChange={(e) => setPaidOn(e.target.value)}
        className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
      />
      <label className="mt-4 block text-[11px] font-semibold uppercase tracking-[0.06em] text-deep-green/65">
        Notes (optional)
      </label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder="e.g., 'Re-sent via Venmo on 5/12 — confirmed receipt'"
        className="mt-1 w-full rounded-md border border-cream-line bg-white px-3 py-2 text-sm text-deep-green focus:border-mint focus:outline-none"
      />
      {error && (
        <div className="mt-3 rounded-md border border-coral/40 bg-coral-soft px-3 py-2 text-sm text-coral">
          {error}
        </div>
      )}
      <ModalFooter>
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
          onClick={handleConfirm}
          disabled={busy}
          className="rounded-md bg-mint px-3 py-2 text-sm font-bold text-deep-green transition hover:bg-mint-hover disabled:opacity-60"
        >
          {busy ? "Saving…" : "Resolve as paid"}
        </button>
      </ModalFooter>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-deep-green/30 px-4 py-12 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border-l-4 border-mint border-y-[1.5px] border-r-[1.5px] border-y-cream-line border-r-cream-line bg-white p-6 shadow-xl shadow-deep-green/30"
      >
        <h2 className="font-display text-2xl uppercase leading-none tracking-tight text-deep-green">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}

function ModalFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex justify-end gap-2">{children}</div>;
}
