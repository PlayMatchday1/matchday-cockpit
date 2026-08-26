/* NOT server-only, DELIBERATELY — and it used to be.
 *
 * This module is PURE: it takes rows and parameters and returns numbers. Its only imports are
 * partnerPayoutModel, gamedayModel and mdapiFakePlayer, all of which are pure by design
 * (gamedayModel says so on its first line). There is no client, no key and no query in it.
 *
 * The marker was removed when Field Costs began computing partner payouts through the SAME
 * function the dashboard uses, rather than a second implementation of it. useFinanceData is a
 * client hook, so the chain lib/partnerStats -> here now reaches the browser bundle, and
 * `server-only` broke the production build on every finance page:
 *
 *   ./src/lib/fieldEconomics.ts [Client Component SSR]
 *     -> ./src/components/finance/CostSection.tsx
 *       -> at ./src/lib/partnerRentalDashboard.ts:1:1
 *
 * npm run verify does not build the client bundle, so it passed. verify:seam-artifact does, and
 * caught it — see .seam-artifact-result. READ THAT VERDICT AFTER PUSHING; it is the only check
 * that compiles what the browser actually receives.
 *
 * If anything server-side is ever added here, split it out rather than restoring this line. */

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
import { rosterRowCounts } from "./gamedayModel";
import {
  payoutForMatch, totalsOf, breakevenSpots, newVsReturning,
  monthCloseYmd, monthPayYmd, periodStatusOf,
  type RentalProfitShareParams, type MatchPayout, type PayoutTotals, type VenueAppearance,
  type PeriodStatus, type PeriodLedger,
} from "./partnerPayoutModel";

