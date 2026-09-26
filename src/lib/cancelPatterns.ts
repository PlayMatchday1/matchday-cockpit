// 4-week canceled-slot grid for the /cities index card.
//
// A "recurring slot" is identified by (canonical_field, day_of_week,
// time_of_day). Each rendered pill carries TWO independent metrics
// the view picks between:
//
//   cancelCount — count of weeks (out of 4) where this slot
//     canceled, any order. Same value on every pill of the same
//     slot. Drives the "patterns" view: brighter = more frequent,
//     regardless of consecutive-ness.
//
//   streak — CONSECUTIVE backward streak from this cell's week.
//     Walks one week back at a time, increments while the same slot
//     is also canceled, STOPS on the first "played" or undefined
//     gap (gap-as-end is conservative — can't count through missing
//     data). Drives the "live" view's chronic-on-current logic.
//
// Mode controls anchor + which metric the colors come from:
//   "patterns" — last 4 fully-completed weeks (last week if today is
//     Mon-Sat, this week if today is Sunday — see the Sunday note in
//     getCancelPatterns). Default. Pills colored by cancelCount on
//     all 4 weeks; the operational view for spotting chronic slots.
//   "live" — current week + 3 prior. Pills in the top (current) week
//     colored by streak; pills in older weeks rendered muted. Useful
//     mid-week to compare this week against recent history.
// Display order is newest-first regardless of mode.

import type { MatchRow } from "./useMatchData";
import { normalizeMatchName } from "./venueNormalization";
import { getMonday, mostRecentCompletedWeekMonday } from "./weekWindow";

const DOW_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type CancelSlot = {
  canonicalField: string;
  venueCode: string;
  dow: (typeof DOW_ABBR)[number];
  dowIdx: number; // 0=Mon, 6=Sun
  time: string; // formatted, e.g. "8p" or "11a"
  timeMinutes: number; // for sorting within a cell
  // Consecutive backward streak from this cell's week, capped at
  // the 4-week window. 1 = isolated, 4 = chronic by streak. Used
  // by "live" mode where chronic colors apply to the current week.
  streak: 1 | 2 | 3 | 4;
  // Count of weeks (out of 4) the slot canceled in the window — any
  // order. Same value on every pill of the same slot. Used by
  // "patterns" mode where colors apply across all 4 weeks.
  cancelCount: 1 | 2 | 3 | 4;
  // Number of bookings on the cancelled match that this pill
  // represents — i.e. the count of MatchRows for this (slot, week)
  // where matchCanceled is true, irrespective of playerCanceledAt.
  // Matches the heatmap's "# booked" number for cancelled cells
  // (cell.spots) so the two views agree slot-for-slot.
  bookedCount: number;
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
  // Distinct slots whose cancelCount === 4 — i.e., canceled in all
  // four weeks of the window. Counts each slot once, not per cell.
  chronicCount: number;
};

