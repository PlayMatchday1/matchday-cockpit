/* THE FUNNEL'S NOTION OF "NOW", CLAMPED TO THE BUSINESS CALENDAR.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 * PlayerFunnel called the LAST MONTH ON THE AXIS the current month, and the axis is
 *
 *   behaviorAxis = monthRange(floor, max(nowMonth, last(playMonths)))      growthFromViews.ts:270
 *
 * where playMonths comes from growth_play_dims.match_month. THAT VIEW CARRIES BOOKED MATCHES, NOT
 * PLAYED ONES. Matches are booked weeks ahead, so the axis runs into the future and the top row of
 * the funnel was a month that has not happened. Measured on prod 2026-09-27: 43 months, 2023-04 to
 * 2026-10, with Chicago in 2026-09 - so the axis ended one month out and the funnel called 2026-10
 * current.
 *
 * IT IS NOT AN OFF-BY-ONE AND NOT A RELABEL. Nothing beneath the top row shifts: the axis gains a
 * trailing month, it does not renumber. The row labelled "previous month" held real September data
 * while the row above it was a phantom. A fix that only renamed the top row would leave the second
 * row on September, which is exactly what separates this from a cosmetic patch.
 *
 * AND THE CEILING MOVES WITH THE BOOKING HORIZON rather than sitting one month out. The furthest
 * booked match sets it, so it would read two months out the day a November match is booked. That is
 * why the clamp is to THE CALENDAR and not to the data: there is no offset to subtract.
 *
 * ── FIXED HERE, NOT IN THE AXIS ──────────────────────────────────────────────────────────────
 * behaviorAxis has other readers, BehaviorPanel among them, and a future month may be wanted there.
 * So the axis is untouched and the funnel clamps its own notion of current.
 *
 * ── AND CLAMPED IN THE BUSINESS TIMEZONE ─────────────────────────────────────────────────────
 * On the 1st of a month a UTC runtime is already in the new month while Chicago is still in the old
 * one. Clamping against a UTC month would then permit a month Chicago has not reached, which is one
 * wrong day a month and the hardest kind to notice. This is the identical defect the 2026 Daily
 * Matches divisor had, where "days elapsed" counted in UTC against matches counted locally.
 */
import { BUSINESS_TZ, wallClockPartsInZone } from "./businessHours";

/** YYYY-MM for an instant, in the business timezone. DST-aware via Intl, never a fixed offset. */
export function businessMonthKey(at: Date = new Date(), tz: string = BUSINESS_TZ): string {
  const p = wallClockPartsInZone(at.getTime(), tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

/**
 * The months the funnel may show: the axis, with anything after the current business month dropped.
 *
 * MONTH KEYS COMPARE AS STRINGS because YYYY-MM is zero-padded and lexicographic order is calendar
 * order. No Date is constructed from them, which is the trap that re-shifts a calendar month through
 * a timezone it never had.
 *
 * AN EMPTY RESULT IS NOT POSSIBLE while the axis holds any month at or before now. If every month on
 * the axis is in the future - which would mean no registrations and no played matches ever - the
 * caller gets an empty list and should render nothing rather than a phantom row.
 */
export function clampMonthsToNow(months: readonly string[], at: Date = new Date()): string[] {
  const now = businessMonthKey(at);
  return months.filter((m) => m <= now);
}

/** The month the funnel calls "current": the latest real month, never a booked future one. */
export function currentFunnelMonth(months: readonly string[], at: Date = new Date()): string | null {
  const ok = clampMonthsToNow(months, at);
  return ok.length ? ok[ok.length - 1] : null;
}
