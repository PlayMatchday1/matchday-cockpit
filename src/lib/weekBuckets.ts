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
