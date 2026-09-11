// City Manager Check-In — shared domain logic for the PUBLIC form.
//
// Same split as src/lib/inventory.ts: this file holds the write-path pieces (the question list, the
// server-side validation and the honeypot), so the route and the page agree on one definition and
// the tests can exercise the refusals without a browser.
//
// THE RATE LIMITER IS IMPORTED FROM lib/inventory RATHER THAN COPIED. checkRateLimit is a pure
// sliding window with the clock and the store injected — nothing about it is inventory-specific,
// and a second hand-copied window is a second thing to get wrong. The BRIEF'S "copy the pattern,
// do not refactor the original" is respected: lib/inventory is untouched, /inventory keeps its own
// store, and nothing was hoisted into a shared module. If a third public form appears, these
// guards should move to a publicFormGuards.ts and both callers should follow — see the report.

import { CITY_SCOPES, resolveCityScope } from "./cityScope";
import { MANAGERS } from "./checkIns";

export { checkRateLimit, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, type RateLimitStore } from "./inventory";

/* THE QUESTIONS, ONCE, IN THE ORDER THE CARD READS THEM. The page renders this list and the
 * validator caps this list, so a question cannot exist on the form without a cap or be capped
 * without being asked.
 *
 * ── ORDER ────────────────────────────────────────────────────────────────────────────────────
 * Ryan: "it should reorder based on how it shows in check in." CheckInsStatusCard renders
 *   rating -> win -> challenge -> focus -> fields contacted (+list) -> field progress ->
 *   match manager -> marketing channels -> marketing results
 * and this list used to be close to the reverse of that: the three answers anyone actually reads
 * were last, under six boxes about fields. scripts/check-in-form-test.ts asserts this array
 * against the ORDER SCRAPED FROM THE CARD COMPONENT rather than a second copy of it, so the two
 * cannot drift apart again.
 *
 * ── HINTS ARE CONTENT ON A FORM, AND THIS REVERSES AN EARLIER RULE ───────────────────────────
 * The last build stripped every hint from /check-in under "no explainer copy". That rule is right
 * for a DASHBOARD, where a caption explains something the reader is already looking at — Ryan has
 * had that removed from five surfaces. It is wrong for a FORM, where the hint IS THE SPECIFICATION
 * OF THE ANSWER: "N/A if this is not an active goal for your city" is what tells a manager to type
 * N/A instead of leaving the box empty, and the card renders blank and "N/A" differently.
 *
 * What still does not belong, and must not come back: a subtitle explaining what a check-in is, a
 * note about who reads it, a confirmation paragraph, anything about the form being public.
 *
 * ── THE CADENCE IS MONTHLY, AND THE GOOGLE FORM'S OWN COPY IS WRONG ──────────────────────────
 * The Sheet says "week" throughout — "Overall Weekly Rating", "contacted this week", "from this
 * week" — while the questions under those headers say "of the month" and "for next month". The
 * hints below are carried across; the cadence is not. Everything here says month. */
export type CheckInSection = {
  key: string;
  title: string;
  /* ONE LINE PER SECTION saying WHAT TO REPORT. Not what a check-in is. */
  blurb: string;
};

export const CHECK_IN_SECTIONS: readonly CheckInSection[] = [
  { key: "rating", title: "How the month went", blurb: "Against the goals we set for your city this month." },
  { key: "wins", title: "Wins, challenges, next month", blurb: "The three we read first on the Monday call." },
  { key: "fields", title: "Fields", blurb: "New outreach and the relationships you moved forward." },
  { key: "team", title: "Match managers and marketing", blurb: "Your team, and what you did to grow the player base." },
] as const;

export type CheckInQuestion = {
  key: CheckInTextKey;
  label: string;
  hint?: string;
  section: string;
  kind: "short" | "long";
  max: number;
};

export type CheckInTextKey =
  | "fields_contacted"
  | "fields_list"
  | "field_progress"
  | "match_manager"
  | "marketing_channels"
  | "marketing_results"
  | "win"
  | "challenge"
  | "focus";

export const MAX_NAME_LEN = 120;
export const MAX_LONG_LEN = 4000;
export const MAX_SHORT_LEN = 200;

