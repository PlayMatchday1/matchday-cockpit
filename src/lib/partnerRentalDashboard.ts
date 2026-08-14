import "server-only";

// Builds the RENTAL_PLUS_PROFIT_SHARE dashboard from the SAME rows every other partner dashboard
// reads (fetchPartnerRows → fetchLegacyMatchRegistrations). Nothing here re-queries and nothing
// re-derives who is on a roster: the WAITING rows and cancelled sign-ups are already dropped
// upstream by mdapiMatchesRead, which is the part of "reuse the existing computation" that holds.
//
// WHAT IS DELIBERATELY NOT REUSED, and why: periodOwed() sums payment_type === "DAILY PAID" only,
// which drops PROMOCODE rows entirely instead of counting them at the price actually paid. The
// brief defines gross as "every spot at what was actually paid: $15 spots at $15, promo-discounted
// spots at their discounted price, free member spots at $0" — those are different definitions. On
// Parmer's first six matches the gap is $45.00 across 24 promo rows. Since the reconciliation line
// is what makes this split credible to a partner, an unexplained $45 in it is not acceptable, so
// gross here follows the brief's definition. The three existing partners are untouched: they never
// enter this file.

import type { PartnerRegRow } from "./partnerStats";
import { isFakePlayerEmail } from "./mdapiFakePlayer";
import {
  payoutForMatch, totalsOf, breakevenSpots, newVsReturning,
  type RentalProfitShareParams, type MatchPayout, type PayoutTotals, type VenueAppearance,
} from "./partnerPayoutModel";

export type RentalMonth = {
  ym: string;             // YYYY-MM
  label: string;          // "August 2026"
  rows: MatchPayout[];
  totals: PayoutTotals;
  spotsSold: number;
  newPlayers: number;
  returning: number;
};

export type RentalDashboardProps = {
  partnerName: string;
  venue: string;
  params: RentalProfitShareParams;
  spotPriceCents: number | null;
  breakevenSpots: number | null;
  months: RentalMonth[];
  grand: PayoutTotals;
  // A dashboard that cannot prove its own arithmetic says so instead of showing numbers.
  reconciles: boolean;
};

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

// A row is a SPOT if it became one. payment_type is null for WAITING/unknown (never a spot);
// fake players and MatchDay staff are excluded, as they are everywhere else.
const STAFF = new Set(["STAFF", "MATCHDAY_STAFF"]);
const isSpot = (r: PartnerRegRow) =>
  r.payment_type != null && !isFakePlayerEmail(r.email) && !(r.user_type != null && STAFF.has(r.user_type));

export function buildRentalDashboard(
  rows: PartnerRegRow[],
  params: RentalProfitShareParams,
  opts: { partnerName: string; venue: string; spotPriceCents: number | null },
): RentalDashboardProps {
  // ONE RENTAL = ONE MATCH, so everything groups by match_api_id — never by night, never by date.
  // Three matches at the same field on the same evening are three rentals and three manager costs.
  type Acc = { startYmd: string; cancelled: boolean; grossCents: number; spotsSold: number };
  const byMatch = new Map<string, Acc>();
  const appearances: VenueAppearance[] = [];

  for (const r of rows) {
    const key = r.match_api_id != null ? `id:${r.match_api_id}` : `ts:${r.match_start}`;
    const startYmd = r.match_start.slice(0, 10);
    const acc = byMatch.get(key) ?? { startYmd, cancelled: !!r.match_canceled, grossCents: 0, spotsSold: 0 };
    // A cancelled match stays in the map so it can be reported as cancelled, but contributes
    // nothing — payoutForMatch zeroes it, and totalsOf does not count it as a match played.
    if (!r.match_canceled && isSpot(r)) {
      // match_price_paid is DOLLARS in this row shape (the legacy reader's unit). Convert PER ROW,
      // so each real payment rounds to its own exact cent rather than accumulating float error and
      // rounding once at the end of a sum that was never exact.
      acc.grossCents += Math.round((Number(r.match_price_paid ?? 0) || 0) * 100);
      acc.spotsSold += 1;
      // NEW vs RETURNING is computed against ALL venue history — every appearance ever, not the
      // displayed window — so someone whose first Parmer match was in July is returning in August.
      if (r.user_id) appearances.push({ userId: String(r.user_id), ymd: startYmd });
    }
    byMatch.set(key, acc);
  }

  const payouts: MatchPayout[] = [...byMatch.entries()]
    .map(([key, a]) => payoutForMatch(
      { matchApiId: Number(key.replace(/^id:/, "")) || 0, startYmd: a.startYmd, cancelled: a.cancelled, grossCents: a.grossCents, spotsSold: a.spotsSold },
      params,
    ))
    .sort((x, y) => x.startYmd.localeCompare(y.startYmd) || x.matchApiId - y.matchApiId);

  const byYm = new Map<string, MatchPayout[]>();
  for (const p of payouts) {
    // A cancelled match has been zeroed; it must not create an otherwise-empty month either.
    if (p.grossCents === 0 && p.spotsSold === 0 && p.fieldRentalCents === 0) continue;
    const ym = p.startYmd.slice(0, 7);
    byYm.set(ym, [...(byYm.get(ym) ?? []), p]);
  }

  const months: RentalMonth[] = [...byYm.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))   // newest first
    .map(([ym, rs]) => {
      const start = `${ym}-01`;
      const end = `${ym}-31`;   // string comparison against YYYY-MM-DD; a 31 upper bound is safe
      const nv = newVsReturning(appearances, start, end);
      return {
        ym, label: monthLabel(ym), rows: rs, totals: totalsOf(rs),
        spotsSold: rs.reduce((s, r) => s + r.spotsSold, 0),
        newPlayers: nv.newPlayers, returning: nv.returning,
      };
    });

  const grand = totalsOf(payouts);
  return {
    partnerName: opts.partnerName,
    venue: opts.venue,
    params,
    spotPriceCents: opts.spotPriceCents,
    breakevenSpots: opts.spotPriceCents != null ? breakevenSpots(opts.spotPriceCents, params) : null,
    months,
    grand,
    reconciles: grand.reconciles && months.every((m) => m.totals.reconciles) && payouts.every((p) => p.reconciles),
  };
}
