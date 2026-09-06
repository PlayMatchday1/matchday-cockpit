/* RECENTLY UPLOADED — the Veo page's second axis.
 *
 * The page is indexed by the day a match was PLAYED. Films arrive on Veo's schedule, and measured
 * over every recording with a match day, that is not the same day: 18 arrived same-day, 46 next-day,
 * and four arrived two, three or five days later. A film that lands this morning for last Tuesday is
 * invisible on a page organised by Tuesday unless you already knew to go back and look — which is
 * exactly the thing you would be using this page to find out.
 *
 * TWO CLOCKS, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 *   HOW LATE THE FILM WAS   arrival minus the match's own day. Veo's clock. It is why the day view
 *                           could not find it. Same-day and next-day are the normal case and say
 *                           nothing; two or more days is the thing worth calling out.
 *
 *   HOW LONG IT HAS WAITED  today minus arrival, on a row that has not gone anywhere. OUR clock,
 *                           and the more consequential one: a film that arrived five days ago and
 *                           still sits queued is a match whose players never got their video.
 *
 * NO ETA, ANYWHERE. Nothing in this system knows Veo's processing time, and a predicted arrival on
 * this page would be read as a commitment.
 */

/* ── THE TRAP IN THE ARITHMETIC ────────────────────────────────────────────────────────────────
 * `received_at` is a TRUE INSTANT: an email landed. `start_date` is a WALL CLOCK WEARING A Z: 8pm
 * at the pitch. Subtracting one from the other is the same mistake that made a Saturday match read
 * as Sunday on the player pane.
 *
 * So the lag is computed on CALENDAR DAYS: render the arrival in one named zone, take its date, and
 * subtract the match's own local date. A few hours either side of midnight then cannot turn "4
 * days" into "3".
 *
 * THE ZONE IS AMERICA/CHICAGO, and the reason is that it is the zone the rest of this codebase
 * already decided on for "what day did this happen on" — promo dates display in it, and the Veo
 * matcher reads cancellation timestamps in it. Every venue except Warsaw is US Central or one hour
 * off it, and Warsaw has no veo_codes row, so no recording can arrive for it. A per-venue zone would
 * be more precise and would need a venue on rows that have no match, which is the case this list
 * exists to surface. One named zone, stated, beats a per-row guess. */
export const ARRIVAL_ZONE = "America/Chicago";

/** The calendar date of an instant, in a named zone. `en-CA` because it formats as YYYY-MM-DD. */
export function dayIn(iso: string | null | undefined, zone: string = ARRIVAL_ZONE): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString("en-CA", { timeZone: zone });
}

const daysBetween = (fromYmd: string, toYmd: string): number =>
  Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);

/** Whole days between the match's own day and the day the film arrived. Never negative: a film that
 *  arrives before the match day is not "-1 days late", it is same-day. */
export function lagDays(receivedAt: string | null, matchDay: string | null): number | null {
  const arrived = dayIn(receivedAt);
  if (!arrived || !matchDay) return null;
  return Math.max(0, daysBetween(matchDay.slice(0, 10), arrived));
}

export function lagLabel(days: number | null): string | null {
  if (days == null) return null;
  if (days <= 0) return "same day";
  if (days === 1) return "next day";
  return `${days} days late`;
}

/** Same-day and next-day are the normal case and earn no room on the row. */
export const lagWorthSaying = (days: number | null): boolean => days != null && days >= 2;

/** Days a film has been sitting unresolved. OUR clock — only meaningful on a row nobody has acted on. */
export function waitDays(receivedAt: string | null, nowMs: number = Date.now()): number | null {
  const arrived = dayIn(receivedAt);
  if (!arrived) return null;
  const today = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: ARRIVAL_ZONE });
  return Math.max(0, daysBetween(arrived, today));
}

export function waitLabel(days: number | null): string | null {
  if (days == null) return null;
  if (days <= 0) return "waiting since today";
  if (days === 1) return "waiting 1 day";
  return `waiting ${days} days`;
}

/** Red once a film has sat for days. Two is not a crisis; three is a match whose players never got it. */
export const WAIT_ALARM_DAYS = 3;

/* ── THE FIVE STATES ───────────────────────────────────────────────────────────────────────────
 * ASSIGNED BY HAND IS NOT POSTED, the same rule the day tallies keep. Folding them together is what
 * made "posted went 16 to 15" unreadable — seven of that sixteen were people — and it would make
 * the matcher's hit rate unmeasurable from this section too. */
export type RecentState = "posted" | "flagged" | "assigned" | "queued" | "dismissed";

export const RECENT_STATE_LABEL: Record<RecentState, string> = {
  posted: "Posted",
  flagged: "Posted, flagged",
  assigned: "Assigned by hand",
  queued: "Queued",
  dismissed: "Dismissed",
};

export type RecentTone = "ok" | "flag" | "hand" | "look" | "none";
export const RECENT_STATE_TONE: Record<RecentState, RecentTone> = {
  posted: "ok", flagged: "flag", assigned: "hand", queued: "look", dismissed: "none",
};

/** A row nobody needs to act on. The waiting clock is meaningless on these, and Assign is absent. */
export const isResolved = (s: RecentState): boolean => s !== "queued";

export type RecentRowInput = {
  status: "posted" | "queued" | "dismissed";
  flagged: boolean;
  postedByUserId: string | null;
};

export function recentState(r: RecentRowInput): RecentState {
  if (r.status === "dismissed") return "dismissed";
  if (r.status === "posted") {
    if (r.postedByUserId) return "assigned";
    return r.flagged ? "flagged" : "posted";
  }
  return "queued";
}

/* ── WHERE THE MATCH DAY CAME FROM ─────────────────────────────────────────────────────────────
 * A matched recording has a real match with a real day. An unmatched one has only
 * `parsed_match_date` — THE MATCHER'S READING OF A TITLE, which may be wrong, and demonstrably is:
 * one live row reads 365 days late because its title's year resolved to the prior year. A guess
 * must not be presented with the confidence of a fact, so the row says where the day came from. */
export type DaySource = "match" | "title" | "unknown";

export function daySourceOf(matchDay: string | null, parsedMatchDate: string | null): DaySource {
  if (matchDay) return "match";
  if (parsedMatchDate) return "title";
  return "unknown";
}
