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

import { authenticateAdmin } from "@/lib/adminAuth";
import {
  computePartnerStats,
  computeWeeklyPayments,
  fetchPartnerRows,
  fetchPartnerWeeklyPayments,
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

  // Recompute this partner's periods to get the authoritative row for the target
  // week (owedAmount snapshot + open-period guard).
  const { rows, extra } = await fetchPartnerRows(supabase, partner.venueId);
  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);
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

  const existing = records.find((r) => r.week_start_date === weekStartDate) ?? null;

  if (action === "paid") {
    // Guard: only a CLOSED period can be paid (an open, in-progress period has no
    // final figure yet). Matches the client, but enforced here regardless.
    const today = new Date().toISOString().slice(0, 10);
    const isOpen = period.weekEndDate >= today && period.status !== "paid";
    if (isOpen) return Response.json({ error: "This period is still open — it can't be marked paid yet" }, { status: 400 });

    if (existing) {
      const { error } = await supabase
        .from("partner_weekly_payments")
        .update({ status: "paid", paid_at: paidAt, calculated_amount: period.owedAmount })
        .eq("id", existing.id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
    } else {
      const { error } = await supabase.from("partner_weekly_payments").insert({
        partner_dashboard_id: partner.id,
        week_start_date: weekStartDate,
        calculated_amount: period.owedAmount,
        status: "paid",
        paid_at: paidAt,
        is_pre_system_settlement: false,
      });
      if (error) return Response.json({ error: error.message }, { status: 500 });
    }
  } else {
    // Undo: revert to pending. Nothing to do if no row exists (already pending).
    if (existing) {
      const { error } = await supabase
        .from("partner_weekly_payments")
        .update({ status: "pending", paid_at: null })
        .eq("id", existing.id);
      if (error) return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ ok: true });
}
