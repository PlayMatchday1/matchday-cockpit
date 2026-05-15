// City → IANA timezone mapping for rendering match start times.
//
// mdapi_matches.start_date is stored in UTC. The browser's default
// locale would render in the viewer's local zone, which is wrong for
// a multi-city operations dashboard — a St. Louis match at 9pm CDT
// shouldn't read as "3:00 AM" for a viewer in Lisbon (or as
// "10:00 PM" for a viewer in NYC). Every match should display in
// its own city's wall clock.
//
// All current MatchDay cities fall in three IANA zones. Daylight
// savings is handled automatically by Intl.DateTimeFormat.

import {
  normalizeCityName,
  type KnownCityCode,
} from "./cityNormalization";

const CITY_TIMEZONES: Record<KnownCityCode, string> = {
  ATX: "America/Chicago",
  DFW: "America/Chicago",
  HOU: "America/Chicago",
  SATX: "America/Chicago",
  STL: "America/Chicago",
  OKC: "America/Chicago",
  ATL: "America/New_York",
  ELP: "America/Denver",
};

// Returns the IANA timezone for a city code, or null if unknown.
// Callers fall back to UTC display (with a "(UTC)" suffix) so the
// gap is visible rather than silently wrong.
//
// Uppercase-normalize before lookup — defensive against any future
// path that hands us a lowercase short code ("stl") instead of the
// canonical "STL".
export function timezoneFor(cityCode: string | null | undefined): string | null {
  if (!cityCode) return null;
  const code = cityCode.toUpperCase() as KnownCityCode;
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
  // `cityName` is the human-readable name from mdapi_matches
  // (e.g. "St. Louis") — used as a fallback when `cityCode` is null
  // or doesn't map to a known IANA zone. This is the common case
  // for older synced matches where MatchDay's API didn't return
  // `field.city.abbr` and the sync wrote city_identifier as null.
  // normalizeCityName turns "St. Louis" → "STL" → America/Chicago.
  cityName?: string | null | undefined;
  startDateIso: string | null | undefined;
  fieldTitle: string | null | undefined;
}): FormattedMatchTitle {
  const rawCode = opts.cityCode ? opts.cityCode.toUpperCase() : null;
  const venue = opts.fieldTitle?.trim() || "(unknown venue)";

  // Resolve the effective city code through three tiers:
  //   1. `cityCode` exactly matching the IANA map
  //   2. `cityCode` UPPER-cased (handled by timezoneFor)
  //   3. `cityName` normalized via the existing CITY_MAP in
  //      cityNormalization.ts (handles "St. Louis", "Saint Louis",
  //      "Dallas / Fort Worth", etc.)
  let resolvedCode = rawCode;
  let tz = timezoneFor(resolvedCode);
  if (!tz && opts.cityName) {
    const normalized = normalizeCityName(opts.cityName);
    if (normalized) {
      resolvedCode = normalized;
      tz = timezoneFor(normalized);
    }
  }

  if (!opts.startDateIso) {
    return {
      cityCode: resolvedCode,
      date: "—",
      time: "",
      venue,
      isUtcFallback: false,
    };
  }
  const d = new Date(opts.startDateIso);
  if (Number.isNaN(d.getTime())) {
    return {
      cityCode: resolvedCode,
      date: "—",
      time: "",
      venue,
      isUtcFallback: false,
    };
  }

  const useZone = tz ?? "UTC";
  const out: FormattedMatchTitle = {
    cityCode: resolvedCode,
    date: formatDateInZone(d, useZone),
    time: formatTimeInZone(d, useZone),
    venue,
    isUtcFallback: tz == null,
  };

  // Gated debug log — set NEXT_PUBLIC_DEBUG_MATCH_TIMES=1 in
  // .env.local to surface the inputs / resolved zone / outputs for
  // every call in the browser console. Off by default so production
  // doesn't spam.
  if (
    typeof process !== "undefined" &&
    process.env.NEXT_PUBLIC_DEBUG_MATCH_TIMES === "1"
  ) {
    // eslint-disable-next-line no-console
    console.debug("[match-times]", {
      cityCodeIn: opts.cityCode ?? null,
      cityNameIn: opts.cityName ?? null,
      resolvedCode,
      startDateIso: opts.startDateIso,
      resolvedZone: useZone,
      formattedDate: out.date,
      formattedTime: out.time,
      isUtcFallback: out.isUtcFallback,
    });
  }

  return out;
}
