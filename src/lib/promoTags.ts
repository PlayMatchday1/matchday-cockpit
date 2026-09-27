/* FIELD TAGS — manually set, keyed on the field and not on the match.
 *
 * TWO TAGS. It was four, and 0192 cut it to two:
 *
 * ── KEY FIELD MERGED INTO PRIORITY ──────────────────────────────────────────────────────────
 * "A field we are choosing to push harder than the rest" and "needs attention this week, whatever
 * its push state says" are the same thing said twice. Both were rows in the same table at the same
 * scope, so the merge was a value change and not a re-modelling.
 *
 * ── PARTNER IS NOT A TAG. IT IS DERIVED, AND IT IS READ-ONLY ────────────────────────────────
 * A contract fact already recorded on the finance side (fin_venues.billing_type and
 * partner_dashboards.revenue_model, reconciled by isRevenueShareVenue in fieldEconomics). A tag
 * anyone could apply by hand was a second copy with nothing tying it to the first, and the copy
 * was ALREADY WRONG: the one field carrying it (1717 Keswick Park) is billed per_match, and all
 * FIVE fields actually on a share carried nothing. See partnerFieldIds in matchPromotion.
 *
 * ── NEW FIELD IS STILL NOT HERE, AND THAT IS STILL DELIBERATE ───────────────────────────────
 * newnessOf computes it against last week's slate with the rule and both dates in its tooltip. A
 * hand-typed pill reading the same words would make the computed one untrustworthy.
 *
 * ── STARTING 11 IS SET BY HAND, AND THE COPY SAYS SO ────────────────────────────────────────
 * Every venue has its own Starting 11 code and WHICH code it is does not matter here; the tag means
 * only that Starting 11 is live at the field. Nothing links it to a code's lifecycle and nothing is
 * going to for now, so the meaning states the staleness rather than implying the tag is verified.
 * Checked while writing this: no row in the 6,514 synced mdapi_promocodes matches STARTING, START11
 * or S11, so a derivation would have had nothing to key on even if we had wanted one.
 */
export const TAG_KEYS = ["priority", "starting_11"] as const;
export type TagKey = (typeof TAG_KEYS)[number];

export const isTagKey = (v: unknown): v is TagKey => TAG_KEYS.includes(v as TagKey);

/* ── FOUR COLOURS, NONE OF THEM ALREADY SPOKEN FOR ───────────────────────────────────────────
 * The tile is already crowded with meaning: MINT is push state, the YELLOW-THROUGH-DARK-RED ramp
 * is cancel history, DEEP GREEN is the NEW badge, AMBER is needs-a-decision and the promo code.
 * A tag borrowing any of those would be a second meaning on a colour that already has one.
 *
 * OUTLINED, NOT FILLED, and that is structural rather than decorative. The tile spends filled
 * pills on the cancel ratio and the NEW badges; a filled red tag would read as a 4/4 cancel at a
 * glance. Outline separates the three classes before colour is considered at all. */
export const TAG_META: Record<TagKey, { label: string; colour: string; meaning: string }> = {
  /* NOT "a match we are pushing harder THIS WEEK". The row has no week column — a priority set in
   * September still lights this pitch up in November — so the copy says what the storage does. */
  priority:    { label: "PRIORITY",    colour: "#7C3AED", meaning: "A field we are pushing harder. Set by hand and it stays until someone clears it." },
  starting_11: { label: "STARTING 11", colour: "#DB2777", meaning: "Starting 11 is live at this field. Set by hand, so it can go stale when a venue's code ends." },
};

/* THE DERIVED BADGE. Not in TAG_META, because it is not a tag: there is no row for it, no toggle
 * for it and no way to set it. It sits beside the tags on the tile and in the legend so a reader
 * sees one vocabulary, and its colour is the one the hand-applied version used — the badge is the
 * same fact, now sourced from the contract instead of from a click. */
export const PARTNER_BADGE = {
  label: "PARTNER",
  colour: "#0891B2",
  meaning: "A revenue-share venue. A quiet week hurts the partner too.",
} as const;

/* THE COLOURS THE PAGE HAS ALREADY SPENT. Exported so the assertion can check the collision rather
 * than merely counting to four — four distinct colours that happen to include mint would pass a
 * count and fail a reader. */
export const COLOURS_IN_USE = [
  "#2CDB87", // mint, push state
  "#F4C430", "#E8862A", "#D9452F", "#8F2A17", // the cancel ramp
  "#003326", // deep green, the NEW badge
] as const;

/* ── THREE RENDER, THE REST BECOME A COUNT ───────────────────────────────────────────────────
 * Five pills on one tile is unreadable. The order is TAG_KEYS' own, so which three show is stable
 * between loads rather than depending on the order rows came back from the database.
 *
 * WITH TWO TAGS AND A CAP OF THREE THIS CANNOT FIRE, and the render path is kept anyway — it is
 * dead-but-correct code for the third tag somebody adds. Its assertion moved OUT of the DOM and
 * into a node guard on this function (scripts/promo-tags-test.ts), because an assertion the CHECK
 * constraint makes unfailable is the `|| true` problem in another coat: it cannot go red, so it is
 * not checking anything. The guard hands splitTags a synthetic list and still checks the split. */
export const TAGS_SHOWN = 3;

/* THE CAP ITSELF, OVER ANY LIST. Separated from splitTags for one reason: with two tag keys and a
 * cap of three, splitTags CANNOT return more > 0, so a test written against it can only ever assert
 * the empty case and would pass if the overflow arithmetic were deleted. This takes a plain list, so
 * the guard can hand it four items and watch the split actually happen. */
export function splitAtCap<T>(ordered: readonly T[], cap: number = TAGS_SHOWN): { shown: T[]; more: number } {
  return { shown: ordered.slice(0, cap), more: Math.max(0, ordered.length - cap) };
}

export function splitTags(tags: readonly TagKey[]): { shown: TagKey[]; more: number } {
  return splitAtCap(TAG_KEYS.filter((k) => tags.includes(k)));
}

/* THE KEY LISTS ONLY WHAT IS ON SCREEN. A key listing every tag that could exist is a key nobody
 * reads, which this codebase has already written down once about a permanent caveat. Every tag
 * also carries its meaning in a title, so the key is a reference rather than a prerequisite. */
export function tagsInUse(byField: ReadonlyMap<number, TagKey[]>): TagKey[] {
  const seen = new Set<TagKey>();
  for (const list of byField.values()) for (const t of list) seen.add(t);
  return TAG_KEYS.filter((k) => seen.has(k));
}
