// City → IANA timezone mapping for rendering match start times.
//
// Callers feed this formatter the value of
// mdapi_matches.start_date_utc — the actually-UTC column. The
// sibling mdapi_matches.start_date column stores local wall-clock
// with a spurious +00 offset (mislabeled by the upstream sync) and
// must NOT be passed here; doing so produces a multi-hour skew.
//
// The browser's default locale would render UTC in the viewer's
// own zone, which is wrong for a multi-city operations dashboard —
// a St. Louis match at 9pm CDT shouldn't read as "3:00 AM" for a
// viewer in Lisbon. Every match should display in its own city's
// wall clock.
//
// All current MatchDay cities fall in three IANA zones. Daylight
// savings is handled automatically by Intl.DateTimeFormat.

import { type KnownCityCode } from "./cityNormalization";

const CITY_TIMEZONES: Record<KnownCityCode, string> = {
  ATX: "America/Chicago",
  DFW: "America/Chicago",
  HOU: "America/Chicago",
  SATX: "America/Chicago",
  STL: "America/Chicago",
  OKC: "America/Chicago",
  ATL: "America/New_York",
  ELP: "America/Denver",
  /* THE FIRST NON-US ZONE. Warsaw is UTC+2 in summer (CEST) and UTC+1 in winter; Intl handles the
   * switch. Until this line existed, timezoneFor("WAW") returned null and formatMatchTitle fell
   * back to UTC — rendering every Warsaw kickoff TWO HOURS EARLY in Match Chats, the Match Editor
   * and the Match Drawer, and into the {time} token of a Notify Players SMS.
   *
   * GAMEDAY OPS WAS NEVER AFFECTED and this does not change it: that board reads the wall clock
   * straight off startDate and the abbreviation off the API payload (gamedayModel.localClock /
   * tzAbbr), so it never converts and never consulted this map. */
  WAW: "Europe/Warsaw",
};

// Returns the IANA timezone for a city code, or null if unknown.
// formatMatchTitle below appends a "(UTC)" suffix to the rendered time when this returns null, so
// the gap is visible rather than silently wrong. That suffix is applied in the formatter, not by
// callers — it was a caller responsibility in prose for months and no caller ever honoured it.
export function timezoneFor(cityCode: string | null | undefined): string | null {
  if (!cityCode) return null;
  const code = cityCode as KnownCityCode;
  return CITY_TIMEZONES[code] ?? null;
}

// ============================================================
// Match-title formatter
// ============================================================
// Format used everywhere a match start time is surfaced in Match
// Chats:
//   "STL · Thu May 14 · 9:00 PM · Lou Fusz Athletic Complex"
//
// Components:
//   - city code (always uppercase; passed in by caller, not derived
//     here — caller already has the chip data)
//   - 3-letter abbreviated day-of-week (Thu / Fri / Sat)
//   - abbreviated month + numeric day (May 14)
//   - 12-hour time with uppercase AM/PM (9:00 PM)
//   - venue / field title
//
// Locale is pinned to "en-US" so English abbreviations and "AM/PM"
// (not "a.m./p.m.") are stable regardless of viewer locale.

const DATE_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
const TIME_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(tz: string): Intl.DateTimeFormat {
  let f = DATE_FMT_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    DATE_FMT_CACHE.set(tz, f);
  }
  return f;
}

function timeFormatter(tz: string): Intl.DateTimeFormat {
  let f = TIME_FMT_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    TIME_FMT_CACHE.set(tz, f);
  }
  return f;
}

// Returns "Thu May 14" — en-US default produces "Thu, May 14"; we
// strip the comma via formatToParts for a tighter look.
function formatDateInZone(date: Date, tz: string): string {
  const parts = dateFormatter(tz).formatToParts(date);
  let weekday = "";
  let month = "";
  let day = "";
  for (const p of parts) {
    if (p.type === "weekday") weekday = p.value;
    else if (p.type === "month") month = p.value;
    else if (p.type === "day") day = p.value;
  }
  return `${weekday} ${month} ${day}`.trim();
}

// Returns "9:00 PM" — en-US default produces "9:00 PM" already.
function formatTimeInZone(date: Date, tz: string): string {
  return timeFormatter(tz).format(date);
}

export type FormattedMatchTitle = {
  // Components are returned separately so the UI can interleave them
  // with chips / typography — the inbox row inserts a CityChip
  // between city and date.
  cityCode: string | null;
  date: string; // "Thu May 14" or "—"
  time: string; // "9:00 PM" or ""
  venue: string; // field_title or "(unknown venue)"
  // True when we fell back to UTC because the city code wasn't in
  // CITY_TIMEZONES. UI appends a small "(UTC)" suffix so the gap is
  // visible.
  isUtcFallback: boolean;
};

export function formatMatchTitle(opts: {
  cityCode: string | null | undefined;
  startDateIso: string | null | undefined;
  fieldTitle: string | null | undefined;
}): FormattedMatchTitle {
  const cityCode = opts.cityCode ? opts.cityCode.toUpperCase() : null;
  const venue = opts.fieldTitle?.trim() || "(unknown venue)";

  if (!opts.startDateIso) {
    return { cityCode, date: "—", time: "", venue, isUtcFallback: false };
  }
  const d = new Date(opts.startDateIso);
  if (Number.isNaN(d.getTime())) {
    return { cityCode, date: "—", time: "", venue, isUtcFallback: false };
  }

  const tz = timezoneFor(cityCode);
  const useZone = tz ?? "UTC";
  /* THE "(UTC)" SUFFIX IS APPLIED HERE, NOT LEFT TO CALLERS. This header has promised since it was
   * written that "callers fall back to UTC display (with a '(UTC)' suffix) so the gap is visible
   * rather than silently wrong" — and NO caller ever read isUtcFallback. grep found it only inside
   * this file. The mitigation was described and never built, so an unmapped city rendered a wrong
   * hour with nothing on screen to say so: Warsaw showed every kickoff two hours early in Match
   * Chats, the Match Editor, the Match Drawer, and in the {time} token of a Notify Players SMS.
   *
   * Putting it in the returned STRING keeps the promise for every caller, present and future,
   * including ones that only interpolate `time` and have no place to render a flag. isUtcFallback
   * stays on the type for callers that want to style the gap as well as state it. */
  const time = formatTimeInZone(d, useZone);
  return {
    cityCode,
    date: formatDateInZone(d, useZone),
    time: tz == null && time ? `${time} (UTC)` : time,
    venue,
    isUtcFallback: tz == null,
  };
}
