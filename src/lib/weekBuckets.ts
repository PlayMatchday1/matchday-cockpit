/* WEEKLY BUCKETS FOR PLAYER BEHAVIOR — pure. Nothing here fetches.
 *
 * ── MONDAY TO SUNDAY, THE ONE DEFINITION THIS ESTATE ALREADY HAS ──────────────────────────────
 * Master Schedule anchors on `weekMonday`, Manager Pay on `mondayOf`, and the lapsed-spots and
 * manager-pay week pickers both snap any date to its Monday. This is the same rule and NOT a
 * third one: a week is [Monday, Sunday] and its key is the Monday's YYYY-MM-DD.
 *
 * ── TWO DIFFERENT CLOCKS, AND THEY ARE NOT INTERCHANGEABLE ────────────────────────────────────
 * The two kinds of timestamp on this page are genuinely different and must be bucketed
 * differently. Getting this backwards is the whole hazard:
 *
 *   mdapi_users.completed_sign_up_at   TRUE UTC INSTANT. A signup at 03:36Z on the 1st happened at
 *                                      22:36 on the previous day in Chicago. Converted, via
 *                                      Intl in America/Chicago. See chicagoYmd.
 *   mdapi_matches.start_date           LOCAL WALL CLOCK carrying a Z it does not mean — it is
 *                                      already the time at the pitch. Converting it would shift a
 *                                      7pm match by the server's offset. SLICED, never parsed.
 *                                      See wallClockYmd.
 *
 * Using chicagoYmd on a match date, or wallClockYmd on a signup, both produce plausible numbers
 * and both are wrong. The two helpers are named for what they take, not for what they return.
 */

/** A TRUE UTC INSTANT → the calendar day it fell on in America/Chicago. */
export const chicagoYmd = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(iso));

/** A WALL-CLOCK STRING → its calendar day, by slicing. No Date is constructed. */
export const wallClockYmd = (s: string): string => String(s).slice(0, 10);

/* Calendar arithmetic on YYYY-MM-DD, done at UTC midnight. These are DATES, not instants — there
 * is no time-of-day left to shift, so a UTC Date here cannot move a day. */
const D = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const out = (d: Date) => d.toISOString().slice(0, 10);

/** ISO weekday, 1 = Monday … 7 = Sunday. */
export const isoDow = (ymd: string): number => ((D(ymd).getUTCDay() + 6) % 7) + 1;

/** The Monday of the week containing `ymd`. THE BUCKET KEY. */
export function weekKey(ymd: string): string {
  const d = D(ymd);
  d.setUTCDate(d.getUTCDate() - (isoDow(ymd) - 1));
  return out(d);
}

export function addWeeks(mondayYmd: string, n: number): string {
  const d = D(mondayYmd);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return out(d);
}

/**
 * The last `count` week keys ending with the week containing `todayYmd`, oldest first.
 * The CURRENT week is included and is partial by definition — the panel says so rather than
 * dropping it, because a missing current week reads as a collapse in signups.
 */
export function lastWeeks(todayYmd: string, count: number): string[] {
  const end = weekKey(todayYmd);
  return Array.from({ length: count }, (_, i) => addWeeks(end, i - (count - 1)));
}

/* ── THE LABEL ─────────────────────────────────────────────────────────────────────────────────
 * "Aug 24 – Aug 30", never "W35". A week number is a lookup the reader has to do in their head,
 * and ISO week numbering disagrees with every other week numbering anyone has met. */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (ymd: string) => `${MON[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}`;

/** The Sunday that closes the week. */
export const weekEnd = (mondayYmd: string): string => {
  const d = D(mondayYmd);
  d.setUTCDate(d.getUTCDate() + 6);
  return out(d);
};

/** "Aug 24 – Aug 30" — both ends named, so there is nothing to look up. */
export const weekRangeLabel = (mondayYmd: string): string =>
  `${dayLabel(mondayYmd)} – ${dayLabel(weekEnd(mondayYmd))}`;

/** A short axis tick — the Monday only, for a 13-point chart where both ends will not fit. */
export const weekTick = (mondayYmd: string): string => dayLabel(mondayYmd);

/* ── GRANULARITY ───────────────────────────────────────────────────────────────────────────────
 * The column that reads "MoM" monthly must not read "MoM" weekly — a change labelled month over
 * month showing a week over week delta is a number that means something other than what it says. */
export type Granularity = "monthly" | "weekly";
export const changeColumnLabel = (g: Granularity): string => (g === "weekly" ? "WoW" : "MoM");
export const changeColumnTitle = (g: Granularity): string =>
  g === "weekly" ? "Week over week — the last full week against the one before it"
    : "Month over month — the last month against the one before it";