export const CHECK_IN_QUESTIONS: readonly CheckInQuestion[] = [
  // ── the three the card reads first ──
  { key: "win", label: "Biggest win of the month", section: "wins", kind: "long", max: MAX_LONG_LEN },
  { key: "challenge", label: "Biggest challenge of the month", section: "wins", kind: "long", max: MAX_LONG_LEN },
  { key: "focus", label: "Primary focus for next month", section: "wins", kind: "long", max: MAX_LONG_LEN,
    hint: "What you want support on, and the priorities you are working to." },
  // ── fields ──
  { key: "fields_contacted", label: "Number of new fields contacted", section: "fields", kind: "short", max: MAX_SHORT_LEN,
    hint: "N/A if this is not an active goal for your city." },
  { key: "fields_list", label: "List of fields contacted", section: "fields", kind: "long", max: MAX_LONG_LEN,
    hint: "Name and location. N/A if none." },
  { key: "field_progress", label: "Progress on field relationships", section: "fields", kind: "long", max: MAX_LONG_LEN,
    hint: "Conversations, outcomes and next steps. Includes check-ins on fields we already use." },
  // ── team and marketing ──
  { key: "match_manager", label: "Match manager team status", section: "team", kind: "long", max: MAX_LONG_LEN,
    hint: "How is the team doing? Do you need more? Anyone excelling?" },
  { key: "marketing_channels", label: "Grassroots and marketing efforts", section: "team", kind: "long", max: MAX_LONG_LEN,
    hint: "What you did, and where." },
  { key: "marketing_results", label: "Results from those efforts", section: "team", kind: "long", max: MAX_LONG_LEN,
    hint: "Response you got, and next steps." },
] as const;

/* THE SELECT'S OPTIONS, AND THE ALLOWLIST, ARE THE SAME LIST. Value is the city_identifier, label
 * is the display name — so the stored value is a join key and the manager still reads "Houston".
 * The standard scope list, deliberately, NOT the cities in MANAGERS: a new city must be able to
 * file before anyone remembers to add its manager to that array. */
export const CHECK_IN_CITY_OPTIONS = CITY_SCOPES;

/* 1-5, AND THE SCALE IS NOT INVENTED. The Google Form's own column header declares it: "Overall
 * Weekly Rating (1-5) (Linear scale: 1 = Poor, 5 = Excellent)". Measured across all twelve
 * submissions on the published CSV, 2026-09-11: integers only, distinct values [3, 4, 5] — the
 * data never used 1 or 2, but the scale is the header's, not the observed range's.
 *
 * FIVE VISIBLE TILES, NOT A <select>. A dropdown on a phone is a tap, a scroll and a second tap,
 * and it never says which end is good — the Google Form's scale is anchored and this one is too.
 * A closed set is still the control that matters: the old free-text path is what let checkIns.ts
 * fall back to 0 on a bare parseFloat. The route and the DB CHECK refuse an out-of-range value
 * anyway if a payload is hand-made. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATING_OPTIONS = [1, 2, 3, 4, 5] as const;
/* The Google Form's own anchors, verbatim from its header: "1 = Poor, 5 = Excellent". */
export const RATING_ANCHOR_LOW = "Poor";
export const RATING_ANCHOR_HIGH = "Excellent";

export type CityCheckInInput = {
  /* NOT ASKED FOR AND NOT ACCEPTED FROM THE CLIENT. Kept on the type only so an old cached page
   * POSTing one is explicitly IGNORED rather than silently spread into the row — validate() builds
   * the row field by field and never copies this. The route fills manager_name from MANAGERS. */
  manager_name?: unknown;
  city_identifier?: unknown;
  month_ending?: unknown;
  rating?: unknown;
  // Honeypot — a hidden field real users never fill. Any value here means a bot.
  website?: unknown;
} & Partial<Record<CheckInTextKey, unknown>>;

export type CityCheckInRow = {
  /* NULL when no manager is on file for that city — Warsaw today. Filled by the route, never by
   * the form. See migration 0169. */
  manager_name: string | null;
  city_identifier: string;
  month_ending: string; // YYYY-MM-DD
  rating: number;
} & Record<CheckInTextKey, string | null>;

export type CheckInValidation =
  | { ok: true; value: CityCheckInRow }
  | { ok: false; error: string };

export function isHoneypotTripped(input: CityCheckInInput): boolean {
  return typeof input.website === "string" && input.website.trim() !== "";
}


/* A REAL CALENDAR DATE, NOT JUST A WELL-SHAPED STRING. "2026-02-31" passes a regex and is not a
 * day; Date would roll it to 2 March and store a month the manager did not pick. Round-tripping
 * through toISOString and comparing is the cheapest way to reject that. UTC throughout — this is a
 * date, not a moment, and constructing it locally shifts it a day either side of midnight. */
