/* PROMOTION TAGS — THREE OF THEM, AT TWO SCOPES.
 *
 * Ryan: "priority tag is not supposed to be at the field level it's supposed to be at the match
 * level." And then: "key field could be fine to keep, I like it because can basically make it the
 * priority version of the full field."
 *
 * So PRIORITY and KEY FIELD are ONE CONCEPT AT TWO SCOPES, and the name carries the scope:
 *
 *   priority     MATCH   We are pushing this one harder.
 *   key_field    FIELD   The same thing for every match at that field.
 *   starting_11  FIELD   Starting 11 is live at this venue.
 *
 * ── WHY 0192 MERGED THEM AND 0193 SPLIT THEM AGAIN ──────────────────────────────────────────
 * 0192 collapsed key_field into priority on the grounds they meant the same thing. That was my
 * reading of "they mean the same thing in practice", and it dropped the half that mattered: they
 * mean the same thing AT DIFFERENT SCOPES. 0193 re-admits key_field and the database now enforces
 * the scope per tag, so the two cannot be confused in data even if someone confuses them in prose.
 *
 * ── MOVING PRIORITY TO THE MATCH REMOVES ITS STALENESS PROBLEM ──────────────────────────────
 * A match ends and the tag ends with it, so there is nothing to clear and no expiry job to build.
 * KEY FIELD and STARTING 11 are the hand-set ones that persist, and STARTING 11 is the only one
 * whose CLAIM can be wrong: it asserts a code is live while being set by hand. That caveat lives
 * in `note` and renders on hover rather than on the row.
 *
 * ── PARTNER IS NOT HERE IN ANY FORM ─────────────────────────────────────────────────────────
 * A hand-set tag first (removed by 0192: wrong on its one field, absent from all five that
 * qualified), then a derived read-only badge, and now off this page entirely. See the note further
 * down. The contract fact still lives on the finance side, where basisOf derives it.
 */
export const TAG_KEYS = ["priority", "key_field", "starting_11"] as const;
export type TagKey = (typeof TAG_KEYS)[number];
export type TagScope = "match" | "field";

export const isTagKey = (v: unknown): v is TagKey => TAG_KEYS.includes(v as TagKey);

/* ── ONE COLOUR FOR ONE CONCEPT ──────────────────────────────────────────────────────────────
 * PRIORITY and KEY FIELD SHARE #7C3AED, deliberately breaking the original "maybe have each tag a
 * different colour": two colours for one idea would read as two ideas. COLOUR CARRIES THE CONCEPT,
 * THE LABEL CARRIES THE SCOPE. STARTING 11 is a different idea and keeps its own.
 *
 * Neither collides with anything the page already spends: mint is push state, yellow through dark
 * red is cancel history, deep green is the NEW badge, and amber is needs-a-decision and the promo
 * code.
 *
 * OUTLINED, NOT FILLED, and that is structural rather than decorative: the tile spends filled pills
 * on the cancel ratio and the NEW badges, so a filled tag would read as a 4/4 cancel at a glance. */
export const TAG_META: Record<TagKey, {
  label: string; colour: string; scope: TagScope; why: string; note?: string;
}> = {
  priority: {
    label: "PRIORITY", colour: "#7C3AED", scope: "match",
    why: "Extra promotion for this match.",
  },
  key_field: {
    /* ── ITS OWN COLOUR, AND IT WAS SHARED WITH PRIORITY UNTIL 2026-09-30 ──────────────────────
     * The pair shared #7C3AED and were split on border style, solid against dashed. That failed
     * twice over: it does not read at tile size, and the LEGEND SWATCH rendered solid while its
     * own caption said dashed — the key contradicting the page it explains. The field team asked
     * for two colours twice.
     *
     * TEAL IS THE GAP IN THIS PAGE'S WHEEL, which is why it is this teal and not a lighter violet:
     * deep green and slate blue are the change tags, yellow through dark red is the cancel ramp,
     * mint and emerald are push state, coral is cancelled, amber is a decision pending. #0E7490 is
     * the one hue left that collides with none of them.
     *
     * KEY FIELD IS STILL PRIORITY AT FIELD SCOPE — that has not changed and the descriptions carry
     * it ("for this match" against "for all matches here"). What changed is that scope is no
     * longer asked to ride on a border nobody could compare. */
    label: "KEY FIELD", colour: "#0E7490", scope: "field",
    why: "Extra promotion for all matches here.",
  },
  starting_11: {
    label: "STARTING 11", colour: "#DB2777", scope: "field",
    why: "Active promo at this field.",
    /* THE ONLY TAG WHOSE CLAIM CAN BE WRONG. Off the visible row, still findable on hover. */
    note: "Set by hand, so it can go stale when a venue's code ends.",
  },
};

/** The order the KEY lists them in, which is the mock's own and not TAG_KEYS'. */
export const TAG_KEY_ORDER: readonly TagKey[] = ["starting_11", "priority", "key_field"] as const;

/** What a tag's hover text says, in one place so the tile, the key and the toggle all agree. */
export const tagTitle = (k: TagKey): string =>
  `${TAG_META[k].label}: ${TAG_META[k].why}${TAG_META[k].note ? ` ${TAG_META[k].note}` : ""}`;

