// Partner PAYOUT MODELS — the payout formula is a property of the partner record, not a branch
// buried in the computation. Pure and in integer CENTS, because this file decides what real
// venues are paid.
//
// ── WHAT WAS ALREADY TRUE WHEN THIS WAS WRITTEN (and contradicts the brief) ──────────────────────
// The brief said "the three existing partners are paid 50% of qualifying revenue". Two are:
// PAC Global and Hattrick, both flat_percentage at 50. The THIRD, Crossbar Rowlett, has been on
// `per_match_minus_manager` since migration 0057 — max(0, Σ match revenue − Σ manager pay), with
// manager pay keyed on match CAPACITY. Folding it into REVENUE_SHARE would have changed its
// numbers, and "their numbers must not change by a cent" is the binding instruction. So there are
// THREE models here, not two, and the existing pair are preserved by delegating to the untouched
// periodOwed() rather than by reimplementing them.
//
// ── THE NEW MODEL ───────────────────────────────────────────────────────────────────────────────
// RENTAL_PLUS_PROFIT_SHARE. ONE RENTAL = ONE MATCH: three matches in a night is three field rentals
// and three manager costs. Under this kind a cancelled match is excluded entirely.
//
// A CANCELLED MATCH CAN STILL OWE THE RENTAL — the claim that used to sit on this line, that "a
// cancelled match costs nothing and owes nothing", was never true of the signed terms. A booking
// cancelled on short notice may be charged the rental fee; a weather cancellation the venue calls
// never is. RENTAL_FLOOR_PROFIT_SHARE implements that: see rentalOwedOnCancellation. The rule is
// not applied on this kind, whose behaviour is unchanged.
//
//   pool               = gross − fieldRental − matchManager
//   partnerProfitShare = max(0, pool) × partnerSharePct/100
//   partnerTotal       = fieldRental + partnerProfitShare
//   matchdayRetained   = gross − fieldRental − matchManager − partnerProfitShare
//
// matchdayRetained is written as that subtraction and NOT as (1 − share) × pool on purpose. When
// the pool is positive the two are identical. When it is negative, partnerProfitShare is 0 and
// matchdayRetained equals the pool — MatchDay eats the shortfall — and the reconciliation still
// balances. Expressed as 0.6 × pool it would not.
//
//   RECONCILIATION: partnerTotal + matchdayRetained + matchManager === gross
// Exact, in cents, no tolerance, asserted on every match and every aggregate. A row that fails it
// renders an error instead of a number: a payout page that quietly disagrees with itself is worse
// than one that admits it.

export type PayoutModel =
  | "REVENUE_SHARE"
  | "PER_MATCH_MINUS_MANAGER"
  | "RENTAL_PLUS_PROFIT_SHARE"
  | "RENTAL_FLOOR_PROFIT_SHARE";

/* ── THE FOURTH MODEL, BESIDE THE THIRD AND NOT INSTEAD OF IT ─────────────────────────────────
 * RENTAL_FLOOR_PROFIT_SHARE. The rental is a FLOOR UNDER THE SPLIT, not a deduction from the pool.
 * The name is the difference.
 *
 *   pool         = gross − matchManager            the rental is NOT deducted
 *   split        = max(0, pool) × sharePct/100
 *   amountToPay  = max(0, split − fieldRental)     the rental is already paid
 *   partnerTotal = fieldRental + amountToPay       i.e. max(fieldRental, split)
 *
 * WHY THE OLD ONE OVERPAYS, as algebra rather than as an opinion. With F rental, M manager,
 * s share:
 *
 *   old(R) = F + s·max(0, R − F − M)
 *   new(R) = max(F, s·(R − M))
 *
 * Above the floor, old − new = F − s·F = (1 − s)·F = 0.6 × $160 = $96 — CONSTANT, whatever the
 * revenue, the spots or the turnout. The old model removed the rental from the pool and then
 * handed it back whole, so the partner collected 60% of a rental the split never charged for.
 *
 * BOTH MODELS STAY LIVE. RENTAL_PLUS_PROFIT_SHARE is byte-identical below and is the way back: one
 * UPDATE to partner_dashboards.payout_model switches a partner between them, with no deploy. That
 * is why this is a fourth kind and not a flag — a flag would make one model with two behaviours,
 * turn the old model's tests into branch tests, and put a second source of truth beside the column
 * the header of this file says owns the formula.
 *
 * THE FLOOR MAKES MATCHDAY ABSORB MORE OFTEN, which is why matchdayRetained stays written as a
 * subtraction rather than (1 − s)·pool: under $440 of revenue the partner still takes the whole
 * rental and MatchDay eats the difference, and only the subtraction keeps the reconciliation exact.
 */

