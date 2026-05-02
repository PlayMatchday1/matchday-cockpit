import { notFound } from "next/navigation";
import {
  computePartnerStats,
  computeWeeklyPayments,
  fetchPartnerBySlug,
  fetchPartnerRows,
  fetchPartnerWeeklyPayments,
  makeAnonServerClient,
} from "@/lib/partnerStats";
import PartnerDashboard from "./PartnerDashboard";

// Server component. Slug → venue_id resolution happens server-side
// against an anon Supabase client. venue_id is never exposed as a URL
// param, never client-mutable.

export const dynamic = "force-dynamic";

export default async function PartnerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const supabase = makeAnonServerClient();

  const partner = await fetchPartnerBySlug(supabase, slug);
  if (!partner) notFound(); // 404 — generic, no leak about why

  const { rows, extra } = await fetchPartnerRows(supabase, partner.venueId);
  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);
  const stats = computePartnerStats(rows, extra);
  const payment = computeWeeklyPayments(
    rows,
    extra,
    {
      revenueSharePct: partner.revenueSharePct,
      paymentStartDate: partner.paymentStartDate,
      paymentDayOfWeek: partner.paymentDayOfWeek,
    },
    records,
  );

  return (
    <PartnerDashboard
      partnerDashboardId={partner.id}
      partnerName={partner.partnerName}
      stats={stats}
      payment={payment}
    />
  );
}