export type CancelPatternsMode = "patterns" | "live";

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
  mode: CancelPatternsMode = "patterns",
  now: Date = new Date(),
): CancelPatternsResult {
  // Build the 4 weeks chronologically (oldest → newest). Streak
  // walk-back is more natural this direction; we reverse for display
  // at the end (newest at index 0).
  //
  // Anchor for the newest week shown:
  //   "live"     → thisMonday (current in-progress week is the top)
  //   "patterns" → most-recent fully-completed week (lenient Sunday
  //     rule lives in the shared helper).
  const baseMonday =
    mode === "patterns" ? mostRecentCompletedWeekMonday(now) : getMonday(now);

  const weeks: CancelPatternsWeek[] = [];
  // i=0 is the anchor week (newest after reverse). i=3 is 3 weeks
  // back. Building 4 weeks total, ending with the anchor week as the
  // last entry so the post-loop reverse() puts it at index 0 — that's
  // the cell the UI labels "(MOST RECENT)" or "(CURRENT)" depending
  // on mode.
  for (let i = 3; i >= 0; i--) {
    const wMon = new Date(
      baseMonday.getFullYear(),
      baseMonday.getMonth(),
      baseMonday.getDate() - 7 * i,
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
  // Per-cell count of cancelled MatchRows. Same numerator the heatmap
  // shows in cancelled cells (wkRows.length where r.matchCanceled).
  // Keyed (slot, weekIdx) just like slotWeeks.
  const bookedByCell = new Map<SlotKey, Map<number, number>>();
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
      let cellMap = bookedByCell.get(key);
      if (!cellMap) {
        cellMap = new Map();
        bookedByCell.set(key, cellMap);
      }
      cellMap.set(weekIdx, (cellMap.get(weekIdx) ?? 0) + 1);
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

    // Count canceled weeks for this slot once, then attach the same
    // value to every pill of this slot. Slots with zero canceled
    // cells fall through the inner loop and don't render anything.
    let canceledWeeks = 0;
    for (const state of weekMap.values()) {
      if (state === "canceled") canceledWeeks++;
    }
    if (canceledWeeks === 0) continue;
    const cancelCount = Math.min(canceledWeeks, 4) as 1 | 2 | 3 | 4;
    if (cancelCount === 4) chronicCount++;

    for (const [weekIdx, state] of weekMap) {
      if (state !== "canceled") continue;
      const streak = backwardStreak(key, weekIdx) as 1 | 2 | 3 | 4;
      const slot: CancelSlot = {
        canonicalField: meta.canonical,
        venueCode: venueCodeFor(meta.canonical),
        dow: DOW_ABBR[meta.dowIdx],
        dowIdx: meta.dowIdx,
        time: meta.time,
        timeMinutes: meta.timeMinutes,
        streak,
        cancelCount,
        bookedCount: bookedByCell.get(key)?.get(weekIdx) ?? 0,
      };
      weeks[weekIdx].byDay[meta.dowIdx].push(slot);
      totalSlots++;
    }
  }

  // Sort within each cell: most-prominent color tier on top, then
  // earlier start time. Sort key matches the metric the view colors
  // on so visual order matches color order.
  const primaryKey: keyof CancelSlot =
    mode === "patterns" ? "cancelCount" : "streak";
  for (const w of weeks) {
    for (const day of w.byDay) {
      day.sort((a, b) => {
        const av = a[primaryKey] as number;
        const bv = b[primaryKey] as number;
        if (av !== bv) return bv - av;
        return a.timeMinutes - b.timeMinutes;
      });
    }
  }

  // Display newest week first.
  return { weeks: weeks.slice().reverse(), totalSlots, chronicCount };
}

export const CANCEL_PATTERNS_DOW_LABELS = DOW_ABBR;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * THE TILE'S ROLLUP — field and weekday, with times CLUSTERED rather than dropped
 *
 * Ryan: "sometimes that one is hard as it has slate no longer active". The slot key above is
 * (canonical_field, day_of_week, time_of_day), so a slate time that moves by half an hour changes
 * the key, orphans the history, and renders a chronically cancelled slot clean.
 *
 * DROPPING TIME ENTIRELY WAS THE FIRST PROPOSAL AND IT IS WORSE THAN THE PROBLEM. MEASURED over
 * the four-week window getCancelPatterns itself uses (2026-08-24 to 2026-09-21, 429 matches, 142
 * slots keyed with time, 100 keyed without), 32 of the 100 field-and-weekday pairs carry more than
 * one distinct time, and the spread between them falls into two populations:
 *
 *     15 min    2 pairs    a slot that DRIFTED   (Round Rock Fri 19:00/19:15)
 *     30 min    3 pairs    a slot that DRIFTED   (KISC Fri 20:00/20:30)
 *     60 min   18 pairs    BACK-TO-BACK matches  (STAR Tue 19:30 and 20:30)
 *    120 min    9 pairs    BACK-TO-BACK matches  (Soccer Central Fri 19:00, 20:00, 21:00)
 *
 * So only 5 of 32 are the drift this is meant to rescue; the other 27 are different matches on the
 * same evening. Merging them would paint all three Soccer Central tiles with one count and report
 * one slot dying where three died. The clincher: STAR Tuesday cancelled at BOTH 19:30 and 20:30 in
 * the window, which is two slots dying, not one dying twice as hard.
 *
 * ── WHY FORTY ────────────────────────────────────────────────────────────────────────────────
 * Not because of anything about forty. Because the measured distribution has a HOLE in it: the
 * drift cases stop at 30 and the back-to-back cases start at 60, and there is nothing in between.
 * Forty sits in that hole. WHOEVER MEETS A 45-MINUTE PAIR IS OUTSIDE THE EVIDENCE and should
 * re-measure rather than nudge this number — a 45-minute gap is equally consistent with a slot
 * that moved and with a short turnaround, and this data cannot tell them apart. */
export const SLOT_CLUSTER_GAP_MIN = 40;

/* ── AND WHY THE SPAN IS CAPPED SEPARATELY ────────────────────────────────────────────────────
 * A gap rule alone is single-link clustering, which CHAINS: 19:00, 19:35 and 20:10 are two
 * 35-minute steps, each inside the gap, and they would merge into one 70-minute group — quietly
 * reproducing the back-to-back merge the gap rule exists to prevent. So a cluster also has a total
 * width, measured from its first member.
 *
 * FORTY-FIVE, because the widest real drift observed is 30 (LBJ Sun 19:00/19:15/19:30, three
 * points inside half an hour) and the narrowest real back-to-back is 60. 45 admits every observed
 * drift and refuses the 70-minute chain. */
export const SLOT_CLUSTER_SPAN_MIN = 45;

/** Minutes-of-day, sorted ascending, grouped into clusters. Both bounds apply: a time joins the
 *  open cluster only if it is within GAP of the previous member AND within SPAN of the first. */
export function clusterMinutes(minutes: readonly number[]): number[][] {
  const sorted = [...new Set(minutes)].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const m of sorted) {
    const open = out[out.length - 1];
    if (open && m - open[open.length - 1] <= SLOT_CLUSTER_GAP_MIN && m - open[0] <= SLOT_CLUSTER_SPAN_MIN) open.push(m);
    else out.push([m]);
  }
  return out;
}

