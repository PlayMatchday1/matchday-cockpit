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

  /* ── ONE PARTNER AT A TIME WAS THE WHOLE COST ─────────────────────────────────────────────────
   * This loop awaited fetchPartnerRows and fetchPartnerWeeklyPayments INSIDE a `for`, so four
   * partners meant eight queries strictly one after another. Measured:
   *
   *     Hattrick          rows 1421ms (3043 regs) · payments  88ms
   *     PAC Global        rows  935ms ( 571 regs) · payments  88ms
   *     Parmer            rows  899ms ( 306 regs) · payments 136ms
   *     Crossbar Rowlett  rows  921ms ( 601 regs) · payments 127ms
   *     sequential total 4,615ms   ·   all four in parallel 1,443ms   (3.2×)
   *
   * The partners do not depend on each other, so the waiting is the only thing being serialised.
   * The whole request measured ~7,000 ms in a cold-open trace and fired TWICE per page load,
   * making it the largest single piece of server work in the trace — on pages that have nothing to
   * do with partner dashboards, because it feeds a nav badge.
   *
   * ORDER IS PRESERVED: results are collected positionally and filtered afterwards, so byPartner
   * comes out in the same order as before rather than in whatever order the queries returned. */
  const perPartner = await Promise.all((data ?? []).map(async (p) => {
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
    // The two reads for ONE partner do not depend on each other either.
    const [{ rows, extra }, records] = await Promise.all([
      fetchPartnerRows(supabase, p.venue_id),
      fetchPartnerWeeklyPayments(supabase, p.id),
    ]);
    const payment = computeWeeklyPayments(rows, extra, cfg, records);
    const c = actionableCounts(derivePeriodRows(payment, today));
    return { partner: p.partner_name as string, awaiting: c.awaiting, disputed: c.disputed, diverged: c.diverged, total: c.total };
  }));

  let awaiting = 0, disputed = 0, diverged = 0;
  for (const c of perPartner) { awaiting += c.awaiting; disputed += c.disputed; diverged += c.diverged; }
  const byPartner = perPartner.filter((c) => c.total > 0)
    .map(({ partner, awaiting: a, disputed: d, diverged: v }) => ({ partner, awaiting: a, disputed: d, diverged: v }));

  const total = awaiting + disputed + diverged;
  return Response.json({ count: total, awaiting, disputed, diverged, byPartner });
}
