// GET /api/partner-dashboards/actionable — ADMIN ONLY.
//
// The sidebar "Partner Dashboards" badge counts things that NEED ACTION, across
// every partner combined: periods awaiting payment, disputed periods, and paid
// periods whose figures diverged after payment. NOT how many partners exist (a
// badge that is always lit teaches the eye to ignore it). Derived from the SAME
// computeWeeklyPayments + derivePeriodRows the panel uses, so the badge and the
// panel can never disagree. Returns the breakdown too, so the count is auditable.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { computeWeeklyPayments, fetchPartnerRows, fetchPartnerWeeklyPayments, type PartnerConfig } from "@/lib/partnerStats";
import { actionableCounts, derivePeriodRows, todayYmd } from "@/lib/partnerDashboardView";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const supabase = auth.supabase;

  const { data, error } = await supabase
    .from("partner_dashboards")
    /* select("*"), NOT a column list — the same rule adminAuth follows for app_users. Code deploys
     * before a migration applies, and a NAMED column that does not exist yet 500s the whole route.
     * With "*", a pre-migration read simply returns the row without revenue_model_next and the
     * dated model reads as absent, which is the correct behaviour until 0150 lands. */
    .select("*");
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const today = todayYmd();
  let awaiting = 0, disputed = 0, diverged = 0;
  const byPartner: { partner: string; awaiting: number; disputed: number; diverged: number }[] = [];

  for (const p of data ?? []) {
    const cfg: PartnerConfig = {
      id: p.id, venueId: p.venue_id, partnerName: p.partner_name,
      revenueSharePct: (p.revenue_share_pct as number) ?? 50,
      paymentStartDate: (p.payment_start_date as string | null) ?? null,
      paymentDayOfWeek: (p.payment_day_of_week as number) ?? 0,
      paymentCadence: ((p.payment_cadence as string) ?? "weekly") as PartnerConfig["paymentCadence"],
      revenueModel: ((p.revenue_model as string) ?? "flat_percentage") as PartnerConfig["revenueModel"],
      managerPayBase: (p.manager_pay_base as number | null) ?? null,
      managerPayHigh: (p.manager_pay_high as number | null) ?? null,
      managerPayThreshold: (p.manager_pay_threshold as number | null) ?? null,
      // Phase 28: these two call sites drive the ADMIN list and the actionable counter, both of
      // which run the LEGACY payout path only. They carry the pre-0123 defaults so nothing here
      // can select the rental model by accident — the public dashboard is the one surface that
      // reads the real columns.
      payoutModel: ((p.revenue_model as string) === "per_match_minus_manager" ? "PER_MATCH_MINUS_MANAGER" : "REVENUE_SHARE") as PartnerConfig["payoutModel"],
      // Dated successor (0150), read as a pair — see rowToPartnerConfig for why a lone half is
      // treated as absent rather than half-applied.
      revenueModelNext: (p.revenue_model_next ?? null) && (p.revenue_model_from ?? null)
        ? ((p.revenue_model_next as string) as PartnerConfig["revenueModelNext"]) : null,
      revenueModelFrom: (p.revenue_model_next ?? null) && (p.revenue_model_from ?? null)
        ? String(p.revenue_model_from).slice(0, 10) : null,
      perMatchFeeCents: p.per_match_fee_cents == null ? null : Number(p.per_match_fee_cents),
      payoutSharePct: (p.revenue_share_pct as number) ?? 50,
      fieldRentalCents: null, matchManagerCents: null, partnerSharePct: null, spotPriceCents: null,
    };
    const { rows, extra } = await fetchPartnerRows(supabase, p.venue_id);
    const records = await fetchPartnerWeeklyPayments(supabase, p.id);
    const payment = computeWeeklyPayments(rows, extra, cfg, records);
    const c = actionableCounts(derivePeriodRows(payment, today));
    awaiting += c.awaiting; disputed += c.disputed; diverged += c.diverged;
    if (c.total > 0) byPartner.push({ partner: p.partner_name, awaiting: c.awaiting, disputed: c.disputed, diverged: c.diverged });
  }

  const total = awaiting + disputed + diverged;
  return Response.json({ count: total, awaiting, disputed, diverged, byPartner });
}
