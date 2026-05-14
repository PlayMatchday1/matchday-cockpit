// Period-Compare aggregation helpers for the Field Ranking → Period
// Compare view. Pure functions; no React, no Supabase. Two period
// generators (monthly / weekly), one DPP aggregator, one
// member-bookings aggregator.
//
// All date math is wall-clock-local — matches the rest of the
// cockpit. fin_revenue.date is a YYYY-MM-DD string in local terms;
// mdapi_match_players.start_date is parsed via parseLocal (slices
// first 16 chars, ignores TZ) in mdapiMatchesRead.ts:192-199, so
// matchStart is already a local Date by the time it gets here.

import type { FinanceData, FinRevenue } from "./useFinanceData";
import type { MatchRow } from "./useMatchData";

// === Period model ============================================

export type Period = {
  // Unique key — stable for caching / React keys
  key: string;
  // Display label, e.g. "Jan 1-14" or "Apr 27 - May 3"
  label: string;
  // Inclusive start (YYYY-MM-DD)
  startIso: string;
  // Inclusive end (YYYY-MM-DD)
  endIso: string;
  // True when the period is the most-recent in-progress one. The
  // current month for Monthly view (truncated at today), or the
  // current ISO week for Weekly view (truncated at today).
  inProgress: boolean;
  // For in-progress weekly cells only: how many of the 7 days have
  // already elapsed (1-7). null for monthly cells.
  daysElapsed: number | null;
};

// === Period generators =======================================

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function pad(n: number): string { return String(n).padStart(2, "0"); }

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate();
}

// Monthly periods: same-day-of-month for the last 5 calendar months
// ending at the current month. If today is May 14, returns
// [Jan 1-14, Feb 1-14, Mar 1-14, Apr 1-14, May 1-14]. If today is
// May 31, the Feb period caps at Feb 28 (the actual last day of
// shorter months). Period count is fixed at 5 — sized to match
// "current YTD" coverage given the cockpit's Jan-Feb-Mar-Apr-May
// backfill window. Returns oldest-first.
export function generateMonthlyPeriods(now: Date = new Date()): Period[] {
  const todayDay = now.getDate();
  const todayMonthIndex = now.getMonth();
  const todayYear = now.getFullYear();
  const out: Period[] = [];
  // Walk back 4 months → current = 5 total
  for (let offset = 4; offset >= 0; offset--) {
    // Step monthIndex back by `offset`. Date constructor normalizes
    // negative monthIndex into the prior year automatically, which
    // is the right behavior for a December today → Aug 4 months back.
    const refMonth = new Date(todayYear, todayMonthIndex - offset, 1);
    const y = refMonth.getFullYear();
    const m = refMonth.getMonth();
    const lastDayOfMonth = daysInMonth(y, m);
    // Same-day-of-month means days 1..todayDay, capped at the month's
    // actual last day (Feb 28/29 caps if today is the 30th).
    const endDay = Math.min(todayDay, lastDayOfMonth);
    const startIso = `${y}-${pad(m + 1)}-01`;
    const endIso = `${y}-${pad(m + 1)}-${pad(endDay)}`;
    out.push({
      key: `m:${y}-${pad(m + 1)}`,
      label: `${SHORT_MONTHS[m]} 1-${endDay}`,
      startIso,
      endIso,
      inProgress: offset === 0,
      daysElapsed: null,
    });
  }
  return out;
}

// Snap a Date to the Monday of its ISO week, local-midnight.
function startOfIsoWeek(d: Date): Date {
  // JS Date.getDay() returns 0 (Sun) ... 6 (Sat). ISO weeks start
  // Monday. Convert: dayOfWeek=0 means today is Sunday → 6 days
  // since Monday; otherwise (dayOfWeek - 1).
  const dayOfWeek = d.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday);
  return monday;
}

