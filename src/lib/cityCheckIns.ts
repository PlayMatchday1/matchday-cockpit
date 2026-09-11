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

export { checkRateLimit, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, type RateLimitStore } from "./inventory";

/* THE QUESTIONS, ONCE. The page renders this list and the validator caps this list, so a question
 * cannot exist on the form without a cap or be capped without being asked.
 *
 * `label` IS THE ONLY PROSE ON THE PAGE. No subtitle, no hints, no legend — the question text
 * carries the whole meaning. Where the Sheet's wording explained the scale or listed example
 * answers in the header, that explanation is dropped rather than reproduced. */
export type CheckInQuestion = {
  key: CheckInTextKey;
  label: string;
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
  { key: "fields_contacted", label: "New fields contacted", kind: "short", max: MAX_SHORT_LEN },
  { key: "fields_list", label: "List of fields", kind: "long", max: MAX_LONG_LEN },
  { key: "field_progress", label: "Field relationship progress", kind: "long", max: MAX_LONG_LEN },
  { key: "match_manager", label: "Match manager update", kind: "long", max: MAX_LONG_LEN },
  { key: "marketing_channels", label: "Grassroots / marketing efforts", kind: "long", max: MAX_LONG_LEN },
  { key: "marketing_results", label: "Results from marketing", kind: "long", max: MAX_LONG_LEN },
  { key: "win", label: "Biggest win", kind: "long", max: MAX_LONG_LEN },
  { key: "challenge", label: "Biggest challenge", kind: "long", max: MAX_LONG_LEN },
  { key: "focus", label: "Primary focus for next month", kind: "long", max: MAX_LONG_LEN },
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
 * A SELECT IS THE CONTROL. A free number box is the thing that let checkIns.ts:302 fall back to 0
 * on a bare parseFloat; five options cannot produce an absurd value in the first place, and the
 * route and a CHECK constraint refuse one anyway if a payload is hand-made. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATING_OPTIONS = [1, 2, 3, 4, 5] as const;

export type CityCheckInInput = {
  manager_name?: unknown;
  city_identifier?: unknown;
  month_ending?: unknown;
  rating?: unknown;
  // Honeypot — a hidden field real users never fill. Any value here means a bot.
  website?: unknown;
} & Partial<Record<CheckInTextKey, unknown>>;

export type CityCheckInRow = {
  manager_name: string;
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
  const name = typeof input.manager_name === "string" ? input.manager_name.trim() : "";
  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > MAX_NAME_LEN) {
    return { ok: false, error: `Name must be ${MAX_NAME_LEN} characters or fewer.` };
  }

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
    value: { manager_name: name, city_identifier: city, month_ending: month, rating, ...text },
  };
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
