// Admin data for the Match Ops → Partner Dashboards index. Returns EVERY
// partner (enabled + disabled) with its fully-computed stats + payment — the
// SAME computeWeeklyPayments the public route runs, so the index switcher's owed
// total is derived from the identical rows the dashboard table shows. There is
// no separate "pending count" query (the shipped index had one, and it said
// "Pending 0" while the page showed unpaid periods).
//
// Admin-gated on app_users.is_admin (authenticateAdmin → service-role client).
// Player emails are aggregated into stats/payment server-side; raw rows never
// leave. Read-only: this route performs no writes and touches no mdapi_* table.

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