/** True for both rental kinds. THE ONE PLACE that knows which models are "the rental dashboard" —
 *  every branch routes through this rather than testing a literal, so adding the fourth kind could
 *  not leave a site behind that silently falls through to a flat model. */
export const isRentalModel = (kind: PayoutModel | null | undefined): boolean =>
  kind === "RENTAL_PLUS_PROFIT_SHARE" || kind === "RENTAL_FLOOR_PROFIT_SHARE";

/** The revenue at which a top-up first appears: s·(R − M) ≥ F. Derived from the partner's own
 *  parameters, never the literal $440 — the next venue has different numbers. Null when the share
 *  is zero, where no revenue ever clears the floor. */
export function topUpThresholdCents(p: RentalProfitShareParams): number | null {
  if (!(p.partnerSharePct > 0)) return null;
  return Math.ceil((p.fieldRentalCents * 100) / p.partnerSharePct) + p.matchManagerCents;
}

// Every parameter lives here, on the partner row. Nothing in this file or the UI may hardcode a
// venue name, a rental figure or a share percentage — the next venue has different numbers, and a
// constant in a component is how the second one gets the first one's terms.
export type RentalProfitShareParams = {
  fieldRentalCents: number;
  matchManagerCents: number;
  partnerSharePct: number;
  /* ── A CANCELLED DATE CAN STILL OWE THE RENTAL ────────────────────────────────────────────────
   * The signed terms: a reservation cancelled with less than twelve hours' notice "MAY be
   * considered a completed reservation … and/or MAY be subject to the applicable rental fee".
   * MAY, not shall — so whether MatchDay charges itself is a decision, and it lives on the partner
   * row beside the other parameters rather than as a constant in here. Both default to the
   * behaviour that shipped: no fee, nothing owed.
   *
   * A weather cancellation initiated by the venue never incurs the fee, and nothing we hold can
   * tell us who cancelled or why — see MatchInput.rentalChargeOverride. */
  cancellationFeeEnabled?: boolean;
  /** Hours of notice below which the rental is owed. Only consulted when the notice is KNOWN. */
  cancellationNoticeHours?: number;
};

export type MatchInput = {
  matchApiId: number;
  startYmd: string;        // YYYY-MM-DD, the match's local wall-clock date
  cancelled: boolean;
  // HAS IT BEEN PLAYED. An open month is not a bill: a match that has not happened has not rented
  // a field and has not lost money, so it contributes NOTHING to any total. It is still listed —
  // scheduled, greyed, not counted — because hiding it would be a different lie.
  //
  // Decided upstream from the match's TRUE end instant (mdapi_matches.end_date_utc), never from
  // start_date/end_date, which are LOCAL WALL CLOCK wearing a Z and land hours off through
  // new Date(). Passed in as a boolean so this pure model never reads a clock.
  played: boolean;
  grossCents: number;      // every spot at what was ACTUALLY paid — see grossCentsFromRows
  spotsSold: number;       // seats held, staff excluded
  /* ── HOW MUCH NOTICE A CANCELLATION GAVE, OR null FOR "WE DO NOT KNOW" ────────────────────────
   * MEASURED, NOT ASSUMED: today it is always null, because nothing we hold records when a match
   * was cancelled. mdapi_matches carries is_cancelled, auto_canceled, auto_canceled_minutes,
   * updated_at and deleted_at — and no cancellation timestamp. `updated_at` is the source row's
   * last-modified time and moves for any reason: on the Sep 5 Parmer match it reads 22:50, which
   * is 2h50m AFTER the 20:00 kickoff, because the roster was still being edited then. Deriving
   * notice from it would produce a negative number and call it twelve hours.
   *
   * The field exists because the rule is the contract's, not the data's: the day a cancellation
   * timestamp arrives, the threshold below starts deciding on its own. Until then the operator
   * decides, per match, and the override is what records it. */
  cancelledNoticeHours?: number | null;
  /* THE OPERATOR'S DECISION ON THIS CANCELLATION, stored and auditable, never inferred.
   *   true  — short notice, the rental is owed
   *   false — waived: a venue-initiated weather cancellation, which never incurs the fee
   *   null  — nobody has said, so nothing is owed. Never bill a partner on a guess. */
  rentalChargeOverride?: boolean | null;
};

