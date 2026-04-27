// 4-week canceled-slot grid for the /cities index card.
//
// A "recurring slot" is identified by (canonical_field, day_of_week,
// time_of_day). For every canceled match in the window we count how
// many of the 4 weeks the same slot has been canceled — bright red if
// it's chronic across all 4, fading to muted gray for one-offs.
//
// Window is the 4 weeks ending the most recent past Sunday — i.e. the
// in-progress current week is excluded so we don't paint a partial
// week as a complete week.

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
  repeatCount: 1 | 2 | 3 | 4;
};

export type CancelPatternsWeek = {
  weekStart: Date;
  weekEnd: Date;
  rangeLabel: string; // "MM/DD - MM/DD"
  // 7 buckets, indexed by dowIdx 0..6 (Mon..Sun)
  byDay: CancelSlot[][];
};

export type CancelPatternsResult = {
  weeks: CancelPatternsWeek[]; // oldest → newest
  totalSlots: number; // total slot pills across the grid
  chronicCount: number; // distinct slots with repeatCount === 4
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
  // Build the 4 weeks ending the most recent past Sunday. If today is
  // Mon-Sun within a week, that week is "in progress" and excluded —
  // the newest complete week's Monday is thisMonday - 7 days.
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

  // Pass 1: collect deduped (week, slot) pairs. A canceled match has
  // many registration rows (one per booked player) — we want one
  // entry per (week, slot) combo, and the dow+time uniquely identify
  // the match within a week, so dedupe by that composite key.
  type SlotKey = string; // `${canonical}|${dowIdx}|${timeStr}`
  const slotWeeks = new Map<SlotKey, Set<number>>(); // slotKey → set of weekIdx
  type SlotMeta = {
    canonical: string;
    dowIdx: number;
    time: string;
    timeMinutes: number;
  };
  const slotMeta = new Map<SlotKey, SlotMeta>();

  for (const r of rows) {
    if (!r.matchCanceled) continue;
    const ms = r.matchStart.getTime();
    if (ms < earliestMs || ms >= latestExclusiveMs) continue;
    if (!r.field) continue;
    const canonical = normalizeMatchName(r.field, venueAliases).canonical;
    if (!canonical) continue;

    const di = dowIdxFromDate(r.matchStart);
    const time = formatTimeCompact(r.matchStart);
    const key: SlotKey = `${canonical}|${di}|${time}`;

    // Find which week index this match falls into.
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

    let weekSet = slotWeeks.get(key);
    if (!weekSet) {
      weekSet = new Set();
      slotWeeks.set(key, weekSet);
      slotMeta.set(key, {
        canonical,
        dowIdx: di,
        time,
        timeMinutes: totalMinutes(r.matchStart),
      });
    }
    weekSet.add(weekIdx);
  }

  // Pass 2: emit one CancelSlot per (week, slot) into the grid.
  let totalSlots = 0;
  let chronicCount = 0;
  for (const [key, weekSet] of slotWeeks) {
    const meta = slotMeta.get(key);
    if (!meta) continue;
    const repeatCount = weekSet.size as 1 | 2 | 3 | 4;
    if (repeatCount === 4) chronicCount++;
    for (const weekIdx of weekSet) {
      const slot: CancelSlot = {
        canonicalField: meta.canonical,
        venueCode: venueCodeFor(meta.canonical),
        dow: DOW_ABBR[meta.dowIdx],
        dowIdx: meta.dowIdx,
        time: meta.time,
        timeMinutes: meta.timeMinutes,
        repeatCount,
      };
      weeks[weekIdx].byDay[meta.dowIdx].push(slot);
      totalSlots++;
    }
  }

  // Sort within each cell: chronic first (repeat desc), then earlier
  // start time first.
  for (const w of weeks) {
    for (const day of w.byDay) {
      day.sort((a, b) => {
        if (a.repeatCount !== b.repeatCount) return b.repeatCount - a.repeatCount;
        return a.timeMinutes - b.timeMinutes;
      });
    }
  }

  return { weeks, totalSlots, chronicCount };
}

export const CANCEL_PATTERNS_DOW_LABELS = DOW_ABBR;
