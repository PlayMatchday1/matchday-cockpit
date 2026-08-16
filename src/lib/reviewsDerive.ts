// Pure derivation for the Reviews page. Every number the page shows comes from
// here, and the reconciliation script imports the SAME functions, so a rendered
// number and its check can never drift. No fetching, no React — just rows in,
// facts out. Ports the mockup (docs/mockups/reviews-v1_3.html) rule-for-rule.
//
// Single source: all figures derive from individual reviews (mdapi_reviews via
// ReviewRow). A "match" is one instance = (field_title, start_date-minute) — the
// grain reviews actually carry (they have no match_id). Manager aggregates,
// per-match attention/standouts, tiles and the 8-week series all fall out of the
// one filtered array, so no fact is computed two different ways.

import type { ReviewRow } from "./useReviewData";
import { normalizeCity } from "./cityMap";
import { managerKey, managerDisplayName } from "./reviewStats";

// Thresholds — named once, printed on screen wherever they gate anything.
export const MIN_RANK_REVIEWS = 10; // symmetric ranking floor (top AND bottom)
export const ATTN_MAX_AVG = 3.5;
export const ATTN_MIN_REVIEWS = 3;
export const STAND_MIN_AVG = 4.8;
export const STAND_MIN_REVIEWS = 3;

const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

export type PageFilters = { month: string; city: string; venue: string; mgr: string };


// ONE CITY VOCABULARY AT THE FILTER.
//
// THE BUG THIS CLOSES: the page compared `r.city` against `f.city` directly. `r.city` is the
// NORMALISED cockpit name (useScopedReviews runs every row through normalizeCity), while `f.city`
// arrives as the PLATFORM label — cityScope.cityNameFor("DFW") is "Dallas / Fort Worth". cityMap
// maps that to "Dallas", so the two were never equal and a DFW city manager's Reviews page dropped
// all 922 of their rows and rendered zeros. Austin is the one city where both maps return the same
// string, which is why the ATX-scoped suite could not see it.
//
// `normalizeCity(c) ?? c` is the canonical form BOTH sides go through, so a raw name can no longer
// be compared against a normalised one. The `?? c` matters: "Dallas" is not itself a key in
// CSV_TO_COCKPIT_CITY, so normalizeCity("Dallas") is null — mapping both sides with a bare
// normalizeCity would compare null to "Dallas" and stay broken, and comparing null to null would
// make every city match every other. Falling back to the input keeps already-canonical values
// intact and keeps genuinely different cities distinct.
export const canonCity = (c: string | null | undefined): string => normalizeCity(c) ?? (c ?? "");

export function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${MO[m - 1]} ${y}`;
}
export function reviewManagerName(r: ReviewRow): string | null {
  return managerKey(r) ? managerDisplayName(r.managerFirstName, r.managerLastName) : null;
}
// Match identity. mdapi_reviews carries NO match id, so a match is keyed by its field + start
// instant — two matches cannot occupy one field at one moment. Exported (Phase 26c) so the
// group-by-match rendering and this file's existing aggregation cannot disagree about what "the
// same match" means. Null-safe: an unparseable start collapses to one shared "no-start" key.
export function matchKeyOf(r: ReviewRow): string {
  const t = r.startDate instanceof Date && !Number.isNaN(r.startDate.getTime()) ? String(r.startDate.getTime()) : "no-start";
  return `${r.fieldTitle}@@${t}`;
}
export function matchDateLabel(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${MO[d.getMonth()]} ${d.getDate()} · ${h}:${String(d.getMinutes()).padStart(2, "0")} ${ampm}`;
}

// Distinct months present, newest first — drives the month select + default.
export function monthsPresent(rows: ReviewRow[]): string[] {
  const s = new Set<string>();
  for (const r of rows) s.add(monthKeyOf(r.startDate));
  return [...s].sort().reverse();
}

export type ManagerAgg = {
  key: string;
  name: string;
  city: string;
  avg: number;
  reviews: number;
  matches: number;
};
export type MatchAgg = {
  key: string;
  venue: string;
  city: string;
  manager: string | null;
  date: Date;
  avg: number;
  reviews: number;
};
export type PageDerived = {
  venueMode: boolean;
  avg: number | null;
  reviews: number;
  matches: number;
  ranked: ManagerAgg[];
  unranked: ManagerAgg[];
  unattributed: { avg: number; reviews: number; matches: number } | null;
  attn: MatchAgg[];
  stand: MatchAgg[];
};

function inMonth(r: ReviewRow, month: string): boolean {
  return monthKeyOf(r.startDate) === month;
}

