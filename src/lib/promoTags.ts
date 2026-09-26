/* FIELD TAGS — manually set, several per field, keyed on the field and not on the match.
 *
 * Ryan: "A NEW FIELD / PRIORITY tag we could manually add so we can all see key fields. For the
 * Starting 11 it could be a tag as well. As we are going to have multiple tags per field, maybe
 * have each tag a different colour. A small section at the top to explain each tag could be
 * useful."
 *
 * ── KEY FIELD IS A RENAME, AND IT IS THE ONE THING HERE NOT BUILT AS ASKED ──────────────────
 * NEW FIELD is already an automatic badge: newnessOf computes it against last week's slate and its
 * tooltip names the rule and both dates. A hand-typed pill reading the same words would make the
 * computed one untrustworthy, and nobody looking at two identical pills could tell which was
 * earned. KEY FIELD carries the same intent and collides with nothing.
 *
 * ── STARTING 11 IS A LIVE PROMO CODE AND THIS IS SET BY HAND ────────────────────────────────
 * Ryan's call, knowingly: it will occasionally be stale rather than wired to the code's lifecycle.
 * Deriving it later changes nothing about how it renders, which is what makes the trade cheap.
 */
export const TAG_KEYS = ["key_field", "priority", "starting_11", "partner"] as const;
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
  key_field:   { label: "KEY FIELD",   colour: "#2563EB", meaning: "A field we are choosing to push harder than the rest." },
  priority:    { label: "PRIORITY",    colour: "#7C3AED", meaning: "Needs attention this week, whatever its push state says." },
  starting_11: { label: "STARTING 11", colour: "#DB2777", meaning: "Starting 11 promo code is live on this field." },
  partner:     { label: "PARTNER",     colour: "#0891B2", meaning: "A partner venue. Revenue is shared, so a quiet week costs twice." },
};

/* THE COLOURS THE PAGE HAS ALREADY SPENT. Exported so the assertion can check the collision rather
 * than merely counting to four — four distinct colours that happen to include mint would pass a
 * count and fail a reader. */
export const COLOURS_IN_USE = [
  "#2CDB87", // mint, push state
  "#F4C430", "#E8862A", "#D9452F", "#8F2A17", // the cancel ramp
  "#003326", // deep green, the NEW badge
] as const;

/* ── THREE RENDER, THE REST BECOME A COUNT ───────────────────────────────────────────────────
 * Several per field is the stated case and five pills on one tile is unreadable. Keswick carries
 * all four. The order is TAG_KEYS' own, so which three show is stable between loads rather than
 * depending on the order rows came back from the database. */
export const TAGS_SHOWN = 3;

export function splitTags(tags: readonly TagKey[]): { shown: TagKey[]; more: number } {
  const ordered = TAG_KEYS.filter((k) => tags.includes(k));
  return { shown: ordered.slice(0, TAGS_SHOWN), more: Math.max(0, ordered.length - TAGS_SHOWN) };
}

/* THE KEY LISTS ONLY WHAT IS ON SCREEN. A key listing every tag that could exist is a key nobody
 * reads, which this codebase has already written down once about a permanent caveat. Every tag
 * also carries its meaning in a title, so the key is a reference rather than a prerequisite. */
export function tagsInUse(byField: ReadonlyMap<number, TagKey[]>): TagKey[] {
  const seen = new Set<TagKey>();
  for (const list of byField.values()) for (const t of list) seen.add(t);
  return TAG_KEYS.filter((k) => seen.has(k));
}
