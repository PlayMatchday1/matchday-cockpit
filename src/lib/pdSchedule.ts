// Pure date helpers for the P&D (Presence & Direction) weekend roster.
//
// THE DATE TRAP: pd_assignments.weekend_start is a SQL `date`. Passing a
// date-only string to `new Date("2026-08-01")` parses it as UTC midnight, which
// is the *previous* day in Central — every weekend would render a day early and
// look plausible. So: weekend_start values are kept as "YYYY-MM-DD" strings and
// never fed to `new Date(string)`. Month iteration builds dates from explicit
// (year, month, day) parts; the formatter works purely on string parts +
// Date.UTC (reading UTC fields), so its output is identical under any TZ.

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function ymd(year: number, month0: number, day: number): string {
  return `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Add `days` to a YYYY-MM-DD string via Date.UTC (tz-independent), returning
// explicit parts. Never touches local time.
function shiftYmd(dateYmd: string, days: number): { y: number; m0: number; d: number } {
  const [y, m, d] = dateYmd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m0: t.getUTCMonth(), d: t.getUTCDate() };
}

export type Weekend = {
  satYmd: string; // Saturday — the DB primary key (weekend_start)
  sunYmd: string; // the paired Sunday (may fall in the next month)
  label: string; // "Aug 29 – Aug 30" / "Aug 29 – Sep 1"
};

// "Aug 29 – Aug 30" from a Saturday YYYY-MM-DD. tz-independent — this is the
// function report item 10 runs under TZ=America/Chicago and TZ=UTC.
export function formatWeekendRange(satYmd: string): string {
  const [, sm, sd] = satYmd.split("-").map(Number);
  const sun = shiftYmd(satYmd, 1);
  return `${SHORT_MONTHS[sm - 1]} ${sd} – ${SHORT_MONTHS[sun.m0]} ${sun.d}`;
}

// Every weekend whose SATURDAY falls in (year, month0). Built from explicit
// parts, mirroring `weekendsOf` in the mockup. The Sunday may spill into the
// next month (Aug 29–30 is a valid August weekend).
export function weekendsOf(year: number, month0: number): Weekend[] {
  const out: Weekend[] = [];
  const cursor = new Date(year, month0, 1); // from parts — safe
  while (cursor.getMonth() === month0) {
    if (cursor.getDay() === 6) {
      const satYmd = ymd(cursor.getFullYear(), cursor.getMonth(), cursor.getDate());
      const sun = shiftYmd(satYmd, 1);
      out.push({ satYmd, sunYmd: ymd(sun.y, sun.m0, sun.d), label: formatWeekendRange(satYmd) });
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export type WeekendState = "past" | "this" | "future";

// Classify a weekend relative to `today` (YYYY-MM-DD). String comparison is
// correct for this format. A weekend is past once its Sunday is before today;
// the first non-past weekend is "this weekend".
export function classifyWeekends(
  weekends: Weekend[],
  today: string,
): { weekend: Weekend; state: WeekendState }[] {
  let firstUpcomingAssigned = false;
  return weekends.map((w) => {
    if (w.sunYmd < today) return { weekend: w, state: "past" as const };
    if (!firstUpcomingAssigned) {
      firstUpcomingAssigned = true;
      return { weekend: w, state: "this" as const };
    }
    return { weekend: w, state: "future" as const };
  });
}