// group filtered reviews into per-match aggregates
function matchAggs(rows: ReviewRow[]): MatchAgg[] {
  const by = new Map<string, { sum: number; n: number; sample: ReviewRow }>();
  for (const r of rows) {
    const k = matchKeyOf(r);
    const g = by.get(k);
    if (g) {
      g.sum += r.starRating;
      g.n += 1;
    } else by.set(k, { sum: r.starRating, n: 1, sample: r });
  }
  const out: MatchAgg[] = [];
  for (const [k, g] of by) {
    out.push({
      key: k,
      venue: g.sample.fieldTitle,
      city: g.sample.city,
      manager: reviewManagerName(g.sample),
      date: g.sample.startDate,
      avg: g.sum / g.n,
      reviews: g.n,
    });
  }
  return out;
}

// group filtered reviews into per-manager aggregates (empty key = unattributed)
function managerAggs(rows: ReviewRow[]): {
  managers: ManagerAgg[];
  unattributed: { avg: number; reviews: number; matches: number } | null;
} {
  const by = new Map<
    string,
    { first: string | null; last: string | null; sum: number; n: number; cities: Map<string, number>; matches: Set<string> }
  >();
  for (const r of rows) {
    const k = managerKey(r);
    const g = by.get(k);
    if (g) {
      g.sum += r.starRating;
      g.n += 1;
      g.cities.set(r.city, (g.cities.get(r.city) ?? 0) + 1);
      g.matches.add(matchKeyOf(r));
    } else {
      const cm = new Map<string, number>([[r.city, 1]]);
      by.set(k, {
        first: r.managerFirstName,
        last: r.managerLastName,
        sum: r.starRating,
        n: 1,
        cities: cm,
        matches: new Set([matchKeyOf(r)]),
      });
    }
  }
  const managers: ManagerAgg[] = [];
  let unattr: { avg: number; reviews: number; matches: number } | null = null;
  for (const [k, g] of by) {
    if (!k) {
      unattr = { avg: g.sum / g.n, reviews: g.n, matches: g.matches.size };
      continue;
    }
    let topCity = "";
    let topCount = 0;
    for (const [c, n] of g.cities)
      if (n > topCount) {
        topCount = n;
        topCity = c;
      }
    managers.push({
      key: k,
      name: managerDisplayName(g.first, g.last),
      city: topCity,
      avg: g.sum / g.n,
      reviews: g.n,
      matches: g.matches.size,
    });
  }
  return { managers, unattributed: unattr };
}

export function derivePage(rows: ReviewRow[], f: PageFilters): PageDerived {
  // one predicate for the whole page
  const filtered = rows.filter((r) => {
    if (!inMonth(r, f.month)) return false;
    if (f.city !== "all" && canonCity(r.city) !== canonCity(f.city)) return false;
    if (f.venue !== "all" && r.fieldTitle !== f.venue) return false;
    if (f.mgr !== "all" && (reviewManagerName(r) ?? "Unattributed") !== f.mgr) return false;
    return true;
  });

  const venueMode = f.venue !== "all";
  const { managers, unattributed } = managerAggs(filtered);
  const matches = matchAggs(filtered);

  // Single source: reviews, matches and avg all fall out of the one filtered
  // array. A "match" is a distinct (field, start) group, so matches.length is
  // exactly the distinct match count, and reviews is the review count — the
  // manager table's per-manager matches sum to the same total. In venue mode the
  // manager aggregate is simply not ranked (below), never a different number.
  const reviews = filtered.length;
  const sumStar = filtered.reduce((s, r) => s + r.starRating, 0);
  const matchCount = matches.length;

  const ranked = managers
    .filter((m) => m.reviews >= MIN_RANK_REVIEWS)
    .sort((a, b) => b.avg - a.avg || b.reviews - a.reviews);
  const unranked = managers
    .filter((m) => m.reviews < MIN_RANK_REVIEWS)
    .sort((a, b) => b.reviews - a.reviews);

  const attn = matches
    .filter((m) => m.avg < ATTN_MAX_AVG && m.reviews >= ATTN_MIN_REVIEWS)
    .sort((a, b) => a.avg - b.avg);
  const stand = matches
    .filter((m) => m.avg >= STAND_MIN_AVG && m.reviews >= STAND_MIN_REVIEWS)
    .sort((a, b) => b.avg - a.avg || b.reviews - a.reviews);

  return {
    venueMode,
    avg: filtered.length ? sumStar / filtered.length : null,
    reviews,
    matches: matchCount,
    ranked,
    unranked,
    unattributed,
    attn,
    stand,
  };
}