// Weekly periods: the current in-progress ISO Mon-Sun week + 7 prior
// complete weeks (8 total). Returns oldest-first. Each cell carries
// inProgress + daysElapsed so the UI can label "in progress, N of 7".
export function generateWeeklyPeriods(now: Date = new Date()): Period[] {
  const currentMonday = startOfIsoWeek(now);
  const out: Period[] = [];
  for (let offset = 7; offset >= 0; offset--) {
    const weekStart = new Date(currentMonday);
    weekStart.setDate(currentMonday.getDate() - offset * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const isCurrent = offset === 0;
    // For the in-progress current week, cap the end at today so the
    // sum only includes days that have actually happened. Prior
    // weeks always span the full Mon-Sun.
    const effectiveEnd = isCurrent && weekEnd > now
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
      : weekEnd;
    const daysElapsed = isCurrent
      ? Math.floor((effectiveEnd.getTime() - weekStart.getTime()) / 86_400_000) + 1
      : null;
    // Label crosses month boundaries cleanly: "Apr 27 - May 3" when
    // a week straddles, "May 4-10" when it doesn't.
    const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
    const label = sameMonth
      ? `${SHORT_MONTHS[weekStart.getMonth()]} ${weekStart.getDate()}-${weekEnd.getDate()}`
      : `${SHORT_MONTHS[weekStart.getMonth()]} ${weekStart.getDate()} - ${SHORT_MONTHS[weekEnd.getMonth()]} ${weekEnd.getDate()}`;
    out.push({
      key: `w:${ymd(weekStart)}`,
      label,
      startIso: ymd(weekStart),
      endIso: ymd(effectiveEnd),
      inProgress: isCurrent,
      daysElapsed,
    });
  }
  return out;
}

// === Aggregators =============================================

// Per-venue per-period DPP $ totals + per-venue per-period member-
// booking counts. Both maps share the same venue-name key set so the
// UI can iterate once and pull from both. Venue names are post-alias
// canonical — fin_revenue.venue is hydrated through venueAliases in
// useFinanceData's mapper, and the matchRegistrations field is
// resolved through the same alias map via buildFieldToVenueIdMap.

export type VenuePeriodTable = {
  // venue_name (canonical, post-alias) → period.key → metric
  byVenue: Map<string, Map<string, number>>;
  // All canonical venue names that appeared in any period. Caller
  // typically takes the union of dppByVenue + memberByVenue to get
  // the row set for the table.
  venues: Set<string>;
};

function emptyTable(): VenuePeriodTable {
  return { byVenue: new Map(), venues: new Set() };
}

function bumpVenuePeriod(t: VenuePeriodTable, venue: string, periodKey: string, delta: number) {
  t.venues.add(venue);
  let inner = t.byVenue.get(venue);
  if (!inner) {
    inner = new Map();
    t.byVenue.set(venue, inner);
  }
  inner.set(periodKey, (inner.get(periodKey) ?? 0) + delta);
}

// Find the period a YYYY-MM-DD date belongs to. Periods don't
// overlap (Monthly's are within distinct calendar months, Weekly's
// are aligned to ISO weeks) so linear scan returns the unique match
// or null. Linear is fine: max 8 periods.
function findPeriod(periods: Period[], dateIso: string): Period | null {
  for (const p of periods) {
    if (dateIso >= p.startIso && dateIso <= p.endIso) return p;
  }
  return null;
}

// DPP — fin_revenue rows with type='DPP' AND source='Stripe',
// grouped by canonical venue × period, summed by gross. Excludes
// PROJECTION rows (those have venue='N/A' and aren't per-venue
// per-day) — matches the existing Field Ranking dpp filter chain
// in financeStats.ts:1632 and 2687.
export function aggregateDppByVenue(
  revenue: FinRevenue[],
  periods: Period[],
): VenuePeriodTable {
  const t = emptyTable();
  for (const r of revenue) {
    if (r.type !== "DPP") continue;
    if (r.source !== "Stripe") continue;
    if (!r.venue || r.venue === "N/A") continue;
    if (!r.date) continue;
    const period = findPeriod(periods, r.date);
    if (!period) continue;
    bumpVenuePeriod(t, r.venue, period.key, r.gross ?? 0);
  }
  return t;
}

// Member bookings — count of mdapi_match_players rows where
// paymentType === "MEMBER" (i.e., paid_status='FREE' per
// derivePaymentType in mdapiMatchesRead.ts:216), bucketed by the
// canonical venue and the period containing match_start. Match-
// canceled rows and player-canceled rows are dropped — same filter
// chain matchPnL / the member-spot index use.
//
// venueCanonicalByField is a (raw match-feed name) → (canonical
// venue_name) lookup built from FinanceData.venues + venueAliases
// via buildFieldToVenueIdMap. Rows whose field doesn't resolve to a
// known venue are dropped (rare; usually a brand-new venue without
// an alias entry yet).
export function aggregateMemberBookingsByVenue(
  matchRegistrations: MatchRow[],
  periods: Period[],
  venueCanonicalByField: Map<string, string>,
): VenuePeriodTable {
  const t = emptyTable();
  for (const r of matchRegistrations) {
    if (r.matchCanceled) continue;
    if (r.playerCanceledAt !== null) continue;
    if (r.paymentType !== "MEMBER") continue;
    if (!r.matchStart) continue;
    // r.matchStart is already a wall-clock-local Date.
    const dateIso = ymd(r.matchStart);
    const period = findPeriod(periods, dateIso);
    if (!period) continue;
    const venue = venueCanonicalByField.get(r.field);
    if (!venue) continue;
    bumpVenuePeriod(t, venue, period.key, 1);
  }
  return t;
}

// MoM/WoW delta for a value vs its prior period. Returns a record
// with the raw delta and the pct change (null when prior is zero —
// caller decides whether to render "—" or "+∞" or similar).
export type Delta = { absolute: number; pct: number | null };

export function computeDelta(curr: number, prior: number | null | undefined): Delta {
  if (prior === null || prior === undefined) return { absolute: 0, pct: null };
  const absolute = curr - prior;
  if (prior === 0) {
    return { absolute, pct: curr === 0 ? 0 : null };
  }
  return { absolute, pct: Math.round((absolute / prior) * 1000) / 10 };
}

// Total $ across all venues for a period (Total row in the UI).
export function periodColumnTotal(table: VenuePeriodTable, periodKey: string): number {
  let sum = 0;
  for (const inner of table.byVenue.values()) {
    sum += inner.get(periodKey) ?? 0;
  }
  return sum;
}
