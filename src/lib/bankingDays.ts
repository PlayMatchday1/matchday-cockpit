// US Federal Reserve banking-day math for estimating when manager pay lands.
//
// ACH does not settle on weekends OR Fed holidays, so "4 banking days after the
// pay run" is NOT "4 calendar days" and NOT a fixed "8 days after the Sunday" —
// it must skip weekends and holidays as it counts. Worked cases (see tests):
//   Sun 2026-08-02 → run Tue 08-04 → arrival Mon 08-10 (8 days after the Sunday)
//   Sun 2026-08-30 → run Tue 09-01 → arrival Tue 09-08 (9 days — Labor Day Mon 09-07)
//
// All math is in UTC on date-only values (anchored at midday to dodge DST/TZ edges).

const DAY = 86_400_000;
const WEEKEND = new Set([0, 6]); // Sun, Sat

function utc(y: number, m0: number, d: number): Date { return new Date(Date.UTC(y, m0, d, 12)); }
function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function parseISO(s: string): Date { const [y, m, d] = s.split("-").map(Number); return utc(y, m - 1, d); }
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * DAY); }

// nth (1..5) weekday (0=Sun..6=Sat) of a month; and the last such weekday.
function nthWeekday(y: number, m0: number, weekday: number, n: number): Date {
  const first = utc(y, m0, 1);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return utc(y, m0, 1 + shift + (n - 1) * 7);
}
function lastWeekday(y: number, m0: number, weekday: number): Date {
  const last = utc(y, m0 + 1, 0); // day 0 of next month = last day of this month
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return utc(y, m0, last.getUTCDate() - shift);
}
// Federal observation rule: a holiday on Saturday is observed the Friday before,
// on Sunday the Monday after; otherwise the day itself.
function observed(d: Date): Date {
  const wd = d.getUTCDay();
  if (wd === 6) return addDays(d, -1);
  if (wd === 0) return addDays(d, 1);
  return d;
}

// ── THE HOLIDAY LIST, in one place, as rules for the 11 Federal Reserve holidays.
// Encoded as rules (fixed date + observation, or nth/last weekday) rather than
// typed dates, so a covered year is always correct — but coverage is BOUNDED
// below, and an uncovered year THROWS instead of silently returning a wrong date.
function fedHolidayDates(year: number): Date[] {
  return [
    observed(utc(year, 0, 1)),   // New Year's Day        — Jan 1
    nthWeekday(year, 0, 1, 3),   // Birthday of MLK Jr.   — 3rd Mon Jan
    nthWeekday(year, 1, 1, 3),   // Washington's Birthday — 3rd Mon Feb (Presidents Day)
    lastWeekday(year, 4, 1),     // Memorial Day          — last Mon May
    observed(utc(year, 5, 19)),  // Juneteenth            — Jun 19
    observed(utc(year, 6, 4)),   // Independence Day      — Jul 4
    nthWeekday(year, 8, 1, 1),   // Labor Day             — 1st Mon Sep
    nthWeekday(year, 9, 1, 2),   // Columbus Day          — 2nd Mon Oct
    observed(utc(year, 10, 11)), // Veterans Day          — Nov 11
    nthWeekday(year, 10, 4, 4),  // Thanksgiving          — 4th Thu Nov
    observed(utc(year, 11, 25)), // Christmas Day         — Dec 25
  ];
}

// ── COVERAGE — extend `to` each year (and re-verify the list against
// federalreserve.gov). Outside this range the functions below THROW; a stale
// table must fail loudly, never hand back a confidently-wrong date. ──
export const FED_HOLIDAY_COVERAGE = { from: 2025, to: 2027 } as const;

const cache = new Map<number, Set<string>>();
function holidaySet(year: number): Set<string> {
  let s = cache.get(year);
  if (!s) { s = new Set(fedHolidayDates(year).map(iso)); cache.set(year, s); }
  return s;
}
function assertCovered(year: number): void {
  if (year < FED_HOLIDAY_COVERAGE.from || year > FED_HOLIDAY_COVERAGE.to) {
    throw new Error(
      `Fed holiday table covers ${FED_HOLIDAY_COVERAGE.from}–${FED_HOLIDAY_COVERAGE.to} only; ` +
      `year ${year} is outside it. Extend FED_HOLIDAY_COVERAGE in src/lib/bankingDays.ts.`,
    );
  }
}

export function fedHolidaysObserved(year: number): string[] {
  assertCovered(year);
  return [...holidaySet(year)].sort();
}
export function isBankingDay(d: Date): boolean {
  if (WEEKEND.has(d.getUTCDay())) return false;
  assertCovered(d.getUTCFullYear());
  return !holidaySet(d.getUTCFullYear()).has(iso(d));
}
// n banking days strictly AFTER d (the start day is never counted).
function addBankingDays(d: Date, n: number): Date {
  let x = d, counted = 0;
  while (counted < n) { x = addDays(x, 1); if (isBankingDay(x)) counted++; }
  return x;
}

// The pay run: the Tuesday after the week's Sunday. If that Tuesday is itself a
// Fed holiday, the run moves to the next banking day and the count starts there.
export function payRunDate(weekSundayISO: string): string {
  const sunday = parseISO(weekSundayISO);
  let run = addDays(sunday, 2); // Sunday + 2 = Tuesday
  while (!isBankingDay(run)) run = addDays(run, 1);
  return iso(run);
}
// Estimated arrival: 4 banking days after the pay run.
export const ARRIVAL_BANKING_DAYS = 4;
export function estimatedArrival(weekSundayISO: string): string {
  const run = parseISO(payRunDate(weekSundayISO));
  return iso(addBankingDays(run, ARRIVAL_BANKING_DAYS));
}
