/* THE VENUE WRITE ALLOWLIST AND ITS ONE REFUSAL, LIFTED OUT OF THE ROUTE SO THEY CAN BE TESTED.
 *
 * These lived inline in /api/venues. They are here because the refusal below is the backstop on a
 * bug that took /admin/finance/revenue down for every operator on 2026-09-11, and a backstop that
 * can only be exercised by writing to a production venue is a backstop nobody exercises. Pure
 * functions, no supabase, no server-only imports — importable from a node test.
 *
 * The route still owns the permission boundary (authenticateCapability(req, "finance")) and every
 * database call. Nothing about who may write changed by moving these. */

/* THE COLUMNS THIS ROUTE WILL WRITE, and nothing else. An allowlist rather than a spread of the
 * request body: fin_venues carries columns that change how cost reconciliation aggregates, and a
 * field-setup drawer has no business setting them.
 *
 * DELIBERATELY ABSENT — billing_cadence and bills_per_reservation. Both feed financeCosts,
 * fieldEconomics and opexSources: cadence drives how a monthly_flat venue is amortised across
 * matches, and bills_per_reservation decides whether a multi-match reservation bills once or per
 * match. Neither is something you know while setting up a pitch, and a wrong value is a wrong
 * number in the P&L rather than a wrong label on a screen. They keep their column defaults
 * ('monthly' and false) on create and are edited on Field Costs.
 *
 * charge_on_cancel IS here: it is a per-venue yes/no the person setting the field up does know,
 * and it is in the approved mock. */
export const VENUE_FIELDS = [
  "venue_name", "city", "billing_type", "per_match_rate", "hourly_rate", "cost_per_match",
  "charge_on_cancel",
  // The "on the day" half — same row, different question. 0074 added these.
  "min_players", "max_players", "contact_name", "contact_number", "schedule_url",
] as const;

/* venue_name and city are required on create, and a PATCH may not take them away afterwards.
 * CITY IS THE LOAD-BEARING ONE: every finance read path joins on it, and an empty city reaches
 * salesTax.preTaxOf, which refuses a city it holds no rate for rather than defaulting to 0% and
 * leaving tax inside a pre-tax figure. That refusal is correct and unconditional, so a blank city
 * is not a cosmetic defect — it is an exception thrown on page render.
 *
 * Returns the offending column name, or null when the patch is safe. A key that is ABSENT is
 * fine: this is a partial update and not touching a column is not the same as clearing it. */
export function emptiedRequiredField(
  patch: Record<string, unknown>,
): "venue_name" | "city" | null {
  for (const k of ["venue_name", "city"] as const) {
    if (k in patch && !String(patch[k] ?? "").trim()) return k;
  }
  return null;
}

export const pickVenueFields = (src: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const k of VENUE_FIELDS) if (k in src && src[k] !== undefined) out[k] = src[k];
  return out;
};
