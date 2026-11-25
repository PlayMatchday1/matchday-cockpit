/* A FIELD'S LAUNCH DATE, for Finance › Cost's Field view (Ryan, 2026-11-25).
 *
 * THE VENUE RECORD WINS: fin_venues.launch_date when any of the field's venue legs has one (the
 * earliest, for a field split over several legs). Only when none does, the field's first match
 * that ran: not cancelled, not deleted, at least one player, kicked off by today, event fields
 * aside unless flagged regular play. That second date is the one the page already reads
 * (useRevenueTxn.loadVenueLaunches), so no new read.
 *
 * The two disagree on 7 venues (mirror, 2026-11-25): Onion Creek, ATH Pearland, Lou Fusz Outdoor
 * and Indoor, Westlake, Stony Point High School and Turf on. The record is shown on those as asked.
 *
 * launch_date is a DATE with no zone, and the first-match date is the match's LOCAL wall-clock day
 * (start_date's trailing Z is not UTC). Both are compared and counted as plain calendar days, never
 * through new Date(...) in a time zone. */

export type FieldLaunch = { ymd: string; from: "record" | "first match" };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function fieldLaunch(
  venueIds: readonly number[],
  recordOf: (venueId: number) => string | null | undefined,
  firstMatchOf: (venueId: number) => string | null | undefined,
): FieldLaunch | null {
  const pick = (f: (id: number) => string | null | undefined) =>
    venueIds.map((id) => (f(id) ?? "").slice(0, 10)).filter((d) => YMD.test(d)).sort()[0] ?? null;
  const rec = pick(recordOf);
  if (rec) return { ymd: rec, from: "record" };
  const first = pick(firstMatchOf);
  return first ? { ymd: first, from: "first match" } : null;
}

const dayNumber = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))) / 86_400_000;

/** Whole calendar days from `ymd` to `todayYmd`. Null for a launch still to come. */
export function daysOld(ymd: string, todayYmd: string): number | null {
  const n = dayNumber(todayYmd) - dayNumber(ymd);
  return n >= 0 ? n : null;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-21" → "Sep 21, 2026". */
export const launchLabel = (ymd: string) => `${MON[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;

/** The hover on a Launched cell: where the date came from. */
export const launchSource = (l: FieldLaunch) =>
  l.from === "record" ? "Launch date on the venue record" : "First match played here (the venue record has no launch date)";