// ── 8-week trailing strip (global — not the page filters, per the mockup) ──
export type Week = { start: Date; label: string; count: number; avg: number; partial: boolean };
export type WeeksDerived = {
  weeks: Week[];
  totalVolume: number;
  weightedAvg: number;
  ratingLo: number; // printed band bounds (zoomed, contain every point)
  ratingHi: number;
  ratingLoActual: number; // actual min/max week avg (for the "moved between" copy)
  ratingHiActual: number;
  ratingSpread: number;
  volLo: number;
  volHi: number;
  maxVolume: number;
};

function monday(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon = 0
  x.setDate(x.getDate() - dow);
  return x;
}

export function deriveWeeks(rows: ReviewRow[], now: Date, weeksBack = 8): WeeksDerived {
  const curMon = monday(now);
  const weeks: Week[] = [];
  for (let i = weeksBack - 1; i >= 0; i--) {
    const ws = new Date(curMon.getFullYear(), curMon.getMonth(), curMon.getDate() - 7 * i);
    weeks.push({
      start: ws,
      label: `${MO[ws.getMonth()]} ${ws.getDate()}`,
      count: 0,
      avg: 0,
      partial: ws.getTime() + 7 * DAY_MS > now.getTime(),
    });
  }
  const sums = new Array(weeksBack).fill(0);
  const counts = new Array(weeksBack).fill(0);
  const earliest = weeks[0].start.getTime();
  const latest = weeks[weeksBack - 1].start.getTime() + 7 * DAY_MS;
  for (const r of rows) {
    const t = r.startDate.getTime();
    if (t < earliest || t >= latest) continue;
    const idx = Math.floor((t - earliest) / (7 * DAY_MS));
    if (idx < 0 || idx >= weeksBack) continue;
    sums[idx] += r.starRating;
    counts[idx] += 1;
  }
  let totalVolume = 0;
  let weightedSum = 0;
  for (let i = 0; i < weeksBack; i++) {
    weeks[i].count = counts[i];
    weeks[i].avg = counts[i] ? sums[i] / counts[i] : 0;
    totalVolume += counts[i];
    weightedSum += sums[i];
  }
  const withData = weeks.filter((w) => w.count > 0);
  const avgs = withData.map((w) => w.avg);
  const minA = avgs.length ? Math.min(...avgs) : 4.5;
  const maxA = avgs.length ? Math.max(...avgs) : 5;
  // zoomed rating band, rounded to 0.05, guaranteed to contain every point
  let ratingLo = Math.floor((minA - 0.005) * 20) / 20;
  let ratingHi = Math.ceil((maxA + 0.005) * 20) / 20;
  if (ratingHi - ratingLo < 0.1) {
    ratingLo = Math.max(1, ratingLo - 0.05);
    ratingHi = Math.min(5, ratingHi + 0.05);
  }
  ratingLo = Math.max(1, ratingLo);
  ratingHi = Math.min(5, ratingHi);
  const vols = weeks.map((w) => w.count);
  const maxVolume = Math.max(1, ...vols);
  return {
    weeks,
    totalVolume,
    weightedAvg: totalVolume ? weightedSum / totalVolume : 0,
    ratingLo,
    ratingHi,
    ratingLoActual: minA,
    ratingHiActual: maxA,
    ratingSpread: maxA - minA,
    volLo: Math.min(...vols),
    volHi: Math.max(...vols),
    maxVolume,
  };
}

// ── Comments ──
export type CommentWindow = "week" | "month" | "d30";
export type ResolvedWindow = { a: Date; b: Date; label: string; note: string };

export function commentWindow(win: CommentWindow, now: Date): ResolvedWindow {
  let a: Date;
  let b: Date;
  let note: string;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (win === "week") {
    a = monday(today);
    b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 6);
    note = "this week";
  } else if (win === "month") {
    a = new Date(today.getFullYear(), today.getMonth(), 1);
    b = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    note = "this month";
  } else {
    a = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    b = today;
    note = "last 30 days";
  }
  const label = `${MO[a.getMonth()]} ${a.getDate()} – ${MO[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`;
  if (b.getTime() > today.getTime()) note += `, through ${MO[today.getMonth()]} ${today.getDate()}`;
  return { a, b, label, note };
}

export function hasText(r: ReviewRow): boolean {
  return !!(r.comment && r.comment.trim());
}
// Included in the comments panel: any written comment, plus 1★ left wordless.
export function isCommentRow(r: ReviewRow): boolean {
  return hasText(r) || r.starRating === 1;
}
// A reply is OWED at 3★ and below.
export function needsReply(r: ReviewRow): boolean {
  return r.starRating <= 3;
}

export type CommentsDerived = {
  window: ResolvedWindow;
  included: ReviewRow[]; // newest first
  withText: number;
  silent1: number;
  all: number;
  needs: number;
  praise: number;
};

