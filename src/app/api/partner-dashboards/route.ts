// Admin data for the Match Ops → Partner Dashboards index. Returns EVERY
// partner (enabled + disabled) with its fully-computed stats + payment — the
// SAME computeWeeklyPayments the public route runs, so the index switcher's owed
// total is derived from the identical rows the dashboard table shows. There is
// no separate "pending count" query (the shipped index had one, and it said
// "Pending 0" while the page showed unpaid periods).
//
// Admin-gated on app_users.is_admin (authenticateAdmin → service-role client).
// Player emails are aggregated into stats/payment server-side; raw rows never
// leave. GET is read-only. POST marks a single payment period paid/unpaid by
// writing partner_weekly_payments — the ONLY write here, and it touches no
// mdapi_* table. The paid amount is snapshotted from a server-side recompute of
// the period (never trusted from the client) so a later data sync can't silently
// change what was recorded as paid.

import { randomUUID } from "node:crypto";
import { authenticateAdmin } from "@/lib/adminAuth";
import { recordWrite, supabaseLogStore } from "@/lib/changeLog";
import type { Change } from "@/lib/changeLogModel";
import { buildRentalDashboard } from "@/lib/partnerRentalDashboard";
import {
  computePartnerStats,
  computeWeeklyPayments,
  fetchPartnerRows,
  fetchPartnerWeeklyPayments,
  rentalParamsOf,
  type PartnerConfig,
} from "@/lib/partnerStats";

export const runtime = "nodejs";
export const maxDuration = 30;

// All partner_dashboards rows (incl. disabled) mapped to PartnerConfig. Mirrors
// fetchAllEnabledPartnerDashboards but without the enabled filter — admins must
// see disabled partners to re-enable them.
async function fetchAllPartners(supabase: import("@supabase/supabase-js").SupabaseClient): Promise<(PartnerConfig & { slug: string; enabled: boolean; createdAt: string })[]> {
  const { data, error } = await supabase
    .from("partner_dashboards")
    .select("id, slug, venue_id, partner_name, enabled, created_at, revenue_share_pct, payment_start_date, payment_day_of_week, payment_cadence, revenue_model, manager_pay_base, manager_pay_high, manager_pay_threshold")
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    slug: r.slug as string,
    venueId: r.venue_id as number,
    partnerName: r.partner_name as string,
    enabled: !!r.enabled,
    createdAt: r.created_at as string,
    revenueSharePct: (r.revenue_share_pct as number) ?? 50,
    paymentStartDate: (r.payment_start_date as string | null) ?? null,
    paymentDayOfWeek: (r.payment_day_of_week as number) ?? 0,
    paymentCadence: ((r.payment_cadence as string) ?? "weekly") as PartnerConfig["paymentCadence"],
    revenueModel: ((r.revenue_model as string) ?? "flat_percentage") as PartnerConfig["revenueModel"],
    managerPayBase: (r.manager_pay_base as number | null) ?? null,
    managerPayHigh: (r.manager_pay_high as number | null) ?? null,
    managerPayThreshold: (r.manager_pay_threshold as number | null) ?? null,
    // Phase 28: these two call sites drive the ADMIN list and the actionable counter, both of
    // which run the LEGACY payout path only. They carry the pre-0123 defaults so nothing here
    // can select the rental model by accident — the public dashboard is the one surface that
    // reads the real columns.
    payoutModel: ((r.revenue_model as string) === "per_match_minus_manager" ? "PER_MATCH_MINUS_MANAGER" : "REVENUE_SHARE") as PartnerConfig["payoutModel"],
    payoutSharePct: (r.revenue_share_pct as number) ?? 50,
    fieldRentalCents: null, matchManagerCents: null, partnerSharePct: null, spotPriceCents: null,
  }));
}