/* ── A TAG'S DATES (0207, Ryan 2026-10-05) ─────────────────────────────────────────────────────
 * starting_11 is a FIELD row and used to show on every week forever. starts_on / ends_on bound it:
 * a match shows the tag only if its date is between them, INCLUSIVE. ends_on null = still live.
 * Both null (every row before 0207) = always, until someone edits it. Dates are calendar days
 * (YYYY-MM-DD), compared as strings — no zone, no Date. */
export type TagDates = { startsOn: string | null; endsOn: string | null };
export const tagLiveOn = (d: TagDates | null | undefined, ymd: string): boolean =>
  !d || ((d.startsOn == null || ymd >= d.startsOn) && (d.endsOn == null || ymd <= d.endsOn));

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return `${MON[m - 1]} ${d}, ${y}`; };
/** "Oct 1, 2026 – still live", "Sep 1, 2026 – Sep 30, 2026", or null when the row has no dates. */
export function tagRangeLabel(d: TagDates | null | undefined): string | null {
  if (!d || (d.startsOn == null && d.endsOn == null)) return null;
  return `${d.startsOn ? shortDay(d.startsOn) : "Any start"} – ${d.endsOn ? shortDay(d.endsOn) : "still live"}`;
}
/** tagTitle, with the date range when the tag carries one. */
export const tagTitleWithDates = (k: TagKey, d: TagDates | null | undefined): string => {
  const r = tagRangeLabel(d);
  return r ? `${tagTitle(k)} Dates: ${r}.` : tagTitle(k);
};

/** The tags at one scope, for the panel's two groups. */
export const tagsAtScope = (s: TagScope): TagKey[] => TAG_KEYS.filter((k) => TAG_META[k].scope === s);

/* ── PARTNER IS NOT HERE, AT ALL, IN ANY FORM ─────────────────────────────────────────────────
 * It was a hand-set tag (removed by 0192 because it was wrong on its one field and absent from all
 * five that qualified), then a derived read-only badge, and now it is gone from this page entirely.
 * Ryan: "Remove it from everything." The contract fact still lives on the finance side and basisOf
 * still derives it there; this page simply does not render it.
 *
 * isRevenueShareVenue STAYS in lib/revenueShare because basisOf calls it. Nothing here does. */

/* THE COLOURS THE PAGE HAS ALREADY SPENT. Exported so the assertion can check the COLLISION rather
 * than merely counting distinct values: two distinct colours that happen to include mint would pass
 * a count and fail a reader. */
export const COLOURS_IN_USE = [
  "#2CDB87", // mint, push state
  "#F4C430", "#E8862A", "#D9452F", "#8F2A17", // the cancel ramp
  "#003326", // deep green, the NEW badge
] as const;

/* ── KEY FIELD SWALLOWS PRIORITY ON THE TILE ─────────────────────────────────────────────────
 * A match at a KEY FIELD is already one we are pushing harder, so a PRIORITY pill beside it says
 * nothing and spends a third of a crowded row.
 *
 * THE TILE HIDES IT; THE PANEL MUST NOT. If the toggle read what the tile renders, a PRIORITY that
 * IS set would come up dark and the next save would silently clear it. So this function is for
 * DISPLAY ONLY and the editor reads the raw list — which is why it is named for what it does. */
export function tagsForDisplay(tags: readonly TagKey[]): TagKey[] {
  const has = new Set(tags);
  if (has.has("key_field")) has.delete("priority");
  return TAG_KEYS.filter((k) => has.has(k));
}

/* ── THREE RENDER, THE REST BECOME A COUNT ───────────────────────────────────────────────────
 * KEPT AS AN INVARIANT even though three tags exist and KEY FIELD swallows PRIORITY, so the cap
 * can no longer fire. It is the rule that a crowded row stays readable, and deleting it because
 * today's tag list happens to fit is how the fourth tag arrives and nobody notices. */
export const TAGS_SHOWN = 3;

/* THE CAP ITSELF, OVER ANY LIST. Separated from splitTags because the real tag list can no longer
 * exceed the cap, so a test written against splitTags alone could only assert the empty case and
 * would pass if the overflow arithmetic were deleted. This takes a plain list, so the guard can
 * hand it four items and watch the split actually happen. */
export function splitAtCap<T>(ordered: readonly T[], cap: number = TAGS_SHOWN): { shown: T[]; more: number } {
  return { shown: ordered.slice(0, cap), more: Math.max(0, ordered.length - cap) };
}

export function splitTags(tags: readonly TagKey[]): { shown: TagKey[]; more: number } {
  return splitAtCap(tagsForDisplay(tags));
}

/* THE KEY LISTS ONLY WHAT IS ON SCREEN, in TAG_KEY_ORDER. A key listing every tag that could exist
 * is a key nobody reads. Every tag also carries its meaning in a title, so the key is a reference
 * rather than a prerequisite. */
export function tagsInUse(lists: Iterable<readonly TagKey[]>): TagKey[] {
  const seen = new Set<TagKey>();
  for (const list of lists) for (const t of list) seen.add(t);
  return TAG_KEY_ORDER.filter((k) => seen.has(k));
}
