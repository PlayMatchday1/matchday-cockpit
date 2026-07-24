// Business-hours math for the Chats support-performance metrics.
//
// The whole point of these numbers is that they measure OUR
// responsiveness, not the clock. A customer who messages at 8:50pm and
// gets an answer at 9:10am the next morning waited 20 minutes of our
// working time, not 12 hours — so response time counts ONLY the minutes
// that fall inside the business window, summed across however many days
// the gap spans.
//
// v1 uses one company-wide window and timezone (most cities are
// Central). They are constants, not magic numbers at the call site, so a
// later per-city version only has to thread a different config through
// businessMinutesBetween — the algorithm doesn't change.
//
// WEEKENDS: every day is a working day in v1 (9pm–9am is the only closed
// band). MatchDay's matches — and therefore its support load — peak on
// weekends, so excluding Sat/Sun would make a Saturday inbound answered
// Saturday afternoon read as a multi-day wait, which is the opposite of
// the truth. If that ever needs to change, add the working-days set to
// BusinessHoursConfig; the intersection loop already visits each day
// individually.
//
// DST is handled by resolving every window boundary through
// Intl.DateTimeFormat in the business timezone, so the 9am/9pm edges land
// on the correct UTC instant on both sides of a spring-forward /
// fall-back, and a day may legitimately be 23 or 25 hours long without
// skewing the sum.

export const BUSINESS_HOURS_START = 9; // 9:00am, inclusive open
export const BUSINESS_HOURS_END = 21; // 9:00pm, exclusive close
export const BUSINESS_TZ = "America/Chicago";

export type BusinessHoursConfig = {
  startHour: number;
  endHour: number;
  tz: string;
};

export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  startHour: BUSINESS_HOURS_START,
  endHour: BUSINESS_HOURS_END,
  tz: BUSINESS_TZ,
};

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// One cached formatter per timezone. formatToParts in a fixed zone is
// the DST-correct way to read an instant's wall-clock components.
const PARTS_FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = PARTS_FMT_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    PARTS_FMT_CACHE.set(tz, f);
  }
  return f;
}

export type WallClockParts = {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number;
  second: number;
};

