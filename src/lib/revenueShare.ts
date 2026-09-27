/* IS A VENUE ON A REVENUE SHARE? ONE RULE, AND THIS FILE EXISTS SO IT CAN BE SHARED.
 *
 * WHY A LEAF MODULE AND NOT A FUNCTION IN fieldEconomics. It started there, next to basisOf, which
 * is where the rule has always lived. But fieldEconomics imports financeStats, partnerStats and
 * mdapiMatchesRead, and reaches "use client" code through useFinanceData — so importing it from
 * matchPromotion.ts dragged React and the browser Supabase client into a `runtime = "nodejs"` API
 * route. `tsc` says nothing about that: the useFinanceData import is type-only, so the whole thing
 * typechecks clean and the weight only shows up in the bundle.
 *
 * A leaf with no imports of its own is the version both sides can call. basisOf calls it and Match
 * Promotion calls it, and there is exactly one copy of the test.
 *
 * ── WHY THIS MATTERS ENOUGH TO EXTRACT ──────────────────────────────────────────────────────
 * PARTNER used to be a hand-applied tag on the Match Promotion tile — a second copy of this fact
 * with nothing tying it to the contract. It drifted, as copies do. Measured on prod 2026-09-26: the
 * one field carrying the tag was a per_match RENTAL, and all five fields genuinely on a share
 * carried nothing. The badge is derived from here now, so there is nothing left to drift.
 *
 * ── THE TWO INPUTS, AND WHAT IS DELIBERATELY NOT READ ───────────────────────────────────────
 * per_match_minus_manager (Crossbar Rowlett) is STORED as per_match and PAID as a share of match
 * revenue, which is why it counts — a label has to describe how the money actually moves.
 *
 * revenue_model_next IS NOT CONSULTED. basisOf has never consulted it, and reading it here would
 * silently move numbers on the finance pages. Crossbar's dated move to per_match_fee (from
 * 2026-08-01, migration 0150) therefore still reads as a share. That is the EXISTING behaviour
 * preserved, not a new claim about Crossbar's terms — worth knowing if the badge ever looks stale.
 */
export function isRevenueShareVenue(
  billingType: string | null | undefined,
  revenueModel: string | null | undefined,
): boolean {
  return billingType === "profit_share" || revenueModel === "per_match_minus_manager";
}
