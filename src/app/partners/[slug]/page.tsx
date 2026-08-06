import { notFound } from "next/navigation";
import { makeServerClient } from "@/lib/supabaseServer";
import { buildPartnerDashboardData } from "@/lib/partnerDashboardData";
import PartnerDashboardV14 from "./PartnerDashboardV14";
import PartnerMonthlyView from "./PartnerMonthlyView";

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

// Phase 3 Step 2a: 60s ISR replaces force-dynamic so a partner who
// refreshes the page mid-conversation hits Vercel's edge cache
// instead of triggering a full re-render. Vercel translates
// `revalidate = 60` to Cache-Control: s-maxage=60, stale-while-
// revalidate that lets stale-but-fresh-enough responses serve
// while a background re-render runs. Auth/permission gate inside
// fetchPartnerBySlug still runs at render time — at most a 60s
// drift if a partner_dashboard's enabled flag flips from true →
// false (deemed acceptable by the operator; partners aren't
// disabled at second-by-second cadence).
export const revalidate = 60;

// The whole derivation (baseline, stats, payment, grains, props) lives in
// buildPartnerDashboardData so the admin "view as partner" preview renders the
// identical component from the identical data path — page and preview can't drift.

export default async function PartnerPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await buildPartnerDashboardData(makeServerClient(), slug);
  if (!data) notFound(); // 404 — generic, no leak about why

  return data.kind === "monthly"
    ? <PartnerMonthlyView {...data.monthly} />
    : <PartnerDashboardV14 {...data.weekly} />;
}
