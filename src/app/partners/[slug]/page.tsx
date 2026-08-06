import { notFound } from "next/navigation";
import {
  computePartnerStats,
  computeWeeklyPayments,
  fetchPartnerBySlug,
  fetchPartnerRows,
  fetchPartnerWeeklyPayments,
} from "@/lib/partnerStats";
import { makeServerClient } from "@/lib/supabaseServer";
import { derivePartnerGrains } from "@/lib/partnerGrain";
import { dfull, dshort, todayYmd } from "@/lib/partnerDashboardView";
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

  const { rows, extra, venueName } = await fetchPartnerRows(supabase, partner.venueId);
  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);

  // City + launch date for the header (fin_venues, service-role — aggregated
  // here, never sent raw). Both are display-only.
  const { data: venueRow } = await supabase
    .from("fin_venues")
    .select("city, launch_date")
    .eq("id", partner.venueId)
    .maybeSingle();

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
      revenueModel: partner.revenueModel,
      managerPayBase: partner.managerPayBase,
      managerPayHigh: partner.managerPayHigh,
      managerPayThreshold: partner.managerPayThreshold,
    },
    records,
  );

  // v1_4 grains + since-launch, derived server-side from the same baseline-filtered
  // rows the stats use (raw rows carry emails and never leave the server).
  const grains = derivePartnerGrains(statsRows, statsExtra, payment, new Date());
  const totalMatches = stats.weeks.reduce((s, w) => s + (w.voided ? 0 : w.matches), 0);
  const paid = payment.weeklyPayments
    .filter((w) => w.status === "paid")
    .reduce((s, w) => s + Math.round(w.calculatedAmount ?? w.owedAmount), 0);
  const city = (venueRow?.city as string | null) ?? null;
  const launch = (venueRow?.launch_date as string | null) ?? stats.earliestMatchDate;
  const today = todayYmd();
  const baseSub =
    `${partner.partnerName}${city ? ` · ${city}` : ""}${launch ? ` · ${dfull(launch)} through ${dfull(today)}` : ""}` +
    ` · MatchDay staff spots excluded · revenue is the match price players actually paid`;

  if (partner.paymentCadence === "monthly") {
    const since = { spots: stats.totals.spots, registered: stats.totals.md, guests: stats.totals.guests, cancels: stats.totals.cancels, people: stats.totals.uniquePlayers, matches: totalMatches };
    const last8 = stats.weeks
      .filter((w): w is Extract<typeof w, { voided: false }> => !w.voided && w.matches > 0)
      .slice(-8)
      .map((w) => {
        const sun = new Date(`${w.wkMonday}T00:00:00Z`); sun.setUTCDate(sun.getUTCDate() + 6);
        return { label: `${dshort(w.wkMonday)} – ${dshort(sun.toISOString().slice(0, 10))}`, spots: w.totalPlayers, matches: w.matches, revenue: w.totalRev };
      });
    const running = grains.monthRows.find((m) => m.isOpen);
    const footnote =
      `Everything here covers ${venueName} only${launch ? `, from ${dfull(launch)} — the first match MatchDay ran at this venue —` : ""} through ${dfull(today)}, and counts ${totalMatches} matches. ` +
      `Spots filled is every seat paid for and held; MatchDay does not record check-in, so it is not attendance. Daily players and Guests are shown; the remainder of Spots filled is made up of other seat types. ` +
      `A private rental is a booking with no MatchDay match behind it — no players and no spots — so it adds to qualifying revenue but not to the match or spot counts. Rentals are listed separately inside the revenue column so you can see what you are being paid for. ` +
      `The opening period is a single settled payment with no match-level detail behind it, so it adds to the payment total but not to the counts.` +
      (running ? ` ${running.label} is still running and is not paid until the month closes, so it adds to the counts but not to the payment total.` : "");
    return (
      <PartnerMonthlyView
        partnerName={partner.partnerName}
        sub={`${baseSub} · paid monthly at ${partner.revenueSharePct}% of qualifying revenue`}
        since={since}
        months={grains.monthRows}
        last8={last8}
        footnote={footnote}
      />
    );
  }

  return (
    <PartnerDashboardV14
      partnerName={partner.partnerName}
      venue={venueName}
      city={city}
      sub={baseSub}
      grains={grains}
      sinceLaunch={{ matches: totalMatches, spots: stats.totals.spots, people: stats.totals.uniquePlayers, paid }}
    />
  );
}