export function parseMonthEnding(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.toISOString().slice(0, 10) !== s) return null;
  // A check-in for the year 3000 is a bad payload, not a check-in.
  if (y < 2020 || y > new Date().getUTCFullYear() + 1) return null;
  return s;
}

export function validateCityCheckIn(input: CityCheckInInput): CheckInValidation {
  /* NO NAME QUESTION. Ryan filed as "Ryan Mancuso" for Austin and the card said "Garrett Suits",
   * because the card's title is MANAGERS[].name keyed on cityId and manager_name was never read.
   * The city is the identity. The route sets manager_name from MANAGERS after this returns; it is
   * deliberately NOT taken from `input`, so a hand-made payload cannot put a name on a row. */
  /* ONE LIST *AND* ONE MATCHER. This used to trim the input and then test membership itself — a
   * second matcher beside cityScope.ts's, which is the exact duplication that migration 0168's
   * reasoning is about. resolveCityScope is EXACT match by design ("no trimming, no upper-casing —
   * a value that needs correcting is a value someone typed"), and it returns the canonical ROW, so
   * what gets stored is what the list says rather than what the caller sent. The form's select
   * emits a bare identifier, so nothing legitimate is turned away.
   *
   * THIS IS THE GUARANTEE THE DROPPED CHECK CONSTRAINT USED TO HOLD (0168), and it is now the only
   * one — which is why scripts/check-in-form-test.ts derives its accepted set from CITY_SCOPES. */
  if (typeof input.city_identifier !== "string" || !input.city_identifier)
    return { ok: false, error: "City is required." };
  const scope = resolveCityScope(input.city_identifier);
  if (!scope) return { ok: false, error: "Unrecognized city." };
  const city = scope.identifier;

  const month = parseMonthEnding(input.month_ending);
  if (!month) return { ok: false, error: "Month ending is required." };

  const ratingRaw = input.rating;
  const rating =
    typeof ratingRaw === "number" ? ratingRaw
    : typeof ratingRaw === "string" && /^\d+$/.test(ratingRaw.trim()) ? Number(ratingRaw.trim())
    : NaN;
  if (!Number.isInteger(rating) || rating < RATING_MIN || rating > RATING_MAX) {
    return { ok: false, error: `Overall rating must be a whole number from ${RATING_MIN} to ${RATING_MAX}.` };
  }

  const text = {} as Record<CheckInTextKey, string | null>;
  for (const q of CHECK_IN_QUESTIONS) {
    const raw = input[q.key];
    if (raw == null) { text[q.key] = null; continue; }
    if (typeof raw !== "string") return { ok: false, error: `${q.label} must be text.` };
    const t = raw.trim();
    if (t.length > q.max) {
      return { ok: false, error: `${q.label} must be ${q.max} characters or fewer.` };
    }
    text[q.key] = t || null;
  }

  return {
    ok: true,
    value: { manager_name: null, city_identifier: city, month_ending: month, rating, ...text },
  };
}

/* WHO IS FILING, RESOLVED FROM THE CITY. Used twice: the route stamps it onto the row as an audit
 * field, and the public page shows it back under the city select so a wrong city is caught before
 * submit rather than on a card a week later.
 *
 * NULL IS A REAL ANSWER. cityScope carries WAW and MANAGERS does not, so Warsaw resolves to
 * nobody — and must still be able to file. The page says so in words rather than rendering blank
 * or guessing. */
export function managerNameForCity(cityIdentifier: string): string | null {
  return MANAGERS.find((m) => m.cityId === cityIdentifier)?.name ?? null;
}

/* THE MONTH JUST COMPLETED, which is what a check-in is almost always about and so is what the
 * field defaults to. Returns the LAST DAY of the previous month — the Sheet's own values are month
 * ends ("3/31/2026", "4/30/2026"), and a default of "today" would file September's form against a
 * month still running. Local-time construction is correct here: it is answering "what month is it
 * for this person", not stamping an instant. */
export function defaultMonthEnding(today: Date): string {
  const lastOfPrev = new Date(today.getFullYear(), today.getMonth(), 0);
  const y = lastOfPrev.getFullYear();
  const m = String(lastOfPrev.getMonth() + 1).padStart(2, "0");
  const d = String(lastOfPrev.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