export type MatchPayout = {
  matchApiId: number;
  startYmd: string;
  grossCents: number;
  spotsSold: number;
  fieldRentalCents: number;
  matchManagerCents: number;
  poolCents: number;
  partnerProfitShareCents: number;
  matchdayProfitShareCents: number;
  partnerTotalCents: number;
  matchdayRetainedCents: number;
  reconciles: boolean;     // partnerTotal + matchdayRetained + matchManager === gross, exactly
  // Carried through so the view can list a scheduled match without it reaching any sum, and so
  // "did not happen" (cancelled) stays distinguishable from "has not happened yet" (scheduled).
  // Both are zeroed; only one of them is worth showing the partner.
  played: boolean;
  cancelled: boolean;
};

// ROUND ONCE, AT THE END, IN CENTS. The only non-integer step in the whole model is the share
// percentage, so it is the only place a rounding decision exists — and it is made here, once,
// after the pool is final. No intermediate is ever rounded.
export function payoutForMatch(m: MatchInput, p: RentalProfitShareParams): MatchPayout {
  // A CANCELLED MATCH CONTRIBUTES NOTHING. Not a zero-revenue match that still owes rent — no
  // rental, no manager cost, no share. It did not happen.
  // A CANCELLED MATCH, or ONE THAT HAS NOT BEEN PLAYED YET, contributes nothing. Same zeroed
  // shape, different reason: cancelled did not happen and never will; scheduled has not happened
  // yet. Both are wrong to bill for, and `played` keeps the second one listable.
  if (m.cancelled || !m.played) {
    return {
      matchApiId: m.matchApiId, startYmd: m.startYmd, grossCents: 0, spotsSold: 0,
      fieldRentalCents: 0, matchManagerCents: 0, poolCents: 0,
      partnerProfitShareCents: 0, matchdayProfitShareCents: 0,
      partnerTotalCents: 0, matchdayRetainedCents: 0, reconciles: true,
      played: m.played, cancelled: m.cancelled,
    };
  }
  const fieldRentalCents = p.fieldRentalCents;
  const matchManagerCents = p.matchManagerCents;
  const poolCents = m.grossCents - fieldRentalCents - matchManagerCents;
  // The single rounding point. Math.round on a non-negative product; the pool is an integer and
  // the percentage an integer, so this is exact for whole percentages and half-up otherwise.
  const partnerProfitShareCents = poolCents > 0 ? Math.round((poolCents * p.partnerSharePct) / 100) : 0;
  const partnerTotalCents = fieldRentalCents + partnerProfitShareCents;
  const matchdayRetainedCents = m.grossCents - fieldRentalCents - matchManagerCents - partnerProfitShareCents;
  return {
    matchApiId: m.matchApiId, startYmd: m.startYmd, grossCents: m.grossCents, spotsSold: m.spotsSold,
    fieldRentalCents, matchManagerCents, poolCents,
    partnerProfitShareCents,
    // What MatchDay keeps OF THE POOL — the mirror of the partner's share. Distinct from
    // matchdayRetained, which is after the manager cost has already been paid out.
    matchdayProfitShareCents: poolCents > 0 ? poolCents - partnerProfitShareCents : poolCents,
    partnerTotalCents, matchdayRetainedCents,
    reconciles: partnerTotalCents + matchdayRetainedCents + matchManagerCents === m.grossCents,
    played: true, cancelled: false,
  };
}

