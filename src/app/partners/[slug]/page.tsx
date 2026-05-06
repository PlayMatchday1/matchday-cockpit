import { notFound } from "next/navigation";
import {
  computePartnerStats,
  computeWeeklyPayments,
  fetchPartnerBySlug,
  fetchPartnerRows,
  fetchPartnerWeeklyPayments,
} from "@/lib/partnerStats";
import { makeServerClient } from "@/lib/supabaseServer";
import PartnerDashboard from "./PartnerDashboard";

// Server component. Slug → venue_id resolution and stats fetch run
// server-side against a service-role Supabase client. venue_id is
// never exposed as a URL param, never client-mutable.
//
// Why service-role and not anon: this URL is public (partners like
// Cesar at Hattrick open it without a Supabase session), but the
// post-Phase-5b data source — mdapi_matches + mdapi_match_players —
// only grants SELECT TO authenticated. Player emails sit in those
// tables, so we keep anon locked out of them. Server-rendered data
// is aggregated into PartnerStats / PartnerPaymentInfo before it
// hits the client; raw rows never leave the server.
//
// Service-role bypasses ALL RLS. The `enabled = true` gate that
// previously came from partner_dashboards' anon SELECT policy is
// now enforced explicitly inside fetchPartnerBySlug — keep it that
// way (load-bearing).

export const dynamic = "force-dynamic";

// Per-partner stats baseline (YYYY-MM-DD). When set, the dashboard's
// totals / by-month / week-by-week sections only count match + extra
// revenue rows whose date is on or after the baseline. The Monthly
// Payments section is intentionally NOT filtered — it serves as the
// payment audit trail and includes the pre-system settlement row.
//
// Why slug-keyed and not a column on partner_dashboards: this is data-
// quality scope, not a payment-flow concern. Adding a column would
// require migration + admin UI exposure for what is currently a one-
// off Hattrick fix. Promote to a column the next time a second partner
// needs the same treatment.
const PARTNER_DATA_BASELINE: Record<string, string> = {
  "hattrick-yx4sur4t": "2026-03-31",
};

export default async function PartnerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = makeServerClient();

  const partner = await fetchPartnerBySlug(supabase, slug);
  if (!partner) notFound(); // 404 — generic, no leak about why

  const { rows, extra } = await fetchPartnerRows(supabase, partner.venueId);
  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);

  const baseline = PARTNER_DATA_BASELINE[slug] ?? null;
  const statsRows = baseline
    ? rows.filter((r) => r.match_start.slice(0, 10) >= baseline)
    : rows;
  const statsExtra = baseline
    ? extra.filter((e) => e.date >= baseline)
    : extra;

  let stats = computePartnerStats(statsRows, statsExtra);

  // When the baseline lands mid-month, the by-month table would
  // include a partial-month row containing only baseline-day data
  // (e.g. a Mar 31 baseline produces a "March 2026" row with one
  // day's matches). Drop it so by-month starts at the first full
  // post-baseline month. Totals + week 1 still count those days.
  if (baseline && !baseline.endsWith("-01")) {
    const partialYm = baseline.slice(0, 7);
    stats = {
      ...stats,
      byMonth: stats.byMonth.filter((m) => m.ym !== partialYm),
    };
  }
  // computeWeeklyPayments stays on the unfiltered rows so the post-
  // baseline payment computation is identical and pre-system records
  // (which live in partner_weekly_payments) keep showing.
  const payment = computeWeeklyPayments(
    rows,
    extra,
    {
      revenueSharePct: partner.revenueSharePct,
      paymentStartDate: partner.paymentStartDate,
      paymentDayOfWeek: partner.paymentDayOfWeek,
      paymentCadence: partner.paymentCadence,
    },
    records,
  );

  return (
    <PartnerDashboard
      partnerDashboardId={partner.id}
      partnerName={partner.partnerName}
      stats={stats}
      payment={payment}
      dataBaseline={baseline}
    />
  );
}