export type RentalMonth = {
  ym: string;             // YYYY-MM
  label: string;          // "August 2026"
  rows: MatchPayout[];    // played rows ONLY — the ones every total is built from
  scheduled: MatchPayout[]; // listed below the line, greyed, contributing nothing
  totals: PayoutTotals;
  spotsSold: number;
  newPlayers: number;
  returning: number;
  // DISTINCT PEOPLE and REPEAT VISITS. NEW PLAYERS and RETURNING read 130 and 0 against 175 spots
  // sold, which is two defensible numbers that look broken side by side — in a venue's first month
  // NEW duplicates PLAYERS exactly. So the tiles show PLAYERS (distinct) and RETURNING, which SUM
  // to PLAYERS, and the repeat visits explain the gap to the spot count without a second tile
  // repeating a number already on screen.
  distinctPlayers: number;
  repeatVisits: number;
  // THE PERIOD, stated rather than inferable.
  closesYmd: string;
  paysYmd: string;
  open: boolean;
  status: PeriodStatus;
  // THE LEDGER, when a partner_weekly_payments row exists for this period. `paidAt` is what the
  // chip shows beside "Paid"; `periodKey` is the row's key (the FIRST DAY of the month, which is
  // what monthly cadence stores in week_start_date) and is what a Mark paid write addresses.
  paidAt: string | null;
  periodKey: string;
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

// A row is a SPOT if it OCCUPIES ONE — decided by rosterRowCounts(), the single predicate for that
// question, not by a second definition living here.
//
// THE BUG THIS FIXES: the old predicate was `payment_type != null` plus fake/staff exclusions. That
// drops WAITING (payment_type is null for it) but NOT a sign-up the player later CANCELLED, and not
// a REFUNDED one. So cancelled spots were sold spots on a payout page. It surfaced as Aug 13
// rendering 45 on a 44-capacity match — but it was never one match: every match was carrying its
// cancellations, and Aug 13 is only the one that breached a ceiling loudly enough to be noticed.
//
// Clamping to capacity was explicitly rejected: capacity varies by match, and a clamp hides the
// bug instead of fixing it.
//
// REVENUE IS NOT RE-DERIVED FROM THIS. A cancelled spot that was never refunded still earned its
// money, so gross reads what was actually collected and is allowed to diverge from the spot count.
const STAFF = new Set(["STAFF", "MATCHDAY_STAFF"]);
const isPerson = (r: PartnerRegRow) =>
  !isFakePlayerEmail(r.email) && !(r.user_type != null && STAFF.has(r.user_type));

// TWO QUESTIONS, TWO PREDICATES. They are allowed to disagree, and forcing them to agree is what
// produced a wrong number in each direction.
//
// DOES THIS ROW OCCUPY A SPOT — rosterRowCounts(), the single predicate for that question, not a
// second definition living here. The old code asked only `payment_type != null`, which drops
// WAITING but NOT a sign-up the player later cancelled, so cancelled spots were sold spots on a
// payout page. It surfaced as Aug 13 rendering 45 on a 44-capacity match, but it was never one
// match: every match was carrying its cancellations. Clamping to capacity was rejected outright —
// capacity varies by match and a clamp hides the bug.
const occupiesSpot = (r: PartnerRegRow) =>
  r.payment_type != null && isPerson(r) && rosterRowCounts({
    canceledAt: r.player_canceled_at,
    refunded: r.refunded === true,
    paidStatus: r.paid_status ?? null,
  });

// DID THIS ROW EARN MONEY — what was actually collected, which is NOT the same set. A player who
// cancelled and was never refunded still paid; that money is real and the partner is owed their
// share of it. Only a REFUND takes it back. Revenue is read, never recomputed from the spot count.
const earnedRevenue = (r: PartnerRegRow) =>
  r.payment_type != null && isPerson(r) && r.refunded !== true;

export function buildRentalDashboard(
  rows: PartnerRegRow[],
  params: RentalProfitShareParams,
  opts: {
    partnerName: string; venue: string; spotPriceCents: number | null; nowMs?: number;
    // Keyed by YYYY-MM. Absent for a period with no ledger row yet, which is the normal state
    // before anyone has marked anything.
    ledger?: Map<string, PeriodLedger>;
  },
): RentalDashboardProps {
  // The clock enters HERE and nowhere else, and it is injectable so the suites can pin it.
  const nowMs = opts.nowMs ?? Date.now();
  // ONE RENTAL = ONE MATCH, so everything groups by match_api_id — never by night, never by date.
  // Three matches at the same field on the same evening are three rentals and three manager costs.
  type Acc = { startYmd: string; cancelled: boolean; grossCents: number; spotsSold: number; endUtc: string | null };
  const byMatch = new Map<string, Acc>();
  const appearances: VenueAppearance[] = [];

  for (const r of rows) {
    const key = r.match_api_id != null ? `id:${r.match_api_id}` : `ts:${r.match_start}`;
    const startYmd = r.match_start.slice(0, 10);
    const acc = byMatch.get(key) ?? { startYmd, cancelled: !!r.match_canceled, grossCents: 0, spotsSold: 0, endUtc: r.match_end_utc ?? null };
    // A cancelled match stays in the map so it can be reported as cancelled, but contributes
    // nothing — payoutForMatch zeroes it, and totalsOf does not count it as a match played.
    if (!r.match_canceled && (occupiesSpot(r) || earnedRevenue(r))) {
      // match_price_paid is DOLLARS in this row shape (the legacy reader's unit). Convert PER ROW,
      // so each real payment rounds to its own exact cent rather than accumulating float error and
      // rounding once at the end of a sum that was never exact.
      if (earnedRevenue(r)) acc.grossCents += Math.round((Number(r.match_price_paid ?? 0) || 0) * 100);
      if (occupiesSpot(r)) acc.spotsSold += 1;
      // NEW vs RETURNING is computed against ALL venue history — every appearance ever, not the
      // displayed window — so someone whose first Parmer match was in July is returning in August.
      // A person who cancelled did not attend, so they are not an appearance at the venue.
      if (r.user_id && occupiesSpot(r)) appearances.push({ userId: String(r.user_id), ymd: startYmd });
    }
    byMatch.set(key, acc);
  }

  const payouts: MatchPayout[] = [...byMatch.entries()]
    .map(([key, a]) => payoutForMatch(
      {
        matchApiId: Number(key.replace(/^id:/, "")) || 0, startYmd: a.startYmd, cancelled: a.cancelled,
        grossCents: a.grossCents, spotsSold: a.spotsSold,
        // PLAYED = the match's true END instant is in the past. end_date_utc is a genuine UTC
        // timestamp (unlike start_date/end_date, which wear a Z over local wall clock), so this is
        // an instant comparison and not a wall-clock one. A match with no end_date_utc is treated
        // as NOT played: on a payout page, refusing to bill for something unproven is the safe
        // direction, and it shows up as "scheduled" rather than silently earning money.
        played: a.endUtc != null && Date.parse(a.endUtc) < nowMs,
      },
      params,
    ))
    .sort((x, y) => x.startYmd.localeCompare(y.startYmd) || x.matchApiId - y.matchApiId);

  const byYm = new Map<string, MatchPayout[]>();
  for (const p of payouts) {
    // A CANCELLED match is dropped entirely — it did not happen and there is nothing to show.
    // A SCHEDULED one is KEPT, because the partner should see that Aug 19 exists and is not being
    // counted; hiding it would be a different lie from billing for it. It is already zeroed, so
    // totalsOf skips it and no sum can pick it up.
    if (p.cancelled) continue;
    const ym = p.startYmd.slice(0, 7);
    byYm.set(ym, [...(byYm.get(ym) ?? []), p]);
  }

  // TODAY, in YMD, from the injected clock. Used only for period open/closed — never for whether a
  // match was played, which comes from the match's own end instant.
  const todayYmd = new Date(nowMs).toISOString().slice(0, 10);

  const months: RentalMonth[] = [...byYm.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))   // newest first
    .map(([ym, all]) => {
      const start = `${ym}-01`;
      const end = `${ym}-31`;   // string comparison against YYYY-MM-DD; a 31 upper bound is safe
      const nv = newVsReturning(appearances, start, end);
      // SPLIT AT THE SOURCE. `rows` is what the totals are built from, so a scheduled match cannot
      // reach a sum by being forgotten in one place — it is not in the array at all.
      const rs = all.filter((r) => r.played);
      const scheduled = all.filter((r) => !r.played);
      const totals = totalsOf(rs);
      return {
        ym, label: monthLabel(ym), rows: rs, scheduled, totals,
        spotsSold: rs.reduce((s, r) => s + r.spotsSold, 0),
        newPlayers: nv.newPlayers, returning: nv.returning,
        distinctPlayers: nv.newPlayers + nv.returning,
        // Spots minus distinct people: the same person taking two spots in a month is one player
        // and two visits. Never negative.
        repeatVisits: Math.max(0, rs.reduce((s, r) => s + r.spotsSold, 0) - (nv.newPlayers + nv.returning)),
        closesYmd: monthCloseYmd(ym),
        paysYmd: monthPayYmd(ym),
        open: todayYmd <= monthCloseYmd(ym),
        status: periodStatusOf(ym, todayYmd, totals.partnerTotalCents, opts.ledger?.get(ym) ?? null),
        paidAt: opts.ledger?.get(ym)?.paidAt ?? null,
        periodKey: `${ym}-01`,
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