/* THE FOURTH MODEL'S PER-MATCH FIGURE. Same shape, same reconciliation, same single rounding
 * point — and payoutForMatch above is untouched.
 *
 * `partnerProfitShareCents` carries the AMOUNT TO PAY (the top-up), not the whole split, because
 * every consumer of this shape adds it to fieldRentalCents to get the total. Naming it the split
 * would double-count the rental on every screen that already knows how to add these two up. The
 * split itself is derivable as fieldRental + amountToPay and is printed by the view from
 * poolCents × share, which is what the partner should audit.
 *
 * THE FLOOR IS max(0, …) ON THE TOP-UP, so a weak match pays exactly the rental and reports $0 to
 * be paid — never a negative, which would claw back a rental the partner is owed whatever the
 * turnout. */
/* IS THE RENTAL OWED ON A CANCELLED DATE? Contract first, data second, and a guess never.
 *   - the partner must be on the fee at all (a setting, because the contract says MAY);
 *   - an operator waiver wins outright — that is the weather case, which nothing we hold can
 *     derive because we record neither who cancelled nor why;
 *   - an operator charge wins next — that is today's only path, because the notice is unknown;
 *   - a KNOWN notice under the threshold charges automatically, which is what the setting is for
 *     the day a cancellation timestamp exists;
 *   - otherwise nothing is owed. The default is not to bill. */
export function rentalOwedOnCancellation(m: MatchInput, p: RentalProfitShareParams): boolean {
  if (!p.cancellationFeeEnabled) return false;
  if (m.rentalChargeOverride === false) return false;
  if (m.rentalChargeOverride === true) return true;
  const notice = m.cancelledNoticeHours;
  if (notice == null) return false;
  return notice < (p.cancellationNoticeHours ?? 12);
}

export function payoutForMatchFloor(m: MatchInput, p: RentalProfitShareParams): MatchPayout {
  /* A CANCELLED MATCH THAT OWES THE RENTAL. No revenue, no pool, no split, no manager — a manager
   * is paid nothing on a cancelled date (managerPayCompute.ts:488, `m.is_cancelled ? 0 : …`), so
   * charging one here would invent a cost nobody bears. The partner gets the rental and that is
   * the whole row.
   *
   * RECONCILIATION HOLDS WITHOUT A SPECIAL CASE: gross 0, partnerTotal 16000, manager 0, so
   * matchdayRetained is −16000 and 16000 + (−16000) + 0 === 0. This is exactly what the
   * subtraction form was written for, and MatchDay absorbing the rental is the true statement. */
  if (m.cancelled && rentalOwedOnCancellation(m, p)) {
    return {
      matchApiId: m.matchApiId, startYmd: m.startYmd, grossCents: 0, spotsSold: 0,
      fieldRentalCents: p.fieldRentalCents, matchManagerCents: 0, poolCents: 0,
      partnerProfitShareCents: 0, matchdayProfitShareCents: -p.fieldRentalCents,
      partnerTotalCents: p.fieldRentalCents, matchdayRetainedCents: -p.fieldRentalCents,
      reconciles: p.fieldRentalCents + -p.fieldRentalCents + 0 === 0,
      played: m.played, cancelled: true,
    };
  }
  if (m.cancelled || !m.played) {
    return {
      matchApiId: m.matchApiId, startYmd: m.startYmd, grossCents: 0, spotsSold: 0,
      fieldRentalCents: 0, matchManagerCents: 0, poolCents: 0,
      partnerProfitShareCents: 0, matchdayProfitShareCents: 0,
      partnerTotalCents: 0, matchdayRetainedCents: 0, reconciles: true,
      played: m.played, cancelled: m.cancelled,
    };
  }
  const fieldRentalCents = p.fieldRentalCents;
  const matchManagerCents = p.matchManagerCents;
  // THE RENTAL IS NOT DEDUCTED. This one line is the whole correction.
  const poolCents = m.grossCents - matchManagerCents;
  // The single rounding point, unchanged in kind: one Math.round after the pool is final.
  const splitCents = poolCents > 0 ? Math.round((poolCents * p.partnerSharePct) / 100) : 0;
  const amountToPayCents = Math.max(0, splitCents - fieldRentalCents);
  const partnerTotalCents = fieldRentalCents + amountToPayCents;   // === max(fieldRental, split)
  // A SUBTRACTION, NOT (1 − s)·pool. Under the floor MatchDay absorbs the difference between the
  // split and the rental, and only this form keeps the books balancing when it does.
  const matchdayRetainedCents = m.grossCents - matchManagerCents - partnerTotalCents;
  return {
    matchApiId: m.matchApiId, startYmd: m.startYmd, grossCents: m.grossCents, spotsSold: m.spotsSold,
    fieldRentalCents, matchManagerCents, poolCents,
    partnerProfitShareCents: amountToPayCents,
    matchdayProfitShareCents: poolCents - partnerTotalCents,
    partnerTotalCents, matchdayRetainedCents,
    reconciles: partnerTotalCents + matchdayRetainedCents + matchManagerCents === m.grossCents,
    played: true, cancelled: false,
  };
}

