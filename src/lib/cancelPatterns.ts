// 4-week canceled-slot grid for the /cities index card.
//
// A "recurring slot" is identified by (canonical_field, day_of_week,
// time_of_day). For each canceled cell we compute a CONSECUTIVE
// backward streak: walk one week back at a time, increment if the
// same slot was also canceled, STOP on the first week the slot
// played successfully OR wasn't scheduled at all (gap-as-end is the
// safer reading — we can't count cancellations through a missing
// week of data without inventing signal).
//
// Window is the 4 weeks ending the most recent past Sunday — the
// in-progress current week is excluded so a partial week never gets
// painted as a complete one. Display order is current-week-first.

import type { MatchRow } from "./useMatchData";
import { normalizeMatchName } from "./venueNormalization";

const DOW_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type CancelSlot = {
  canonicalField: string;
  venueCode: string;
  dow: (typeof DOW_ABBR)[number];
  dowIdx: number; // 0=Mon, 6=Sun
  time: string; // formatted, e.g. "8p" or "11a"
  timeMinutes: number; // for sorting within a cell
  // Consecutive backward streak from this cell's week, capped at the
  // 4-week window. 1 = isolated cancellation, 4 = chronic.
  streak: 1 | 2 | 3 | 4;
};

export type CancelPatternsWeek = {
  weekStart: Date;
  weekEnd: Date;
  rangeLabel: string; // "MM/DD - MM/DD"
  // 7 buckets, indexed by dowIdx 0..6 (Mon..Sun)
  byDay: CancelSlot[][];
};

export type CancelPatternsResult = {
  weeks: CancelPatternsWeek[]; // newest → oldest (for display)
  totalSlots: number; // total slot pills across the grid
  chronicCount: number; // distinct slots-week pairs with streak === 4
};

// Short codes used inside the slot pills. Keys are fin_venues.venue_name
// canonicals (post-alias). Anything not in this map falls back to the
// first 4 chars of the canonical name uppercased — so a new venue
// renders something readable until it gets an explicit code.
const VENUE_CODE: Record<string, string> = {
  Hattrick: "HT",
  "San Juan Diego": "SJD",
  NEMP: "NEMP",
  "Bicentennial Park": "BIC",
  "Onion Creek": "OC",
  "Soccer Central": "SC",
  "ATH Katy": "ATH K",
  "ATH Katy Sunday": "ATH K",
  "ATH Pearland": "ATH P",
  "KISC (Katy Intl)": "KISC",
  "PAC Global": "PAC",
  STAR: "STAR",
  "Scissortail Park": "SCI",
  "Hammond Park": "HAM",
  PRUMC: "PRUMC",
  "Lou Fusz Outdoor": "LOU",
  "Lou Fusz Indoor": "LOU IN",
  "Round Rock": "RR",
  "Centennial Commons": "CEN",
  "Stony Point": "SP",
  "Carroll Senior HS": "CAR",
  "Majestic Gardens": "MAJ",
  "Galatzan Park": "GAL",
};

function venueCodeFor(canonical: string): string {
  return VENUE_CODE[canonical] ?? canonical.slice(0, 4).toUpperCase();
}

function getMonday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  x.setDate(x.getDate() + offset);
  return x;
}

function dowIdxFromDate(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 6 : day - 1;
}

// Compact 12-hour format. "8p" / "8:30p" / "11a". Soccer matches lean
// PM so a/p disambiguation matters when there's an occasional Saturday
// 11 AM in the mix.
function formatTimeCompact(d: Date): string {
  let hr = d.getHours();
  const mn = d.getMinutes();
  const period = hr >= 12 ? "p" : "a";
  hr = hr % 12;
  if (hr === 0) hr = 12;
  if (mn === 0) return `${hr}${period}`;
  return `${hr}:${String(mn).padStart(2, "0")}${period}`;
}

function totalMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function fmtMonthDay(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

export function getCancelPatterns(
  rows: MatchRow[],
  venueAliases: Map<string, string>,
  now: Date = new Date(),
): CancelPatternsResult {
  // Build the 4 weeks chronologically (oldest → newest). Streak
  // walk-back is more natural this direction; we reverse for display
  // at the end.
  const thisMonday = getMonday(now);
  const weeks: CancelPatternsWeek[] = [];
  for (let i = 4; i >= 1; i--) {
    const wMon = new Date(
      thisMonday.getFullYear(),
      thisMonday.getMonth(),
      thisMonday.getDate() - 7 * i,
    );
    const wSun = new Date(
      wMon.getFullYear(),
      wMon.getMonth(),
      wMon.getDate() + 6,
    );
    weeks.push({
      weekStart: wMon,
      weekEnd: wSun,
      rangeLabel: `${fmtMonthDay(wMon)} - ${fmtMonthDay(wSun)}`,
      byDay: [[], [], [], [], [], [], []],
    });
  }
  if (weeks.length === 0) return { weeks: [], totalSlots: 0, chronicCount: 0 };

  const earliestMs = weeks[0].weekStart.getTime();
  const latestExclusiveMs = new Date(
    weeks[weeks.length - 1].weekEnd.getFullYear(),
    weeks[weeks.length - 1].weekEnd.getMonth(),
    weeks[weeks.length - 1].weekEnd.getDate() + 1,
  ).getTime();

  // Per-slot per-week state. "played" wins over "canceled" in the
  // rare case the same slot key has multiple match instances in one
  // week with mixed outcomes (multi-field venue) — biases toward NOT
  // extending streaks through partial successes, which is the
  // conservative read.
  type WeekState = "canceled" | "played";
  type SlotKey = string; // `${canonical}|${dowIdx}|${timeStr}`
  const slotWeeks = new Map<SlotKey, Map<number, WeekState>>();
  type SlotMeta = {
    canonical: string;
    dowIdx: number;
    time: string;
    timeMinutes: number;
  };
  const slotMeta = new Map<SlotKey, SlotMeta>();

  for (const r of rows) {
    const ms = r.matchStart.getTime();
    if (ms < earliestMs || ms >= latestExclusiveMs) continue;
    if (!r.field) continue;
    const canonical = normalizeMatchName(r.field, venueAliases).canonical;
    if (!canonical) continue;

    const di = dowIdxFromDate(r.matchStart);
    const time = formatTimeCompact(r.matchStart);
    const key: SlotKey = `${canonical}|${di}|${time}`;

    let weekIdx = -1;
    for (let i = 0; i < weeks.length; i++) {
      const startMs = weeks[i].weekStart.getTime();
      const endMs = new Date(
        weeks[i].weekEnd.getFullYear(),
        weeks[i].weekEnd.getMonth(),
        weeks[i].weekEnd.getDate() + 1,
      ).getTime();
      if (ms >= startMs && ms < endMs) {
        weekIdx = i;
        break;
      }
    }
    if (weekIdx === -1) continue;

    let weekMap = slotWeeks.get(key);
    if (!weekMap) {
      weekMap = new Map();
      slotWeeks.set(key, weekMap);
      slotMeta.set(key, {
        canonical,
        dowIdx: di,
        time,
        timeMinutes: totalMinutes(r.matchStart),
      });
    }
    const existing = weekMap.get(weekIdx);
    if (r.matchCanceled) {
      // Don't overwrite a "played" mark — partial success keeps the
      // slot "played" for streak purposes.
      if (existing !== "played") weekMap.set(weekIdx, "canceled");
    } else {
      weekMap.set(weekIdx, "played");
    }
  }

  // Streak: walk backward (toward oldest) from each canceled cell,
  // incrementing while the same slot is also canceled, stopping on
  // the first "played" or undefined (no-data gap).
  function backwardStreak(slotKey: SlotKey, fromWeekIdx: number): number {
    const weekMap = slotWeeks.get(slotKey);
    if (!weekMap) return 1;
    let streak = 1;
    for (let w = fromWeekIdx - 1; w >= 0; w--) {
      if (weekMap.get(w) === "canceled") streak++;
      else break;
    }
    return streak;
  }

  let totalSlots = 0;
  let chronicCount = 0;
  for (const [key, weekMap] of slotWeeks) {
    const meta = slotMeta.get(key);
    if (!meta) continue;
    for (const [weekIdx, state] of weekMap) {
      if (state !== "canceled") continue;
      const streak = backwardStreak(key, weekIdx) as 1 | 2 | 3 | 4;
      if (streak === 4) chronicCount++;
      const slot: CancelSlot = {
        canonicalField: meta.canonical,
        venueCode: venueCodeFor(meta.canonical),
        dow: DOW_ABBR[meta.dowIdx],
        dowIdx: meta.dowIdx,
        time: meta.time,
        timeMinutes: meta.timeMinutes,
        streak,
      };
      weeks[weekIdx].byDay[meta.dowIdx].push(slot);
      totalSlots++;
    }
  }

  // Sort within each cell: streak desc (chronic at top), then earlier
  // start time first.
  for (const w of weeks) {
    for (const day of w.byDay) {
      day.sort((a, b) => {
        if (a.streak !== b.streak) return b.streak - a.streak;
        return a.timeMinutes - b.timeMinutes;
      });
    }
  }

  // Display newest week first.
  return { weeks: weeks.slice().reverse(), totalSlots, chronicCount };
}

export const CANCEL_PATTERNS_DOW_LABELS = DOW_ABBR;