// The wall-clock an instant reads as in the given timezone.
export function wallClockPartsInZone(
  utcMs: number,
  tz: string = BUSINESS_TZ,
): WallClockParts {
  const parts = partsFormatter(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => {
    const p = parts.find((x) => x.type === t);
    return p ? Number(p.value) : NaN;
  };
  // Intl renders midnight as hour "24" in some engines; normalize to 0.
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

// The signed offset (localWallClock − UTC) in ms at a given instant, in
// the given zone. Positive east of UTC, negative west (Central is
// negative). This is the primitive both conversions below rely on.
function zoneOffsetMs(utcMs: number, tz: string): number {
  const p = wallClockPartsInZone(utcMs, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - utcMs;
}

// Convert a wall-clock time in `tz` to the UTC instant it denotes.
//
// Two passes because the offset we need is the offset AT the target
// instant, which we don't know until we've applied it. The first pass
// estimates using the offset at the naive-UTC guess; the second corrects
// it if that guess straddled a DST change. Two passes converge for every
// real-world zone (offsets change by at most an hour, and never twice
// within the same hour).
export function zonedWallClockToUtcMs(
  year: number,
  month: number, // 1–12
  day: number,
  hour: number,
  minute: number,
  tz: string = BUSINESS_TZ,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const off1 = zoneOffsetMs(naive, tz);
  let utc = naive - off1;
  const off2 = zoneOffsetMs(utc, tz);
  if (off2 !== off1) utc = naive - off2;
  return utc;
}

// The [open, close) business window, as UTC instants, for the calendar
// day that the given wall-clock parts fall on.
function windowForDay(
  parts: WallClockParts,
  cfg: BusinessHoursConfig,
): { openMs: number; closeMs: number } {
  const openMs = zonedWallClockToUtcMs(
    parts.year,
    parts.month,
    parts.day,
    cfg.startHour,
    0,
    cfg.tz,
  );
  const closeMs = zonedWallClockToUtcMs(
    parts.year,
    parts.month,
    parts.day,
    cfg.endHour,
    0,
    cfg.tz,
  );
  return { openMs, closeMs };
}

// Business minutes elapsed between two UTC instants, counting only the
// time inside the daily [startHour, endHour) window in the business
// timezone, summed across day boundaries.
//
// Properties that fall out of the intersection approach, each covered by
// a test:
//   • same-window gap = wall-clock minutes (instant reply ≈ 0).
//   • an inbound arriving before open has its clock start at that day's
//     open (max(start, open)); arriving after close contributes nothing
//     that day and starts at the next day's open.
//   • a gap lying entirely in a closed band (overnight, weekend night)
//     contributes 0 — it cannot inflate the metric.
export function businessMinutesBetween(
  startMs: number,
  endMs: number,
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  if (endMs <= startMs) return 0;

  let total = 0;

  // Anchor day iteration at noon UTC of the start day's Central date.
  // Noon UTC is mid-morning Central — comfortably clear of both midnight
  // and the 2am DST edge — so advancing by +24h always lands the Central
  // calendar date on exactly the next day.
  const startParts = wallClockPartsInZone(startMs, cfg.tz);
  let anchorMs = Date.UTC(startParts.year, startParts.month - 1, startParts.day, 12, 0, 0);

  // Bounded loop: response gaps are short, but cap defensively so a bad
  // pair of timestamps can never spin. 400 days dwarfs any real gap.
  for (let i = 0; i < 400; i++) {
    const dayParts = wallClockPartsInZone(anchorMs, cfg.tz);
    const { openMs, closeMs } = windowForDay(dayParts, cfg);

    // Windows advance chronologically; once a day opens at or after our
    // end there is nothing left to accumulate.
    if (openMs >= endMs) break;

    const lo = Math.max(startMs, openMs);
    const hi = Math.min(endMs, closeMs);
    if (hi > lo) total += hi - lo;

    anchorMs += DAY_MS;
  }

  return total / MINUTE_MS;
}

// Whether an instant falls inside the business window [startHour,
// endHour) in the business timezone. The half-open convention matches
// businessMinutesBetween: exactly 9:00am is open, exactly 9:00pm is
// closed. Used by the out-of-hours auto-reply to decide whether to greet.
export function isWithinBusinessHours(
  instantMs: number,
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): boolean {
  if (!Number.isFinite(instantMs)) return false;
  const p = wallClockPartsInZone(instantMs, cfg.tz);
  const { openMs, closeMs } = windowForDay(p, cfg);
  return instantMs >= openMs && instantMs < closeMs;
}

// For an out-of-hours instant, the UTC ms of the close boundary that
// began the current closed period (the most recent close ≤ the instant).
// Returns null when the instant is within business hours.
//
// This is the debounce key for the auto-reply: the closed gap runs from
// one day's close (9pm) to the next day's open (9am), so both a 10pm and
// a 6am-next-day inbound map to the SAME boundary (9pm the prior evening)
// and are treated as one gap. An auto-reply stamped at/after this
// boundary means we've already greeted this gap.
export function currentClosedPeriodStartMs(
  instantMs: number,
  cfg: BusinessHoursConfig = DEFAULT_BUSINESS_HOURS,
): number | null {
  if (!Number.isFinite(instantMs)) return null;
  const p = wallClockPartsInZone(instantMs, cfg.tz);
  const { openMs, closeMs } = windowForDay(p, cfg);
  if (instantMs >= openMs && instantMs < closeMs) return null; // in hours

  // Evening (at/after today's close): the gap started at today's close.
  if (instantMs >= closeMs) return closeMs;

  // Early morning (before today's open): the gap started at YESTERDAY's
  // close. Reconstruct yesterday's date via a noon-UTC anchor so the
  // −1-day step is DST-safe, then resolve that day's close boundary.
  const yesterdayAnchor = Date.UTC(p.year, p.month - 1, p.day, 12) - DAY_MS;
  const y = wallClockPartsInZone(yesterdayAnchor, cfg.tz);
  return zonedWallClockToUtcMs(y.year, y.month, y.day, cfg.endHour, 0, cfg.tz);
}

// Median of a numeric list. Returns null for an empty list. Sorts a copy
// (never mutates the input). Even-length lists average the two middle
// values.
//
// Median, not mean, is deliberate: one operator asleep at 3am must not
// drag the headline number. A single 11-hour outlier moves the mean a
// lot and the median not at all — which is the honest picture of a
// typical customer's experience.
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}