/** Dispatch on the partner's own kind. The only place that chooses between the two formulas. */
export function payoutForMatchOf(
  kind: PayoutModel,
  m: MatchInput,
  p: RentalProfitShareParams,
): MatchPayout {
  return kind === "RENTAL_FLOOR_PROFIT_SHARE" ? payoutForMatchFloor(m, p) : payoutForMatch(m, p);
}

export type PayoutTotals = {
  matches: number;
  grossCents: number;
  spotsSold: number;
  fieldRentalCents: number;
  matchManagerCents: number;
  poolCents: number;
  partnerProfitShareCents: number;
  matchdayProfitShareCents: number;
  partnerTotalCents: number;
  matchdayRetainedCents: number;
  reconciles: boolean;
};

// Aggregate by SUMMING THE PER-MATCH RESULTS, never by re-running the formula on summed gross.
// Those differ the moment any single match is below cost: the max(0, pool) floor is per match, so
// a month with one underwater match and one profitable one is not the same as one combined pool.
/**
 * AMOUNT OWED — what is still to be paid, once the rentals already paid are taken out.
 *
 * A DISPLAY SPLIT OF partnerTotal, DERIVED AND NEVER STORED. partnerTotal = fieldRental + the
 * top-up on every rental row, so the top-up IS the amount owed and this function only names it.
 * It adds no term to the reconciliation, which stays a statement about partnerTotal:
 *     partnerTotal + matchdayRetained + matchManager === gross
 * and is unaffected by how partnerTotal is presented.
 *
 * WHY IT IS THE NUMBER TO HIGHLIGHT. The rental is paid per reservation, up front, so a total that
 * includes it overstates what anyone still owes. Measured: September's total is $822.00 of which
 * $640.00 is four rentals already paid, leaving $182.00; August's is $1,700.00 of which $1,440.00
 * is nine rentals, leaving $260.00. `partnerTotal - amountOwed` is exactly rentals x $160 in both.
 *
 * IT WORKS ON BOTH RENTAL KINDS because partnerProfitShareCents means the same thing in each: the
 * part of the payment that is NOT the rental. On the shipped kind it is the profit share; on the
 * floor kind it is the top-up above the floor. Same split either way.
 *
 * A CHARGED CANCELLATION CONTRIBUTES ZERO to it — its top-up is 0 and its whole payment is the
 * rental. That treats a cancelled reservation's rental as ALREADY PAID, which is what "paid per
 * reservation up front" implies and what fin_venues.charge_on_cancel=true is consistent with (the
 * venue keeps it rather than billing for it). Nothing in the data proves a prepayment happened —
 * see the report — and if it turns out a cancelled date's rental was NOT prepaid, this is the one
 * line to change: September would read $342.00 instead of $182.00.
 */
export const amountOwedOf = (t: PayoutTotals): number => t.partnerProfitShareCents;