export function deriveComments(
  rows: ReviewRow[],
  win: CommentWindow,
  f: Omit<PageFilters, "month">,
  now: Date,
): CommentsDerived {
  const w = commentWindow(win, now);
  const inWin = rows.filter((r) => {
    const d = new Date(r.startDate.getFullYear(), r.startDate.getMonth(), r.startDate.getDate());
    if (d < w.a || d > w.b) return false;
    if (f.city !== "all" && canonCity(r.city) !== canonCity(f.city)) return false;
    if (f.venue !== "all" && r.fieldTitle !== f.venue) return false;
    if (f.mgr !== "all" && (reviewManagerName(r) ?? "Unattributed") !== f.mgr) return false;
    return isCommentRow(r);
  });
  inWin.sort((p, q) => q.startDate.getTime() - p.startDate.getTime());
  return {
    window: w,
    included: inWin,
    withText: inWin.filter(hasText).length,
    silent1: inWin.filter((r) => !hasText(r) && r.starRating === 1).length,
    all: inWin.length,
    needs: inWin.filter(needsReply).length,
    praise: inWin.filter((r) => r.starRating === 5).length,
  };
}

// ── Phase 26c — NOT REVIEWED + group-by-match ────────────────────────────────

// NOT REVIEWED = owed a reply (<=3★) and nobody has resolved it yet. This replaces the old
// "Needs a reply" / "Unanswered" pair, which differed only by whether a resolution mark existed:
// "Needs a reply" counted the whole <=3★ workload INCLUDING rows already handled, "Unanswered"
// counted only the outstanding part. The outstanding part is the actionable one, so it is the one
// that survives. A resolution is EITHER kind — "replied" or "no_reply_needed"; both close the row.
// `resolved` is anything keyed by apiId that answers has() — the live page passes the
// review_replies Map; tests pass a Set. Either kind of mark ("replied" / "no_reply_needed") counts
// as resolved, which is why membership is all we ask.
export type ResolvedLookup = { has(apiId: number): boolean };
export function isNotReviewed(r: ReviewRow, resolved: ResolvedLookup): boolean {
  return needsReply(r) && !resolved.has(r.apiId);
}
export function notReviewedRows(rows: ReviewRow[], resolved: ResolvedLookup): ReviewRow[] {
  return rows.filter((r) => isNotReviewed(r, resolved));
}

const startMs = (r: ReviewRow): number | null =>
  r.startDate instanceof Date && !Number.isNaN(r.startDate.getTime()) ? r.startDate.getTime() : null;

// Newest match first — the page's convention everywhere else. A match with NO start time sorts
// LAST (never first with a blank), and all of them land together because they compare equal.
// NOTE: useReviewData drops rows whose start_date will not parse, so this branch cannot trigger
// with today's data — it exists so the ordering is correct if that filter is ever relaxed.
export function compareByMatchStart(a: ReviewRow, b: ReviewRow): number {
  const x = startMs(a), y = startMs(b);
  if (x === null && y === null) return 0;
  if (x === null) return 1;   // undated last
  if (y === null) return -1;
  return y - x;               // newest first
}

export type MatchGroup = {
  key: string;
  fieldTitle: string;
  startDate: Date | null;   // null == no start time on record
  city: string;
  manager: string | null;
  count: number;            // reviews in this group — must equal rows.length
  avgRating: number;        // mean star rating for the match, 1 decimal at render
  rows: ReviewRow[];
};

// Group already-filtered rows by match, ordered by match start (newest first, undated last).
// Row order WITHIN a group is preserved from the input.
export function groupByMatch(rows: ReviewRow[]): MatchGroup[] {
  const byKey = new Map<string, ReviewRow[]>();
  for (const r of rows) {
    const k = matchKeyOf(r);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const groups: MatchGroup[] = [];
  for (const [key, list] of byKey) {
    const s = list[0];
    const sum = list.reduce((a, r) => a + (Number(r.starRating) || 0), 0);
    groups.push({
      key,
      fieldTitle: s.fieldTitle,
      startDate: startMs(s) === null ? null : s.startDate,
      city: s.city,
      manager: reviewManagerName(s),
      count: list.length,
      avgRating: list.length ? sum / list.length : 0,
      rows: list,
    });
  }
  groups.sort((g1, g2) => {
    const a = g1.startDate ? g1.startDate.getTime() : null;
    const b = g2.startDate ? g2.startDate.getTime() : null;
    if (a === null && b === null) return g1.fieldTitle.localeCompare(g2.fieldTitle);
    if (a === null) return 1;
    if (b === null) return -1;
    return b - a;
  });
  return groups;
}
