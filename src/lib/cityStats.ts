import type { MatchRow } from "./useMatchData";

export const MATCH_DENOMINATOR = 18;

// Trend-based status thresholds. Compares the most recent 4 complete
// weeks (excluding the in-progress current week) against the prior 4
// complete weeks. Just-launched cap is on the recent window only —
// once a city sustains ≥ 8 matches across 4 weeks (avg 2/wk), it
// graduates into the trend buckets.
export const TREND_THRESHOLDS = {
  growingPct: 10,                  // ≥ +10% recent vs prior → Growing
  decliningPct: -10,               // ≤ −10% → Declining
  justLaunchedRecentMatches: 8,    // < 8 matches in recent 4 weeks → Just launched
};

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const DOW_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function getMonday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + offset);
  return x;
}

export function weekKey(d: Date): string {
  const m = getMonday(d);
  const yr = m.getFullYear();
  const mo = String(m.getMonth() + 1).padStart(2, "0");
  const dy = String(m.getDate()).padStart(2, "0");
  return `${yr}-${mo}-${dy}`;
}

export function weekLabel(d: Date): string {
  return `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`;
}

function dowIdx(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 6 : day - 1;
}

function formatTime(d: Date): string {
  let hr = d.getHours();
  const mn = d.getMinutes();
  const period = hr >= 12 ? "PM" : "AM";
  hr = hr % 12;
  if (hr === 0) hr = 12;
  if (mn === 0) return `${hr} ${period}`;
  return `${hr}:${String(mn).padStart(2, "0")} ${period}`;
}

function timeMinutes(t: string): number {
  const m = t.match(/^(\d+)(?::(\d+))?\s*(AM|PM)$/);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const pm = m[3] === "PM";
  if (h === 12) h = pm ? 12 : 0;
  else if (pm) h += 12;
  return h * 60 + min;
}

function windowBounds(weeksBack: number, now: Date) {
  const currentMonday = getMonday(now);
  const earliestMonday = new Date(
    currentMonday.getFullYear(),
    currentMonday.getMonth(),
    currentMonday.getDate() - 7 * (weeksBack - 1),
  );
  const windowEnd = new Date(
    currentMonday.getFullYear(),
    currentMonday.getMonth(),
    currentMonday.getDate() + 7,
  );
  return { currentMonday, earliestMonday, windowEnd };
}

export type WeeklySpotsEntry = {
  weekStart: Date;
  weekLabel: string;
  spots: number;
  matches: number;
  isCurrent: boolean;
};

export function getWeeklySpots(
  rows: MatchRow[],
  city: string | null,
  weeksBack = 8,
  now: Date = new Date(),
): WeeklySpotsEntry[] {
  const { currentMonday } = windowBounds(weeksBack, now);

  const buckets: { weekStart: Date; key: string; spots: number }[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const ws = new Date(
      currentMonday.getFullYear(),
      currentMonday.getMonth(),
      currentMonday.getDate() - 7 * i,
    );
    buckets.push({ weekStart: ws, key: weekKey(ws), spots: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));

  for (const row of rows) {
    if (city !== null && row.city !== city) continue;
    if (row.matchCanceled) continue;
    if (row.playerCanceledAt !== null) continue;
    const k = weekKey(row.matchStart);
    const b = byKey.get(k);
    if (b) b.spots++;
  }

  return buckets.map((b, i) => ({
    weekStart: b.weekStart,
    weekLabel: weekLabel(b.weekStart),
    spots: b.spots,
    matches: Math.round((b.spots / MATCH_DENOMINATOR) * 10) / 10,
    isCurrent: i === buckets.length - 1,
  }));
}

// Per-week cancellation stats for `weeksBack` ISO weeks ending with
// the current in-progress week. Same `(match_start.getTime(), field)`
// dedup as getCancelRate. Pure composition over already-loaded
// match_registrations — no new fetch.
//
// Pass `city = null` for network-wide totals (used by the /cities
// exec hero); a city name for per-city breakdown (used by the
// Cancellations lens sparklines).
export type WeeklyCancellationEntry = {
  weekStart: Date;
  weekLabel: string;
  scheduled: number; // distinct (field, match_start) keys in this week
  ran: number;        // scheduled minus canceled
  canceled: number;
  rate: number;       // 0–100, percentage of scheduled that were canceled
  isCurrent: boolean; // true on the last entry (in-progress week)
};

export function getWeeklyCancellationStats(
  rows: MatchRow[],
  city: string | null,
  weeksBack = 8,
  now: Date = new Date(),
): WeeklyCancellationEntry[] {
  const { currentMonday } = windowBounds(weeksBack, now);

  type Bucket = {
    weekStart: Date;
    key: string;
    matches: Map<string, boolean>; // matchKey → canceled
  };
  const buckets: Bucket[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const ws = new Date(
      currentMonday.getFullYear(),
      currentMonday.getMonth(),
      currentMonday.getDate() - 7 * i,
    );
    buckets.push({ weekStart: ws, key: weekKey(ws), matches: new Map() });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));

  for (const row of rows) {
    if (city !== null && row.city !== city) continue;
    if (!row.field) continue;
    const k = weekKey(row.matchStart);
    const b = byKey.get(k);
    if (!b) continue;
    const matchKey = `${row.matchStart.getTime()}|${row.field}`;
    if (!b.matches.has(matchKey)) b.matches.set(matchKey, row.matchCanceled);
  }

  return buckets.map((b, i) => {
    const scheduled = b.matches.size;
    let canceled = 0;
    for (const c of b.matches.values()) if (c) canceled++;
    const ran = scheduled - canceled;
    return {
      weekStart: b.weekStart,
      weekLabel: weekLabel(b.weekStart),
      scheduled,
      ran,
      canceled,
      rate: scheduled === 0 ? 0 : (canceled / scheduled) * 100,
      isCurrent: i === buckets.length - 1,
    };
  });
}