/** The key a tile is coloured by: field, weekday, and which time-cluster the kickoff falls in.
 *  The cluster is identified by its FIRST member, so every time in it resolves to one key. */
export function slotRiskKey(canonicalField: string, dowIdx: number, minutes: number, clusters: number[][]): string {
  const c = clusters.find((g) => minutes >= g[0] && minutes <= g[g.length - 1]);
  return `${canonicalField}|${dowIdx}|${c ? c[0] : minutes}`;
}

export type SlotRisk = { cancelCount: 1 | 2 | 3 | 4; booked: number; times: string[] };

/* THE ROLLUP, BUILT FROM getCancelPatterns' OWN OUTPUT rather than re-reading the match rows.
 * That function owns the canonicalisation, the four-week window and the lenient-Sunday anchor;
 * deriving this at the call site would mean a second copy of all three, which is exactly how the
 * per_match_rate and cost_per_match figures ended up $36 apart. It is ADDED BESIDE it and changes
 * nothing about it, so the cities index card and the Cancel tab are untouched.
 *
 * cancelCount is the MAX across the merged times, not the sum. Two slots in one cluster are the
 * same slot observed either side of a move, so a 4-week count of 2 and a count of 1 is one slot
 * that cancelled in at most 2 of the 4 weeks — adding them would invent a fifth week. */
export function rollUpSlotRisk(result: CancelPatternsResult): Map<string, SlotRisk> {
  const byFieldDow = new Map<string, number[]>();
  const slots: CancelSlot[] = [];
  for (const w of result.weeks) for (const day of w.byDay) for (const s of day) {
    slots.push(s);
    const k = `${s.canonicalField}|${s.dowIdx}`;
    (byFieldDow.get(k) ?? byFieldDow.set(k, []).get(k)!).push(s.timeMinutes);
  }
  const clustersFor = new Map<string, number[][]>();
  for (const [k, mins] of byFieldDow) clustersFor.set(k, clusterMinutes(mins));

  const out = new Map<string, SlotRisk>();
  for (const s of slots) {
    const clusters = clustersFor.get(`${s.canonicalField}|${s.dowIdx}`) ?? [[s.timeMinutes]];
    const key = slotRiskKey(s.canonicalField, s.dowIdx, s.timeMinutes, clusters);
    const prev = out.get(key);
    if (!prev) { out.set(key, { cancelCount: s.cancelCount, booked: s.bookedCount, times: [s.time] }); continue; }
    prev.cancelCount = Math.max(prev.cancelCount, s.cancelCount) as 1 | 2 | 3 | 4;
    prev.booked += s.bookedCount;
    if (!prev.times.includes(s.time)) prev.times.push(s.time);
  }
  return out;
}

/** The clusters for one field and weekday, so a caller holding a match can find its own key. */
export function clustersForField(result: CancelPatternsResult, canonicalField: string, dowIdx: number): number[][] {
  const mins: number[] = [];
  for (const w of result.weeks) for (const day of w.byDay) for (const s of day)
    if (s.canonicalField === canonicalField && s.dowIdx === dowIdx) mins.push(s.timeMinutes);
  return clusterMinutes(mins);
}