export function totalsOf(rows: MatchPayout[]): PayoutTotals {
  const t: PayoutTotals = {
    matches: 0, grossCents: 0, spotsSold: 0, fieldRentalCents: 0, matchManagerCents: 0, poolCents: 0,
    partnerProfitShareCents: 0, matchdayProfitShareCents: 0, partnerTotalCents: 0, matchdayRetainedCents: 0,
    reconciles: true,
  };
  for (const r of rows) {
    // Cancelled matches are already zeroed by payoutForMatch, but they must not inflate the COUNT
    // either — "3 matches" on a payout page means three that were played.
    if (r.fieldRentalCents === 0 && r.grossCents === 0 && r.spotsSold === 0) continue;
    /* A CHARGED CANCELLATION CONTRIBUTES MONEY BUT IS NOT A MATCH PLAYED. The footer says
     * "N matches played", and a date nobody played on must not be counted there — but its rental
     * is real and every money column below still takes it. Under RENTAL_PLUS_PROFIT_SHARE a
     * cancelled row is fully zeroed and never reaches this line, so nothing about that model
     * changes. */
    if (!r.cancelled) t.matches++;
    t.grossCents += r.grossCents;
    t.spotsSold += r.spotsSold;
    t.fieldRentalCents += r.fieldRentalCents;
    t.matchManagerCents += r.matchManagerCents;
    t.poolCents += r.poolCents;
    t.partnerProfitShareCents += r.partnerProfitShareCents;
    t.matchdayProfitShareCents += r.matchdayProfitShareCents;
    t.partnerTotalCents += r.partnerTotalCents;
    t.matchdayRetainedCents += r.matchdayRetainedCents;
    if (!r.reconciles) t.reconciles = false;
  }
  // The aggregate is checked in its own right, not merely inherited from the rows.
  if (t.partnerTotalCents + t.matchdayRetainedCents + t.matchManagerCents !== t.grossCents) t.reconciles = false;
  return t;
}

// ── BREAKEVEN — the most useful number on the page for both sides ────────────────────────────────
// The spots needed before ANY profit share exists. Derived from the parameters, never stated as a
// constant: at $15 with a $160 rental and a $40 manager it is 14, and the brief's own "no profit
// share below $160" was a cent short of the truth because the manager cost comes out first.
export function breakevenSpots(spotPriceCents: number, p: RentalProfitShareParams): number | null {
  if (!Number.isFinite(spotPriceCents) || spotPriceCents <= 0) return null;
  return Math.ceil((p.fieldRentalCents + p.matchManagerCents + 1) / spotPriceCents);
}

// ── GROSS REVENUE ───────────────────────────────────────────────────────────────────────────────
// "Every spot at what was actually paid: $15 spots at $15, promo-discounted spots at their
// discounted price, free member spots at $0."
//
// NOTE, because the brief said to reuse the existing revenue function and this deliberately does
// not: the existing periodOwed() sums payment_type === "DAILY PAID" ONLY, which drops PROMOCODE
// rows entirely rather than counting them at their discounted price. On Parmer's first six matches
// that is $45.00 of real money on 24 promo rows — small, but it is a definitional difference that
// would surface as an unexplained gap in the very reconciliation line that makes the split
// credible. What IS reused is the row source and its filters (WAITING and cancelled rows already
// dropped upstream by mdapiMatchesRead); what is not is the DAILY-PAID-only narrowing.
export type GrossRow = { paymentType: string | null; amountCents: number; userType: string | null };

// MatchDay staff spots stay excluded, as today.
const STAFF_USER_TYPES = new Set(["STAFF", "MATCHDAY_STAFF"]);

export function grossCentsFromRows(rows: GrossRow[]): { grossCents: number; spotsSold: number } {
  let grossCents = 0, spotsSold = 0;
  for (const r of rows) {
    if (r.userType != null && STAFF_USER_TYPES.has(r.userType)) continue;
    // paymentType null means the row was never a spot (WAITING, unknown) — already dropped
    // upstream, and dropped again here so this function is safe on any row set.
    if (r.paymentType == null) continue;
    grossCents += Math.round(r.amountCents) || 0;
    spotsSold++;
  }
  return { grossCents, spotsSold };
}

// ── NEW vs RETURNING ────────────────────────────────────────────────────────────────────────────
// New to THIS VENUE, not new to MatchDay. Computed against ALL history at the venue, never just the
// displayed window — a player whose first Parmer match was in July is RETURNING in August, and a
// window-only computation would call them new every month forever.
export type VenueAppearance = { userId: string; ymd: string };