// Cancel rate, scoped to the current calendar month (MTD): % of
// distinct scheduled matches that didn't run. Match identity =
// (match_start + field), de-duped across the many registration rows
// per match. Same monthly boundary logic as Membership Health and
// Spot Mix by City — first of the local-time month through "now".
//
// totalSpots is preserved on the return value because CityDetailView's
// "Total spots" stat card still uses it — booked-spot count among
// matches that ran is a useful operational metric on its own. Now
// MTD-scoped to match the rest of the card.
export function getCancelRate(
  rows: MatchRow[],
  city: string,
  now: Date = new Date(),
): {
  totalMatches: number;
  canceledMatches: number;
  rate: number;
  totalSpots: number;
} {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const matches = new Map<string, boolean>(); // matchKey → canceled
  let totalSpots = 0;

  for (const row of rows) {
    if (row.city !== city) continue;
    if (!row.field) continue;
    if (row.matchStart < monthStart || row.matchStart >= monthEnd) continue;
    const key = `${row.matchStart.getTime()}|${row.field}`;
    if (!matches.has(key)) matches.set(key, row.matchCanceled);
    if (!row.matchCanceled) totalSpots++;
  }

  let canceledMatches = 0;
  for (const canceled of matches.values()) if (canceled) canceledMatches++;
  const totalMatches = matches.size;
  const rate = totalMatches === 0 ? 0 : (canceledMatches / totalMatches) * 100;

  return { totalMatches, canceledMatches, rate, totalSpots };
}

export function getActiveVenues(
  rows: MatchRow[],
  city: string,
  weeksBack = 8,
  now: Date = new Date(),
): string[] {
  const { earliestMonday, windowEnd } = windowBounds(weeksBack, now);
  const venues = new Set<string>();
  for (const row of rows) {
    if (row.city !== city) continue;
    if (row.matchCanceled) continue;
    if (!row.field) continue;
    if (row.matchStart < earliestMonday || row.matchStart >= windowEnd) continue;
    venues.add(row.field);
  }
  return [...venues].sort();
}

export type CityStatus = "Growing" | "Stable" | "Declining" | "Just launched";