export async function GET(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const supabase = auth.supabase;

  const partners = await fetchAllPartners(supabase);

  // venue city + launch date for every venue in one pass
  const venueIds = [...new Set(partners.map((p) => p.venueId))];
  const { data: venues } = await supabase.from("fin_venues").select("id, city, launch_date").in("id", venueIds.length ? venueIds : [-1]);
  const venueMeta = new Map<number, { city: string | null; launch: string | null }>();
  for (const v of venues ?? []) venueMeta.set(v.id as number, { city: (v.city as string | null) ?? null, launch: (v.launch_date as string | null) ?? null });

  const out = [];
  for (const p of partners) {
    const { rows, extra, venueName } = await fetchPartnerRows(supabase, p.venueId);
    const records = await fetchPartnerWeeklyPayments(supabase, p.id);
    const stats = computePartnerStats(rows, extra);
    const payment = computeWeeklyPayments(
      rows,
      extra,
      {
        revenueSharePct: p.revenueSharePct,
        paymentStartDate: p.paymentStartDate,
        paymentDayOfWeek: p.paymentDayOfWeek,
        paymentCadence: p.paymentCadence,
        revenueModel: p.revenueModel,
        managerPayBase: p.managerPayBase,
        managerPayHigh: p.managerPayHigh,
        managerPayThreshold: p.managerPayThreshold,
      },
      records,
    );
    const meta = venueMeta.get(p.venueId);
    out.push({
      id: p.id,
      slug: p.slug,
      partnerName: p.partnerName,
      venue: venueName,
      city: meta?.city ?? null,
      launchDate: meta?.launch ?? null,
      cadence: p.paymentCadence,
      revenueModel: p.revenueModel,
      revenueSharePct: p.revenueSharePct,
      enabled: p.enabled,
      createdAt: p.createdAt,
      stats,
      payment,
    });
  }

  return Response.json({ partners: out });
}

