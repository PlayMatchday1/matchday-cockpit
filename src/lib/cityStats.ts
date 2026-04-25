import type { MatchRow } from "./useMatchData";

export const MATCH_DENOMINATOR = 18;

export const STATUS_THRESHOLDS = {
  buildingMatchesPerWeek: 10,
  atRiskCancelRate: 15,
  healthyMatchesPerWeek: 15,
  healthyCancelRate: 8,
};

export const INSUFFICIENT_DATA_TOTAL_SPOTS = 20;

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

export function getCancelRate(
  rows: MatchRow[],
  city: string,
  weeksBack = 8,
  now: Date = new Date(),
): { totalSpots: number; playerCancels: number; rate: number } {
  const { earliestMonday, windowEnd } = windowBounds(weeksBack, now);

  let totalSpots = 0;
  let playerCancels = 0;
  for (const row of rows) {
    if (row.city !== city) continue;
    if (row.matchCanceled) continue;
    if (row.matchStart < earliestMonday || row.matchStart >= windowEnd) continue;
    totalSpots++;
    if (row.playerCanceledAt !== null) playerCancels++;
  }
  const rate = totalSpots === 0 ? 0 : (playerCancels / totalSpots) * 100;
  return { totalSpots, playerCancels, rate };
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

export type CityStatus = "Healthy" | "Building" | "At risk" | "Just launched";

export function getCityStatus(
  rows: MatchRow[],
  city: string,
  now: Date = new Date(),
): CityStatus {
  const cancel = getCancelRate(rows, city, 8, now);
  if (cancel.totalSpots < INSUFFICIENT_DATA_TOTAL_SPOTS) return "Just launched";
  if (cancel.rate >= STATUS_THRESHOLDS.atRiskCancelRate) return "At risk";

  const weekly = getWeeklySpots(rows, city, 8, now);
  const currentMatches = weekly[weekly.length - 1].matches;

  if (currentMatches < STATUS_THRESHOLDS.buildingMatchesPerWeek) return "Building";
  if (
    currentMatches >= STATUS_THRESHOLDS.healthyMatchesPerWeek &&
    cancel.rate < STATUS_THRESHOLDS.healthyCancelRate
  ) {
    return "Healthy";
  }
  return "Building";
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