// Trend-based status: compare the most recent 4 complete weeks
// (excluding the in-progress current week) against the prior 4
// complete weeks. Direction-of-travel signal — answers "is this
// city getting better, worse, or stagnating" rather than just "is
// this city large or small".
export function getCityStatus(
  rows: MatchRow[],
  city: string,
  now: Date = new Date(),
): CityStatus {
  const thisMonday = getMonday(now);
  // Walk back: weeks ending past Sunday, partitioned into recent-4
  // and prior-4 buckets.
  const olderStart = new Date(
    thisMonday.getFullYear(),
    thisMonday.getMonth(),
    thisMonday.getDate() - 7 * 8,
  );
  const splitPoint = new Date(
    thisMonday.getFullYear(),
    thisMonday.getMonth(),
    thisMonday.getDate() - 7 * 4,
  );
  const recentEnd = thisMonday; // exclusive: last completed week ends at thisMonday - 1 day

  const olderMatches = new Set<string>();
  const recentMatches = new Set<string>();
  for (const row of rows) {
    if (row.city !== city) continue;
    if (row.matchCanceled) continue;
    if (!row.field) continue;
    const ms = row.matchStart;
    if (ms < olderStart || ms >= recentEnd) continue;
    const key = `${ms.getTime()}|${row.field}`;
    if (ms < splitPoint) olderMatches.add(key);
    else recentMatches.add(key);
  }

  if (recentMatches.size < TREND_THRESHOLDS.justLaunchedRecentMatches) {
    return "Just launched";
  }
  if (olderMatches.size === 0) return "Growing"; // no prior baseline to compare → recent volume implies growth
  const pctChange =
    ((recentMatches.size - olderMatches.size) / olderMatches.size) * 100;
  if (pctChange >= TREND_THRESHOLDS.growingPct) return "Growing";
  if (pctChange <= TREND_THRESHOLDS.decliningPct) return "Declining";
  return "Stable";
}

export type SlotWeekData = {
  cancelled: boolean;
  spots: number;
  players: number;
};

export type SlotRow = {
  field: string;
  dow: string;
  dowIdx: number;
  time: string;
  weeks: Record<string, SlotWeekData>;
};

export function getCancelHeatmap(
  rows: MatchRow[],
  city: string,
  weeksBack = 8,
  now: Date = new Date(),
): { weeks: string[]; slots: SlotRow[] } {
  const { currentMonday, earliestMonday, windowEnd } = windowBounds(weeksBack, now);

  const weekKeys: string[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const wMon = new Date(
      currentMonday.getFullYear(),
      currentMonday.getMonth(),
      currentMonday.getDate() - 7 * i,
    );
    weekKeys.push(weekKey(wMon));
  }

  type Slot = {
    field: string;
    dow: string;
    dowIdx: number;
    time: string;
    weeks: Map<string, MatchRow[]>;
  };
  const slots = new Map<string, Slot>();

  for (const row of rows) {
    if (row.city !== city) continue;
    if (!row.field) continue;
    if (row.matchStart < earliestMonday || row.matchStart >= windowEnd) continue;

    const dIdx = dowIdx(row.matchStart);
    const time = formatTime(row.matchStart);
    const slotKey = `${row.field}|${dIdx}|${time}`;
    const wk = weekKey(row.matchStart);

    let slot = slots.get(slotKey);
    if (!slot) {
      slot = {
        field: row.field,
        dow: DOW_ABBR[dIdx],
        dowIdx: dIdx,
        time,
        weeks: new Map(),
      };
      slots.set(slotKey, slot);
    }
    let wkRows = slot.weeks.get(wk);
    if (!wkRows) {
      wkRows = [];
      slot.weeks.set(wk, wkRows);
    }
    wkRows.push(row);
  }

  const result: SlotRow[] = [];
  for (const slot of slots.values()) {
    const weeksOut: Record<string, SlotWeekData> = {};
    let hasCancelled = false;
    for (const [wk, wkRows] of slot.weeks) {
      const cancelled = wkRows.some((r) => r.matchCanceled);
      if (cancelled) {
        hasCancelled = true;
        weeksOut[wk] = { cancelled: true, spots: wkRows.length, players: 0 };
      } else {
        const players = wkRows.filter((r) => r.playerCanceledAt === null).length;
        weeksOut[wk] = { cancelled: false, spots: wkRows.length, players };
      }
    }
    if (!hasCancelled) continue;
    result.push({
      field: slot.field,
      dow: slot.dow,
      dowIdx: slot.dowIdx,
      time: slot.time,
      weeks: weeksOut,
    });
  }

  result.sort((a, b) => {
    if (a.dowIdx !== b.dowIdx) return a.dowIdx - b.dowIdx;
    const ta = timeMinutes(a.time);
    const tb = timeMinutes(b.time);
    if (ta !== tb) return ta - tb;
    return a.field.localeCompare(b.field);
  });

  return { weeks: weekKeys, slots: result };
}
