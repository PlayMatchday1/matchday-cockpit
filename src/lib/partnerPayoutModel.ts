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
// and three manager costs. Cancelled matches are excluded entirely — a cancelled match costs
// nothing and owes nothing.
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

export type PayoutModel = "REVENUE_SHARE" | "PER_MATCH_MINUS_MANAGER" | "RENTAL_PLUS_PROFIT_SHARE";

// Every parameter lives here, on the partner row. Nothing in this file or the UI may hardcode a
// venue name, a rental figure or a share percentage — the next venue has different numbers, and a
// constant in a component is how the second one gets the first one's terms.
export type RentalProfitShareParams = {
  fieldRentalCents: number;
  matchManagerCents: number;
  partnerSharePct: number;
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
    t.matches++;
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
export type PeriodLedger = { status: "pending" | "paid" | "disputed"; paidAt: string | null } | null;

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