/* ── THE PERIOD PICKER DRIVES THE WEEKLY WINDOW ────────────────────────────────────────────────
 * Behavior's weekly mode used to render a fixed "last 13 weeks" and ignore the page's period
 * picker entirely. That made the picker a control that looked live and did nothing — you could
 * move it to 2024 and the weekly chart would not flinch. These four helpers give weekly the same
 * window the monthly view already obeys.
 *
 * A WEEK IS IN THE WINDOW IF ITS MONDAY IS. Not "overlaps" — overlapping would drag in a leading
 * week that mostly belongs to the previous period, and the first column would then be a partial
 * that looks like a collapse. "Weeks BEGINNING in Mar 1 – Aug 31" is a rule a reader can hold, and
 * it is what the axis label says.
 *
 * Six months of Mondays is 26 or 27 weeks, not exactly 26 — months are not four weeks long. The
 * count is derived from the calendar, never assumed. */

export const addDays = (ymd: string, n: number): string => {
  const d = D(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return out(d);
};

/** First calendar day of a "YYYY-MM". */
export const monthStart = (ym: string): string => `${ym}-01`;

/** Last calendar day of a "YYYY-MM". Day 0 of the NEXT month is the last of this one. */
export const monthEnd = (ym: string): string => {
  const [y, m] = ym.split("-").map(Number);
  return out(new Date(Date.UTC(y, m, 0)));
};

/* THE CEILING, AND IT IS ANNOUNCED RATHER THAN APPLIED SILENTLY.
 * 53 covers every quick pill the period bar offers — "Last 12 months" is 52 or 53 Mondays. A
 * custom range longer than that produces a table with more columns than a screen has, so the axis
 * keeps the MOST RECENT 53 and returns how many it dropped. A silent truncation here would read
 * as "this is the whole period" when it is not; the panel renders the number. */
export const MAX_WEEKS = 53;

/**
 * The week keys whose Monday falls inside [start of `startYm`, end of `endYm`], oldest first,
 * with the count dropped from the FRONT if the range exceeds `max`.
 */
export function weeksInMonthRange(
  startYm: string,
  endYm: string,
  max: number = MAX_WEEKS,
): { axis: string[]; dropped: number } {
  const lo = monthStart(startYm);
  const hi = monthEnd(endYm);
  const all: string[] = [];
  // The first Monday ON OR AFTER lo. weekKey() looks backwards, so step forward when it lands short.
  let w = weekKey(lo);
  if (w < lo) w = addWeeks(w, 1);
  for (; w <= hi; w = addWeeks(w, 1)) all.push(w);
  // A range with no Monday in it cannot happen for a whole month (every month has four), but an
  // empty axis would render as a blank chart rather than an error, so it is never returned.
  if (all.length === 0) return { axis: [weekKey(lo)], dropped: 0 };
  if (all.length <= max) return { axis: all, dropped: 0 };
  return { axis: all.slice(all.length - max), dropped: all.length - max };
}

/* ── A PARTIAL BUCKET IS NOT A COLLAPSE ────────────────────────────────────────────────────────
 * The week containing today has had only some of its days happen. Rendered unmarked it looks like
 * every line falling off a cliff, and — far worse — it was what the "Latest WoW" badge measured
 * against: on 2026-09-01 the panel read −68.4%, −58.6%, −46.6%, −56.0% and −44.4%, every one of
 * them one day of data compared with seven.
 *
 * A WEEK IS COMPLETE WHEN ITS SUNDAY HAS PASSED. Not "when it has data" — a genuinely quiet week
 * that really did see two signups is complete and its −80% is a fact worth showing. The test is
 * the calendar, never the values, because a rule that skipped low weeks would hide real collapses.
 */

/** True when every day of the week has already happened, in the caller's clock. */
export const isWeekComplete = (mondayYmd: string, todayYmd: string): boolean =>
  weekEnd(mondayYmd) < todayYmd;

/**
 * Indices into `axis` of the last two COMPLETE buckets, for a change figure.
 * `null` when there are not two — a WoW that cannot be computed must be reported as absent, never
 * as 0%, which reads as "no change" rather than "no answer".
 */
export function lastTwoComplete(
  complete: readonly boolean[],
): { last: number; prev: number } | null {
  const idx: number[] = [];
  for (let i = complete.length - 1; i >= 0 && idx.length < 2; i--) if (complete[i]) idx.push(i);
  return idx.length === 2 ? { last: idx[0], prev: idx[1] } : null;
}

/** Today's date in America/Chicago — the clock every bucket on this page is cut in. */
export const chicagoToday = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
