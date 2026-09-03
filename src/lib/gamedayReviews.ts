/* THE REVIEW CELL — pure. Nothing here fetches and nothing here renders.
 *
 * ── THE THRESHOLDS ARE THE REVIEWS PAGE'S OWN, IMPORTED, NOT COPIED ───────────────────────────
 * A match that reads red on the board must be the same match that reads red on the Reviews page.
 * That only holds if there is ONE set of numbers, so ATTN_MAX_AVG / STAND_MIN_AVG / the two
 * MIN_REVIEWS floors come from reviewsDerive. A second copy of 3.5 and 4.8 in this file would
 * drift the first time either page was tuned.
 *
 * ── UNDER THREE REVIEWS THERE IS NO VERDICT ───────────────────────────────────────────────────
 * ATTN_MIN_REVIEWS and STAND_MIN_REVIEWS are both 3, so the Reviews page already refuses to call a
 * match good or bad below that. One 5.00 is not a five-star match and one 1.00 is not a disaster.
 * The number still shows — it is a fact — but in plain ink.
 *
 * ── WHERE THE NUMBERS COME FROM, AND WHAT IS DELIBERATELY MISSING ─────────────────────────────
 * `starRating` / `starRatingCount` ride along on the /admin/matches list rows the gameday route
 * already fetches. Zero extra reads. Measured on production 2026-09-02.
 *
 * THE COMMENT COUNT IS NOT HERE, AND THAT IS A DECISION. The mock's line 2 read
 * "8 reviews · 3 comments". Comments live only in `mdapi_reviews`, whose rows carry NO MATCH ID —
 * the upstream payload has `field_title` and `start_date` and nothing else to key on. The Reviews
 * page therefore groups on `fieldTitle@@startDate`, and that key MERGES GENUINELY DISTINCT
 * MATCHES: measured over 2026-08-30..09-01, 2 of 52 keys held two different matches each
 * ("Onion Creek- Field 10 - M2" and "Onion Creek- Field 9 - M1", same venue, same 7:00 PM). A
 * comment count taken through that key would be wrong on both rows and would look right. So the
 * line says reviews only. It becomes possible the moment the reviews payload carries a match id.
 */

import { ATTN_MAX_AVG, ATTN_MIN_REVIEWS, STAND_MIN_AVG, STAND_MIN_REVIEWS } from "./reviewsDerive";

/** The floor at which the page is willing to judge at all. Both constants are 3; this asserts it. */
export const JUDGE_MIN_REVIEWS = Math.max(ATTN_MIN_REVIEWS, STAND_MIN_REVIEWS);

export type ReviewTone = "none" | "thin" | "crit" | "ok";

/**
 * The cell's tone.
 *
 * COUNT DECIDES WHETHER THERE IS A RATING, never the average. `starRating` comes back as 0 rather
 * than null when nothing has been left, so testing the average would render a real 0.00 as "no
 * reviews yet" — the one match that most needs looking at.
 */
export function reviewTone(avg: number, count: number): ReviewTone {
  if (!Number.isFinite(count) || count <= 0) return "none";
  if (count < JUDGE_MIN_REVIEWS) return "thin";
  if (avg < ATTN_MAX_AVG) return "crit";
  if (avg >= STAND_MIN_AVG) return "ok";
  return "thin";
}

/** Line 1. Two decimals always — "5" and "5.00" in one column do not scan as the same kind of thing. */
export const reviewValue = (avg: number): string => (Number.isFinite(avg) ? avg : 0).toFixed(2);

/** Line 2 when there ARE reviews. Singular at one; "1 reviews" is the kind of thing people notice. */
export const reviewCountLabel = (count: number): string =>
  `${count} review${count === 1 ? "" : "s"}`;

/* ── ZERO REVIEWS IS A STATE, NOT A BLANK ──────────────────────────────────────────────────────
 * Eleven minutes after the whistle, nothing in yet is normal and the cell says how long it has
 * been. Fourteen hours later, nothing in yet is a different fact and worth someone noticing, so it
 * says "none" first and the age second. The boundary is one hour: below it the age alone reads as
 * "give it a minute", above it the absence is the point.
 *
 * MINUTES SINCE THE WHISTLE, NOT SINCE KICKOFF, and the difference decides whether the fresh
 * state exists at all. A row only reaches the "finished" band 90 minutes past kickoff (DONE_MIN),
 * so an age measured from kickoff can never read below 90 and "8m ago" would be unreachable — the
 * state would be written, tested and never once seen. It is measured from endDateUtc. */
export const REVIEW_FRESH_MINUTES = 60;

export function reviewAgeLabel(minsSinceEnd: number): string {
  const m = Math.max(0, Math.floor(Number.isFinite(minsSinceEnd) ? minsSinceEnd : 0));
  if (m < REVIEW_FRESH_MINUTES) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `none · ${h}h`;
  return `none · ${Math.floor(h / 24)}d`;
}

/** Everything the cell needs, in one call, so the component holds no rules of its own. */
export function reviewCell(opts: { avg: number; count: number; minsSinceEnd: number }): {
  tone: ReviewTone; value: string; label: string; hasRating: boolean;
} {
  const tone = reviewTone(opts.avg, opts.count);
  if (tone === "none") {
    return { tone, value: "—", label: reviewAgeLabel(opts.minsSinceEnd), hasRating: false };
  }
  return { tone, value: reviewValue(opts.avg), label: reviewCountLabel(opts.count), hasRating: true };
}
