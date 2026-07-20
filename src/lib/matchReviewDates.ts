// Date helpers for Match Reviews. mdapi_matches carries two timestamps that
// MUST NOT be mixed:
//
//   start_date     — the venue-LOCAL wall-clock, stamped with a fake +00:00
//                    offset (e.g. "2026-07-20T21:00:00+00:00" is 9:00 PM
//                    local, NOT 21:00 UTC). Its date + time COMPONENTS are
//                    the values to DISPLAY, and its date is the "which day"
//                    for the rolling window.
//   start_date_utc — the TRUE UTC instant. Use this for any time COMPARISON
//                    (is the match in the future? inside the last-N-days
//                    boundary?).
//
// The classic off-by-a-day bug is taking the date from one and the
// time/comparison from the other — e.g. `new Date(start_date)` reads the fake
// +00:00 as real UTC and lands 5h early, so tonight's not-yet-played matches
// look past. Route every comparison through matchStartMs (start_date_utc) and
// every display through the wall-clock helpers here.

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// True UTC instant (ms) of a match. Prefer start_date_utc; fall back to
// start_date only if utc is missing (best-effort — start_date's offset is
// unreliable, but a value beats nothing). Returns null if neither parses.
export function matchStartMs(
  startDateUtc: string | null | undefined,
  startDate: string | null | undefined,
): number | null {
  const s = startDateUtc ?? startDate;
  if (!s) return null;
  const ms = new Date(s).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// A match can only carry genuine reviews after it has been played. True iff
// the match's real instant is at/before `nowMs`. This is the invariant that
// keeps future (recurring-series, phantom-rating) matches off the dashboard.
export function isPastMatch(
  startDateUtc: string | null | undefined,
  startDate: string | null | undefined,
  nowMs: number,
): boolean {
  const ms = matchStartMs(startDateUtc, startDate);
  return ms != null && ms <= nowMs;
}

// The venue-local calendar date ("YYYY-MM-DD") from start_date's wall-clock —
// the correct "which day" for grouping / the rolling window.
export function matchLocalDate(startDate: string | null | undefined): string {
  return (startDate ?? "").slice(0, 10);
}

// The venue-local year-month ("YYYY-MM") from start_date's wall-clock.
export function matchLocalMonth(startDate: string | null | undefined): string {
  return (startDate ?? "").slice(0, 7);
}

// "Jul 19 · 9:15 PM" — date AND time rendered together from start_date's
// wall-clock components, never split across timezones.
export function fmtMatchDateTime(startDate: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startDate ?? "");
  if (!m) return startDate ?? "";
  const [, , mo, d, hhS, mmS] = m;
  let hh = Number(hhS);
  const ampm = hh >= 12 ? "PM" : "AM";
  hh = hh % 12 === 0 ? 12 : hh % 12;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)} · ${hh}:${mmS} ${ampm}`;
}

// Local cutoff date ("YYYY-MM-DD") for a rolling last-`days`-days window that
// includes `now`'s local day. days=3 → today + the prior two days.
export function windowCutoffIso(now: Date, days: number): string {
  const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${c.getFullYear()}-${p(c.getMonth() + 1)}-${p(c.getDate())}`;
}
