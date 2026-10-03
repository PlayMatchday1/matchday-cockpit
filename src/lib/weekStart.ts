// THE WEEK STARTS ON SUNDAY — for the OpEx calendar and the Master Schedule (Ryan, 2026-10-03).
//
// ONE constant, read by both pages: the OpEx calendar's columns, week rows, week totals and ledger
// week groups; the Master Schedule's month grid, its week view (sent to /api/veo and
// /api/veo/resync as ?ws=), its header labels and its arrows. Other pages keep the Monday week they
// already have: Match Promotion, the Veo dashboard and Manager Pay call the same helpers WITHOUT
// this constant and get Monday, unchanged.
//
// Numbering is JavaScript's getDay(): 0 = Sunday … 6 = Saturday.

export const WEEK_START = 0;

export const DAY3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The seven column labels, first day of the week first. */
export const weekdayHeaders = (ws: number = WEEK_START): string[] =>
  Array.from({ length: 7 }, (_, i) => DAY3[(ws + i) % 7]);

/** How many days `jsDay` (getDay()) is after the start of its week. */
export const daysIntoWeek = (jsDay: number, ws: number = WEEK_START): number => (jsDay - ws + 7) % 7;

/** Is column `i` of a week row a Saturday or a Sunday? */
export const isWeekendColumn = (i: number, ws: number = WEEK_START): boolean => {
  const d = (ws + i) % 7;
  return d === 0 || d === 6;
};

/** The first day of the week containing `date`, as a LOCAL date at midnight. */
export function weekStartOf(date: Date, ws: number = WEEK_START): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysIntoWeek(date.getDay(), ws));
}

/* ── CALENDAR DATES AS YYYY-MM-DD STRINGS (the Master Schedule month grid). Parsed at UTC midnight:
 * a calendar bound, not an instant, so the server's offset cannot shift it a day. */
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const shiftIso = (iso: string, n: number) => { const d = D(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** The first day of the week on or before `iso`. */
export const weekStartOnOrBefore = (iso: string, ws: number = WEEK_START): string =>
  shiftIso(iso, -daysIntoWeek(D(iso).getUTCDay(), ws));

/** The last day of the week on or after `iso`. */
export const weekEndOnOrAfter = (iso: string, ws: number = WEEK_START): string =>
  shiftIso(iso, 6 - daysIntoWeek(D(iso).getUTCDay(), ws));

/* ── ONE MONTH AS WEEK ROWS (the OpEx calendar) ──────────────────────────────────────────────── */
export type MonthLayout = {
  /** Blank leading cells before day 1 (days of the previous month). */
  lead: number;
  days: number;
  /** Number of week rows. */
  weeks: number;
  /** The row (0-based) that day `d` of the month sits in. */
  weekOf: (d: number) => number;
  /** The first and last day of the month in row `w` (clamped to the month). */
  rangeOf: (w: number) => [number, number];
};

export function monthLayout(year: number, month0: number, ws: number = WEEK_START): MonthLayout {
  const days = new Date(year, month0 + 1, 0).getDate();
  const lead = daysIntoWeek(new Date(year, month0, 1).getDay(), ws);
  const weekOf = (d: number) => Math.floor((d - 1 + lead) / 7);
  return {
    lead,
    days,
    weeks: Math.ceil((lead + days) / 7),
    weekOf,
    rangeOf: (w) => [Math.max(1, w * 7 - lead + 1), Math.min(days, w * 7 - lead + 7)],
  };
}