export function newVsReturning(
  allVenueAppearances: VenueAppearance[],
  windowStartYmd: string,
  windowEndYmd: string,
): { newPlayers: number; returning: number; newUserIds: string[] } {
  const firstSeen = new Map<string, string>();
  for (const a of allVenueAppearances) {
    const prev = firstSeen.get(a.userId);
    if (prev == null || a.ymd < prev) firstSeen.set(a.userId, a.ymd);
  }
  const inWindow = new Set(
    allVenueAppearances.filter((a) => a.ymd >= windowStartYmd && a.ymd <= windowEndYmd).map((a) => a.userId),
  );
  const newUserIds: string[] = [];
  let returning = 0;
  for (const uid of inWindow) {
    const first = firstSeen.get(uid)!;
    if (first >= windowStartYmd && first <= windowEndYmd) newUserIds.push(uid);
    else returning++;
  }
  return { newPlayers: newUserIds.length, returning, newUserIds: newUserIds.sort() };
}

export const fmtCents = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// ── PERIODS ─────────────────────────────────────────────────────────────────────────────────────
// A month closes on its LAST DAY and is paid on the 5TH of the next. Both are stated on the page
// rather than left inferable, and both are derived here so the view never does date arithmetic.
//
// YMD STRING MATHS ONLY. No Date parsing anywhere in this file: match dates are local wall clock
// wearing a Z, and a period boundary computed through new Date() is the same class of bug as the
// one that let an unplayed match be billed for.
export type PeriodStatus = "in_progress" | "due" | "paid" | "nothing_owed";

/** The ledger row for a period, from partner_weekly_payments. Null when none exists yet. */
/* THE LEDGER ROW FOR A PERIOD.
 *
 * `paidAmountCents` IS WHAT ACTUALLY MOVED, and it is null on every period paid exactly what the
 * formula said. It exists because August 2026 for Parmer was paid $2,520.00 while the two live
 * formulas produce $2,360.00 and $1,700.00 — both confirmed against the live rows. A payment can
 * differ from the model, and a settled period should show the fact rather than a recomputation
 * that a later formula change would silently rewrite.
 *
 * IT NEVER ENTERS THE RECONCILIATION. partnerTotal + matchdayRetained + matchManager === gross is
 * a statement about the COMPUTED figures and stays one; the paid amount is displayed beside that
 * check, never inside it. */
export type PeriodLedger = {
  status: "pending" | "paid" | "disputed";
  paidAt: string | null;
  paidAmountCents?: number | null;
} | null;

const DAYS_IN = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/** Last day of the month, YYYY-MM-DD. */
export function monthCloseYmd(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  return `${ym}-${String(DAYS_IN(y, m)).padStart(2, "0")}`;
}

/** The 5th of the following month, YYYY-MM-DD. */
export function monthPayYmd(ym: string): string {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-05`;
}

/**
 * THE PERIOD'S STATE — read from the LEDGER first, derived from dates only when the ledger is
 * silent.
 *
 * I previously shipped this deriving from dates alone, with a comment asserting that "paid" could
 * never be returned because nothing recorded a partner payment. THAT WAS WRONG:
 * `partner_weekly_payments` has existed since migration 0003 and is what drives PAC Global's Paid
 * chips. My schema search missed it twice — a case-sensitive grep for `create table` against a
 * file that says `CREATE TABLE`, and a content grep for `partner_payment` which is not a substring
 * of `partner_weekly_payments`. Asserting a negative from searches that can only produce false
 * negatives is the actual error.
 *
 * PAID WINS OVER EVERY DATE RULE. A period marked paid is paid even if the month is still open —
 * an early settlement is a fact about money that moved, not something to be second-guessed by a
 * calendar. This ordering is also what stops a paid period being rendered "Due next cycle", which
 * is the mismatch visible on PAC Global's monthly table today.
 *
 * A `disputed` row deliberately does NOT read as paid; it falls through to the date rules, so it
 * shows as due/in progress rather than claiming money has moved.
 */
export function periodStatusOf(
  ym: string,
  todayYmd: string,
  partnerTotalCents: number,
  ledger: PeriodLedger = null,
): PeriodStatus {
  if (ledger?.status === "paid") return "paid";
  if (todayYmd <= monthCloseYmd(ym)) return "in_progress";
  return partnerTotalCents === 0 ? "nothing_owed" : "due";
}

export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = {
  in_progress: "In progress",
  due: "Due",
  paid: "Paid",
  nothing_owed: "Nothing owed",
};
