import "server-only";

// The ONE derivation behind the partner dashboard. Both the public
// /partners/<slug> page AND the admin "view as the partner" preview call this, so
// the preview cannot show a different page from the real one. Returns fully
// aggregated render props (no raw rows / emails) — safe to serialise to the admin
// client over the preview API.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computePartnerStats, computeWeeklyPayments, fetchPartnerBySlug, fetchPartnerRows, fetchPartnerWeeklyPayments, rentalParamsOf } from "./partnerStats";
import { buildRentalDashboard, type RentalDashboardProps } from "./partnerRentalDashboard";
import { derivePartnerGrains } from "./partnerGrain";
import { dfull, dshort, todayYmd } from "./partnerDashboardView";
import type { PartnerV14Props } from "@/app/partners/[slug]/PartnerDashboardV14";
import type { PartnerMonthlyProps } from "@/app/partners/[slug]/PartnerMonthlyView";

// Per-partner data-quality baseline (see the public page's history for why).
export const PARTNER_DATA_BASELINE: Record<string, string> = {
  "hattrick-yx4sur4t": "2026-03-31",
};

export type PartnerDashboardData =
  | { kind: "weekly"; weekly: PartnerV14Props }
  | { kind: "monthly"; monthly: PartnerMonthlyProps }
  | { kind: "rental"; rental: RentalDashboardProps };

export async function buildPartnerDashboardData(
  supabase: SupabaseClient,
  slug: string,
  now: Date = new Date(),
): Promise<PartnerDashboardData | null> {
  const partner = await fetchPartnerBySlug(supabase, slug);
  if (!partner) return null;

  const { rows, extra, venueName } = await fetchPartnerRows(supabase, partner.venueId);

  // ── RENTAL_PLUS_PROFIT_SHARE branches out FIRST, before any of the flat-model derivation runs.
  // Not a flag threaded through computePartnerStats/periodOwed: this model shares no arithmetic
  // with them, and running their pipeline just to discard it is how a "special case" quietly
  // acquires the other model's rounding. The three existing partners never reach this branch.
  const rentalParams = rentalParamsOf(partner);
  if (rentalParams) {
    return {
      kind: "rental",
      rental: buildRentalDashboard(rows, rentalParams, {
        partnerName: partner.partnerName, venue: venueName, spotPriceCents: partner.spotPriceCents,
      }),
    };
  }

  const records = await fetchPartnerWeeklyPayments(supabase, partner.id);
  const { data: venueRow } = await supabase.from("fin_venues").select("city, launch_date").eq("id", partner.venueId).maybeSingle();

  const baseline = PARTNER_DATA_BASELINE[slug] ?? null;
  const statsRows = baseline ? rows.filter((r) => r.match_start.slice(0, 10) >= baseline) : rows;
  const statsExtra = baseline ? extra.filter((e) => e.date >= baseline) : extra;

  let stats = computePartnerStats(statsRows, statsExtra);
  if (baseline && !baseline.endsWith("-01")) {
    const partialYm = baseline.slice(0, 7);
    stats = { ...stats, byMonth: stats.byMonth.filter((m) => m.ym !== partialYm) };
  }
  // Payment stays on the UNFILTERED rows (pre-system records + identical math).
  const payment = computeWeeklyPayments(rows, extra, {
    revenueSharePct: partner.revenueSharePct,
    paymentStartDate: partner.paymentStartDate,
    paymentDayOfWeek: partner.paymentDayOfWeek,
    paymentCadence: partner.paymentCadence,
    revenueModel: partner.revenueModel,
    managerPayBase: partner.managerPayBase,
    managerPayHigh: partner.managerPayHigh,
    managerPayThreshold: partner.managerPayThreshold,
  }, records);

  const grains = derivePartnerGrains(statsRows, statsExtra, payment, now);
  const totalMatches = stats.weeks.reduce((s, w) => s + (w.voided ? 0 : w.matches), 0);
  const paid = payment.weeklyPayments.filter((w) => w.status === "paid").reduce((s, w) => s + Math.round(w.calculatedAmount ?? w.owedAmount), 0);
  const city = (venueRow?.city as string | null) ?? null;
  const launch = (venueRow?.launch_date as string | null) ?? stats.earliestMatchDate;
  const today = todayYmd(now);
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
    return { kind: "monthly", monthly: { partnerName: partner.partnerName, sub: `${baseSub} · paid monthly at ${partner.revenueSharePct}% of qualifying revenue`, since, months: grains.monthRows, last8, footnote } };
  }

  return {
    kind: "weekly",
    weekly: { partnerName: partner.partnerName, venue: venueName, city, sub: baseSub, grains, sinceLaunch: { matches: totalMatches, spots: stats.totals.spots, people: stats.totals.uniquePlayers, paid } },
  };
}
