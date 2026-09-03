/* THE REVIEW CELL'S RULES. Pure, so a node guard rather than a browser suite.
 *
 * The assertion this file exists for is that the board and the Reviews page CANNOT DISAGREE: the
 * thresholds are imported from reviewsDerive, and the tests below drive the boundaries through the
 * imported constants rather than through literals, so tuning either page moves both together.
 */
import { reviewTone, reviewCell, reviewValue, reviewCountLabel, reviewAgeLabel, JUDGE_MIN_REVIEWS,
  REVIEW_FRESH_MINUTES } from "../src/lib/gamedayReviews";
import { ATTN_MAX_AVG, ATTN_MIN_REVIEWS, STAND_MIN_AVG, STAND_MIN_REVIEWS } from "../src/lib/reviewsDerive";

let pass = 0, fail = 0; const fails: string[] = [];
const ok = () => { pass++; };
const bad = (n: string, d = "") => { fail++; fails.push(`${n} — ${d}`); };
const is = (n: string, got: unknown, exp: unknown) =>
  JSON.stringify(got) === JSON.stringify(exp) ? ok() : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(exp)}`);
const yes = (n: string, got: boolean, d = "") => (got === true ? ok() : bad(n, d || "was false"));

// ── the floors really are three, and the page's own constants say so ────────────────────────────
is("ATTN_MIN_REVIEWS is 3", ATTN_MIN_REVIEWS, 3);
is("STAND_MIN_REVIEWS is 3", STAND_MIN_REVIEWS, 3);
is("the judging floor is the higher of the two", JUDGE_MIN_REVIEWS, 3);

// ── UNDER THE FLOOR THERE IS NO VERDICT, at either extreme ──────────────────────────────────────
for (let n = 1; n < JUDGE_MIN_REVIEWS; n++) {
  is(`${n} review(s) at 5.00 is NOT green`, reviewTone(5, n), "thin");
  is(`${n} review(s) at 1.00 is NOT red`, reviewTone(1, n), "thin");
  is(`${n} review(s) at 0.00 is NOT red`, reviewTone(0, n), "thin");
}
// CONTROL: the same averages DO colour once the floor is reached, so "thin" above is the floor
// doing its job and not the function refusing to colour anything.
is("CONTROL: 5.00 at the floor IS green", reviewTone(5, JUDGE_MIN_REVIEWS), "ok");
is("CONTROL: 1.00 at the floor IS red", reviewTone(1, JUDGE_MIN_REVIEWS), "crit");

// ── the boundaries, driven off the imported constants ───────────────────────────────────────────
const eps = 0.0001;
is("just under ATTN_MAX_AVG is red", reviewTone(ATTN_MAX_AVG - eps, 5), "crit");
is("exactly ATTN_MAX_AVG is NOT red", reviewTone(ATTN_MAX_AVG, 5), "thin");
is("just under STAND_MIN_AVG is NOT green", reviewTone(STAND_MIN_AVG - eps, 5), "thin");
is("exactly STAND_MIN_AVG is green", reviewTone(STAND_MIN_AVG, 5), "ok");
is("above STAND_MIN_AVG is green", reviewTone(5, 12), "ok");
is("between the two is plain", reviewTone((ATTN_MAX_AVG + STAND_MIN_AVG) / 2, 9), "thin");

// ── COUNT DECIDES WHETHER A RATING EXISTS, never the average ────────────────────────────────────
// starRating comes back as 0 rather than null when nothing has been left. Testing the average
// would render a genuine 0.00 as "no reviews yet" — the one match that most needs looking at.
is("zero reviews is the none state", reviewTone(0, 0), "none");
is("A REAL 0.00 WITH REVIEWS IS RED, not 'none'", reviewTone(0, 4), "crit");
{
  const c = reviewCell({ avg: 0, count: 4, minsSinceEnd: 120 });
  is("...and it renders the number, not a dash", c.value, "0.00");
  yes("...and reports that it HAS a rating", c.hasRating);
}
{
  const c = reviewCell({ avg: 0, count: 0, minsSinceEnd: 120 });
  is("no reviews renders a dash", c.value, "—");
  yes("...and reports no rating", c.hasRating === false);
}
is("a negative count is treated as none", reviewTone(4, -1), "none");
is("a NaN count is treated as none", reviewTone(4, Number.NaN), "none");

// ── two decimals, always ────────────────────────────────────────────────────────────────────────
is("5 formats as 5.00", reviewValue(5), "5.00");
is("4.875 rounds to 4.88", reviewValue(4.875), "4.88");
is("3.333 renders 3.33", reviewValue(3.333), "3.33");
is("0 formats as 0.00", reviewValue(0), "0.00");

// ── PLURALS. "1 reviews" is exactly the kind of thing people notice. ────────────────────────────
is("one review is singular", reviewCountLabel(1), "1 review");
is("two reviews are plural", reviewCountLabel(2), "2 reviews");
is("twenty reviews are plural", reviewCountLabel(20), "20 reviews");
is("zero would be plural", reviewCountLabel(0), "0 reviews");

// ── ZERO REVIEWS IS A STATE, and the two states are different facts ─────────────────────────────
is("fresh reads as an age", reviewAgeLabel(8), "8m ago");
is("just under the hour is still an age", reviewAgeLabel(REVIEW_FRESH_MINUTES - 1), "59m ago");
is("at the hour it becomes an absence", reviewAgeLabel(REVIEW_FRESH_MINUTES), "none · 1h");
is("fourteen hours reads none · 14h", reviewAgeLabel(14 * 60), "none · 14h");
is("past two days it reads in days", reviewAgeLabel(50 * 60), "none · 2d");
is("a negative age does not go negative", reviewAgeLabel(-5), "0m ago");
yes("CONTROL: the two states really are different strings",
  reviewAgeLabel(8) !== reviewAgeLabel(14 * 60));

// ── the mock's own figures, end to end ──────────────────────────────────────────────────────────
// Real Sep 1 numbers from the Reviews page. If any of these change tone, the board has stopped
// agreeing with the page it is supposed to mirror.
const MOCK: [number, number, string, string, string][] = [
  [5.00, 3, "ok", "5.00", "3 reviews"],
  [4.50, 5, "thin", "4.50", "5 reviews"],
  [4.88, 8, "ok", "4.88", "8 reviews"],
  [3.33, 3, "crit", "3.33", "3 reviews"],
  [5.00, 1, "thin", "5.00", "1 review"],
  [2.50, 2, "thin", "2.50", "2 reviews"],
  [1.80, 15, "crit", "1.80", "15 reviews"],
  [4.45, 20, "thin", "4.45", "20 reviews"],
];
for (const [avg, n, tone, value, label] of MOCK) {
  const c = reviewCell({ avg, count: n, minsSinceEnd: 200 });
  is(`${avg}/${n} tone`, c.tone, tone);
  is(`${avg}/${n} value`, c.value, value);
  is(`${avg}/${n} label`, c.label, label);
}

console.log(`gameday-reviews: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of fails) console.log(`  FAILED: ${f}`); process.exit(1); }