// Mark ONE payment period paid (or undo it). Body:
//   { partnerId: string, weekStartDate: "YYYY-MM-DD", action: "paid" | "unpaid", paidAt?: "YYYY-MM-DD" }
// The amount is NOT taken from the client: we recompute the partner's periods
// server-side and snapshot the target period's owedAmount, so what gets recorded
// as paid is the authoritative figure at mark time. partner_weekly_payments has
// at most one row per (partner_dashboard_id, week_start_date); we select-then-
// update/insert rather than rely on an ON CONFLICT constraint.
export async function POST(req: Request) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const supabase = auth.supabase;

  const body = (await req.json().catch(() => null)) as
    | { partnerId?: unknown; weekStartDate?: unknown; action?: unknown; paidAt?: unknown }
    | null;
  const partnerId = typeof body?.partnerId === "string" ? body.partnerId : "";
  const weekStartDate = typeof body?.weekStartDate === "string" ? body.weekStartDate.slice(0, 10) : "";
  const action = body?.action === "paid" || body?.action === "unpaid" ? body.action : "";
  if (!partnerId || !/^\d{4}-\d{2}-\d{2}$/.test(weekStartDate) || !action) {
    return Response.json({ error: "partnerId, weekStartDate (YYYY-MM-DD) and action (paid|unpaid) are required" }, { status: 400 });
  }
  const paidAt = typeof body?.paidAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.paidAt)
    ? body.paidAt
    : new Date().toISOString().slice(0, 10);

  const partner = (await fetchAllPartners(supabase)).find((p) => p.id === partnerId);
  if (!partner) return Response.json({ error: "Partner not found" }, { status: 404 });

  // ── THE LEDGER ROW, WHICHEVER PAYOUT MODEL THE PARTNER IS ON ────────────────────────────────
  // Both branches end at the same table (partner_weekly_payments) and the same key
  // (week_start_date), so a rental partner is not a second ledger — only a second way of
  // computing the authoritative amount to snapshot. The amount is NEVER taken from the client.
  const { rows, extra } = await fetchPartnerRows(supabase, partner.venueId);
  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);

  const rentalParams = rentalParamsOf(partner);
  let owedAmount: number;
  let periodIsOpen: boolean;
  let periodLabel: string;

  if (rentalParams) {
    // RENTAL_PLUS_PROFIT_SHARE. Its periods are calendar months and its figure comes from the
    // rental builder — the same one the page renders, so what is recorded as paid is exactly what
    // the partner was shown.
    const dash = buildRentalDashboard(rows, rentalParams, {
      partnerName: partner.partnerName, venue: "", spotPriceCents: partner.spotPriceCents,
    });
    const ym = weekStartDate.slice(0, 7);
    const month = dash.months.find((m) => m.ym === ym);
    if (!month) return Response.json({ error: "No payment period for that date" }, { status: 400 });
    owedAmount = month.totals.partnerTotalCents / 100;
    periodIsOpen = month.open;
    periodLabel = month.label;
  } else {
    const payment = computeWeeklyPayments(
      rows,
      extra,
      {
        revenueSharePct: partner.revenueSharePct,
        paymentStartDate: partner.paymentStartDate,
        paymentDayOfWeek: partner.paymentDayOfWeek,
        paymentCadence: partner.paymentCadence,
        revenueModel: partner.revenueModel,
        managerPayBase: partner.managerPayBase,
        managerPayHigh: partner.managerPayHigh,
        managerPayThreshold: partner.managerPayThreshold,
      },
      records,
    );
    const period = payment.weeklyPayments.find((w) => w.weekStartDate === weekStartDate);
    if (!period) return Response.json({ error: "No payment period for that date" }, { status: 400 });
    if (period.isPreSystem) return Response.json({ error: "Historical settlements can't be changed here" }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    owedAmount = period.owedAmount;
    periodIsOpen = period.weekEndDate >= today && period.status !== "paid";
    periodLabel = weekStartDate;
  }

  const existing = records.find((r) => r.week_start_date === weekStartDate) ?? null;

  // Only a CLOSED period can be marked paid — an open one has no final figure yet.
  if (action === "paid" && periodIsOpen) {
    return Response.json({ error: "This period is still open — it can't be marked paid yet" }, { status: 400 });
  }

  // ── THE WRITE, THROUGH recordWrite ──────────────────────────────────────────────────────────
  // NO HOST GUARD HERE, deliberately, and this is the one place that rule does not apply: the
  // host guard exists for writes leaving for the MatchDay API. This write goes to our own
  // Supabase through the service-role client the admin gate already established; there is no
  // attacker-supplied host in the path to guard.
  //
  // ONE ATTEMPT. The closure below is called exactly once by recordWrite and nothing retries it —
  // a duplicate "marked paid" is a false statement about money having moved.
  //
  // UNDO IS A REVERSAL, NOT AN ERASURE. It sets the row back to pending rather than deleting it,
  // and it is logged as its own change_log entry with its own before/after. The fact that a
  // payment was once marked survives in change_log even though the ledger row no longer says so —
  // deleting the row would destroy both.
  const before = existing ? { status: existing.status as string, paidAt: (existing.paid_at as string | null) ?? null } : { status: "pending", paidAt: null };
  const after = action === "paid" ? { status: "paid", paidAt } : { status: "pending", paidAt: null };

  const readLedger = async (): Promise<Record<string, unknown>> => {
    const { data } = await supabase
      .from("partner_weekly_payments")
      .select("status, paid_at")
      .eq("partner_dashboard_id", partner.id)
      .eq("week_start_date", weekStartDate)
      .maybeSingle();
    return { status: (data?.status as string) ?? "pending", paidAt: (data?.paid_at as string | null) ?? null };
  };

  const changes: Change[] = [
    { key: "status", field: `${partner.partnerName} · ${periodLabel}`, before: before.status, after: after.status },
    { key: "paidAt", field: "Paid on", before: before.paidAt ?? "—", after: after.paidAt ?? "—" },
    { key: "amount", field: "Amount", before: "—", after: `$${owedAmount.toFixed(2)}` },
  ];

  const { error: writeErr, outcome } = await recordWrite(
    {
      env: "production", source: "Partner Dashboards · payments",
      actorName: auth.email, actorEmail: auth.email, saveId: randomUUID(),
      matchId: null, matchName: null,
      method: "POST", path: `/partner-dashboards/${partner.id}/payments/${weekStartDate}`,
      body: { action, weekStartDate, amount: owedAmount },
      keys: ["status", "paidAt"],
      label: (k) => (k === "status" ? "Payment status" : k === "paidAt" ? "Paid on" : k),
      // THE VERDICT COMES FROM A RE-READ, never from the absence of an error.
      applied: (_b, a) => a.status === after.status,
      changes,
    },
    {
      readResource: readLedger,
      write: async () => {
        if (action === "paid") {
          if (existing) {
            const { error } = await supabase.from("partner_weekly_payments")
              .update({ status: "paid", paid_at: paidAt, calculated_amount: owedAmount })
              .eq("id", existing.id);
            if (error) throw new Error(error.message);
          } else {
            const { error } = await supabase.from("partner_weekly_payments").insert({
              partner_dashboard_id: partner.id,
              week_start_date: weekStartDate,
              calculated_amount: owedAmount,
              status: "paid",
              paid_at: paidAt,
              is_pre_system_settlement: false,
            });
            if (error) throw new Error(error.message);
          }
        } else if (existing) {
          const { error } = await supabase.from("partner_weekly_payments")
            .update({ status: "pending", paid_at: null })
            .eq("id", existing.id);
          if (error) throw new Error(error.message);
        }
        return true;
      },
      now: () => new Date().toISOString(),
    },
    supabaseLogStore(),
  );

  // A 2xx IS NOT PROOF. The outcome is reported from the read-back, and the caller is told which.
  const OUT: Record<string, string> = { landed: "LANDED", failed: "FAILED", "not applied": "NOT APPLIED", unknown: "UNKNOWN" };
  const reported = OUT[outcome] ?? "UNKNOWN";
  if (writeErr) return Response.json({ ok: false, outcome: reported, error: writeErr.message }, { status: 502 });
  return Response.json({ ok: outcome === "landed", outcome: reported });
}
