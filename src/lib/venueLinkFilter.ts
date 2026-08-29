/* EXCLUDED FIELDS — one filter, read by every surface that counts a venue's money.
 *
 * `fin_venue_fields.excluded_from_venue` (migration 0155) means: this field stays LINKED to its
 * venue, still appears in every list, and is left OUT of the venue's matches, spots, revenue and
 * cost. It exists for one-offs and special events that run at a real venue but should not count
 * toward it — 1123 "Soccer Central World Cup Tournament" being the case that prompted it.
 *
 * WHY A SHARED FILTER AND NOT A `.eq()` AT EACH CALL SITE. Four finance surfaces read this table
 * and each would have to remember. One of them forgetting is not a visible bug — it is a venue
 * whose Cost page disagrees with its Venues page by exactly one field, which is the shape of
 * problem this estate keeps paying for. The filter is named, it is asserted, and the surfaces
 * call it.
 *
 * ── IT READS `*`, ON PURPOSE, AND SO MUST ITS CALLERS ─────────────────────────────────────────
 * Code deploys before migrations apply. A query naming `excluded_from_venue` against a database
 * that has not run 0155 yet does not degrade — PostgREST 400s and the whole finance load fails.
 * So every caller selects `*` and this helper treats a MISSING column exactly like `false`, which
 * is both the column's default and today's behaviour. Same reasoning as adminAuth's select("*").
 *
 * ── ABSENT AND FALSE ARE THE SAME ANSWER; ANYTHING ELSE IS NOT ────────────────────────────────
 * Only a literal `true` excludes. A string "true", a 1, a null — none of them exclude, because
 * this flag removes real money from a venue's figures and a coercion bug must fail toward
 * counting, never toward hiding.
 */

export type VenueLinkRow = {
  fin_venue_id?: number | null;
  mdapi_field_id?: number | null;
  excluded_from_venue?: unknown;
  [k: string]: unknown;
};

/** STRICT `=== true`. See the header: absent, null and "true" all mean "counts". */
export const isExcludedLink = (row: VenueLinkRow | null | undefined): boolean =>
  row?.excluded_from_venue === true;

/** The links a finance surface may count. */
export const includedLinks = <T extends VenueLinkRow>(rows: readonly T[] | null | undefined): T[] =>
  (rows ?? []).filter((r) => !isExcludedLink(r));

/** The excluded ones, for saying how many were left out rather than silently dropping them. */
export const excludedLinks = <T extends VenueLinkRow>(rows: readonly T[] | null | undefined): T[] =>
  (rows ?? []).filter((r) => isExcludedLink(r));
