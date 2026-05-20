// Per-match unit P&L for the Match P&L subtab on /admin/finance/field-costs.
//
// Pipeline:
//   1. Fetch match_registrations for one Mon-Sun week (current upload).
//      One paginated fetch with stable .order("id"); the result feeds
//      both the active and canceled sections.
//   2. Split rows into active (match_canceled=false) and canceled
//      (match_canceled=true) buckets.
//   3. Active path:
//      a. Drop player-canceled rows.
//      b. Filter on payment_type — explicit allow-list of player
//         booking types ("DAILY PAID", "MEMBER"). Defensive: rentals
//         are not in match_registrations by data-model design, but if
//         any do leak in (admin imports, bugs), they'd typically have
//         a different payment_type and would be excluded here.
//      c. Resolve field → venue via the canonical longest-prefix match
//         using the same buildFieldToVenueMap pattern as projections.
//      d. Aggregate by (venueId, match_start) → spotsSold, grossRevenue.
//         spotsSold counts ALL non-canceled fills (DPP + Member);
//         grossRevenue sums match_price_paid (members are $0).
//      e. Look up venue.cost_per_match. Compute net = gross − cost.
//      f. Bin by status: < -10 loss, [-10, 10] breakeven, > 10 profit.
//         Missing cost_per_match → "missing-cost" status.
//   4. Canceled path:
//      a. Distinct (venueId, match_start) — one row per canceled match.
//      b. Spots and gross are structurally 0 (refund policy: a canceled
//         match earns nothing regardless of pre-cancellation registrations).
//      c. fieldCost = venue.cost_per_match (you paid the venue anyway).
//      d. net = -fieldCost (or null if cost not set). Status "canceled".
//      e. KNOWN LIMITATION: canceled matches with zero registrations
//         don't appear in match_registrations, so they can't be
//         surfaced from this data source.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FinanceData } from "./useFinanceData";
import { matchAllocatedMemberRevenueFor } from "./financeStats";
import { fetchLegacyMatchRegistrations } from "./mdapiMatchesRead";
import { buildFieldIdToVenueIdMap, resolveVenueForMatch } from "./venueNormalization";

// Allow-list of player-booking payment types. Anything else (NULL,
// rental codes, comp markers) gets filtered out as not a real
// fill-the-spots booking event.
const ALLOWED_PAYMENT_TYPES = new Set(["DAILY PAID", "MEMBER"]);

export type MatchPnLStatus =
  | "loss"
  | "breakeven"
  | "profit"
  | "missing-cost"
  | "canceled";

export type MatchPnLRow = {
  // Identity
  matchStartIso: string; // raw, for keys
  matchStart: Date;
  venueId: number | null;
  venueRawName: string;
  venueDisplayName: string;
  city: string;
  // Display helpers (precomputed for sortability)
  dayLabel: string; // "Mon"
  timeLabel: string; // "7:30 PM"
  // Metrics
  spotsSold: number; // total fills (DPP + Member)
  memberSpots: number; // subset of spotsSold; drives allocatedMemberRev
  grossRevenue: number; // DPP only — members pay $0 per match
  // Pro-rata share of the venue's month membership rev. See
  // matchAllocatedMemberRevenueFor in financeStats.ts. Reconciles
  // with Field Ranking's per-venue-month total when summed across
  // a venue's matches in a month.
  allocatedMemberRev: number;
  fieldCost: number | null;
  // net = grossRevenue + allocatedMemberRev − fieldCost. Null when
  // fieldCost is null (cost not set on venue).
  net: number | null;
  status: MatchPnLStatus;
};

export type MatchPnLSummary = {
  totalMatches: number;
  totalRevenue: number; // DPP gross
  totalMemberRev: number; // allocated member rev
  totalMemberSpots: number; // count of MEMBER fills across all matches
  totalFieldCost: number; // sum across rows where cost is known
  net: number; // (totalRevenue + totalMemberRev) − totalFieldCost
  losingMatches: number;
  matchesWithoutCost: number;
};

// =====================================================================
// Status binning
// =====================================================================

export function statusFor(net: number | null): MatchPnLStatus {
  if (net === null) return "missing-cost";
  if (net < -10) return "loss";
  if (net <= 10) return "breakeven";
  return "profit";
}

// Field → venue resolution lives in venueNormalization.ts
// (buildFieldToVenueIdMap). Was a substring-match copy here that
// dropped synonym pairs like "Katy International Sports Complex" →
// "KISC (Katy Intl)" since they share no substring. The central
// resolver runs the field through normalizeMatchName first, so
// CROSS_VENUE_ALIASES + INTERNAL_PREFIX_RULES catch those.

// =====================================================================
// Display formatters
// =====================================================================

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayLabelFromDate(d: Date): string {
  return DOW_SHORT[d.getDay()];
}

function timeLabelFromDate(d: Date): string {
  let hr = d.getHours();
  const mn = d.getMinutes();
  const ampm = hr >= 12 ? "PM" : "AM";
  hr = hr % 12;
  if (hr === 0) hr = 12;
  return mn === 0
    ? `${hr}:00 ${ampm}`
    : `${hr}:${String(mn).padStart(2, "0")} ${ampm}`;
}

// "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS" / etc → local Date.
// Mirrors useMatchData's parseLocal so timezones don't shift matches
// across day boundaries.
function parseLocalTimestamp(s: string): Date | null {
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 3) return null;
  const [yr, mo, dy, hr = "0", mn = "0"] = parts;
  const [y, m, d, h, n] = [yr, mo, dy, hr, mn].map(Number);
  if ([y, m, d, h, n].some((x) => Number.isNaN(x))) return null;
  return new Date(y, m - 1, d, h, n);
}

// =====================================================================
// Fetch + compute
// =====================================================================

// Subset of LegacyMatchRegRow that this file actually consumes.
// Sourced from mdapi_matches + mdapi_match_players via the shared
// mdapiMatchesRead lib. Field shape kept identical to the CSV-era
// match_registrations row so the bucketing logic below stays
// unchanged.
type RegRow = {
  field: string;
  field_id: number | null;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  match_price_paid: number;
};

export type FetchWeekMatchPnLResult = {
  active: MatchPnLRow[];
  canceled: MatchPnLRow[];
};

export async function fetchWeekMatchPnL(
  supabase: SupabaseClient,
  weekStart: Date,
  weekEnd: Date, // Sunday end-of-day
  data: FinanceData,
): Promise<FetchWeekMatchPnLResult> {
  const venues = data.venues;

  // Fetch matches+players from mdapi_matches/mdapi_match_players via
  // the shared lib. Date filter is on mdapi_matches.start_date —
  // YYYY-MM-DD bounds (the lib's gte/lte map to Postgres timestamptz
  // comparisons that correctly span the local week).
  const ymd = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const regs: RegRow[] = await fetchLegacyMatchRegistrations(supabase, {
    fromDate: ymd(weekStart),
    toDate: ymd(weekEnd),
  });

  // Split into canceled (match_canceled=true) and active (the rest).
  // Canceled rows skip the active filter chain entirely — they go
  // straight to the canceled bucketing pass.
  const canceledRegs = regs.filter((r) => !!r.field && r.match_canceled);
  const activeEligible = regs.filter(
    (r) =>
      !!r.field &&
      !r.match_canceled &&
      !(
        r.player_canceled_at && r.player_canceled_at.trim() !== ""
      ) &&
      ALLOWED_PAYMENT_TYPES.has((r.payment_type ?? "").toUpperCase()),
  );

  // PR-E: build the field_id → fin_venues.id map from
  // data.venueFields (fin_venue_fields, populated by migration 0041).
  // Field-title canonicalization via venueAliases is no longer the
  // join key — field_id is. Rows with null field_id (older mdapi
  // syncs) fall out of the resolver.
  const fieldIds = new Set<number>();
  for (const r of activeEligible) {
    if (r.field_id != null) fieldIds.add(r.field_id);
  }
  for (const r of canceledRegs) {
    if (r.field_id != null) fieldIds.add(r.field_id);
  }
  const fieldToVenue = buildFieldIdToVenueIdMap(fieldIds, data.venueFields);
  const venueById = new Map(venues.map((v) => [v.id, v]));

  // ===== Active aggregation =====
  // Aggregate by (venueId-or-rawField, match_start). Keying off
  // venueId when resolved, raw field otherwise — unresolved fields
  // still produce rows so the operator sees them as "no venue
  // match" rather than silently dropping.
  type Bucket = {
    matchStartIso: string;
    matchStart: Date;
    venueId: number | null;
    venueRawName: string;
    venueDisplayName: string;
    city: string;
    spotsSold: number;
    memberSpots: number;
    grossRevenue: number;
    // Day-aware cost captured at row time so the bucket records the
    // resolved rate (incl. the sibling-cost-null fallback to base
    // venue's rate). See resolveVenueForMatch.
    cost: number | null;
  };
  const buckets = new Map<string, Bucket>();
  for (const r of activeEligible) {
    const matchStart = parseLocalTimestamp(r.match_start);
    if (!matchStart) continue;
    const baseVenueId =
      r.field_id != null ? (fieldToVenue.get(r.field_id) ?? null) : null;
    // Day-of-week swap: ATH Katy + Sun match → ATH Katy Sunday venue.
    // Sibling missing-cost falls back to base rate with a console.warn.
    const resolved =
      baseVenueId !== null
        ? resolveVenueForMatch(baseVenueId, matchStart, venues)
        : null;
    const venueId = resolved?.venueId ?? null;
    const venue = venueId !== null ? (venueById.get(venueId) ?? null) : null;
    const key = `${venueId ?? `raw:${r.field}`}|${r.match_start}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        matchStartIso: r.match_start,
        matchStart,
        venueId,
        venueRawName: venue?.raw_venue_name ?? (r.field as string),
        venueDisplayName: venue?.venue_name ?? (r.field as string),
        city: venue?.city ?? "—",
        spotsSold: 0,
        memberSpots: 0,
        grossRevenue: 0,
        cost: resolved?.cost ?? null,
      };
      buckets.set(key, b);
    }
    b.spotsSold += 1;
    if ((r.payment_type ?? "").toUpperCase() === "MEMBER") {
      b.memberSpots += 1;
    } else {
      b.grossRevenue += Number(r.match_price_paid ?? 0) || 0;
    }
  }

  const active: MatchPnLRow[] = [];
  for (const b of buckets.values()) {
    const venue = b.venueId !== null ? (venueById.get(b.venueId) ?? null) : null;
    const cost = b.cost;
    // Allocated member rev: pro-rata of the venue's monthly membership
    // rev (Field Ranking's number) split across the month's matches
    // in proportion to MEMBER fills at each match. Returns 0 cleanly
    // when memberSpots=0, when venue is unresolved, or when the match
    // falls outside Q2 — see helper for edge-case handling.
    const allocatedMemberRev =
      venue && b.memberSpots > 0
        ? matchAllocatedMemberRevenueFor(data, {
            city: b.city,
            venueName: venue.venue_name,
            matchStartIso: b.matchStartIso,
            memberSpots: b.memberSpots,
          })
        : 0;
    const net =
      cost === null ? null : b.grossRevenue + allocatedMemberRev - cost;
    active.push({
      matchStartIso: b.matchStartIso,
      matchStart: b.matchStart,
      venueId: b.venueId,
      venueRawName: b.venueRawName,
      venueDisplayName: b.venueDisplayName,
      city: b.city,
      dayLabel: dayLabelFromDate(b.matchStart),
      timeLabel: timeLabelFromDate(b.matchStart),
      spotsSold: b.spotsSold,
      memberSpots: b.memberSpots,
      grossRevenue: b.grossRevenue,
      allocatedMemberRev,
      fieldCost: cost,
      net,
      status: statusFor(net),
    });
  }

  // ===== Canceled aggregation =====
  // Distinct (venueId, match_start) — one row per canceled match.
  // Spots and gross are structurally zero (refund policy). Field
  // cost still applies; net = -fieldCost.
  const canceledSeen = new Set<string>();
  const canceled: MatchPnLRow[] = [];
  for (const r of canceledRegs) {
    const matchStart = parseLocalTimestamp(r.match_start);
    if (!matchStart) continue;
    const baseVenueId =
      r.field_id != null ? (fieldToVenue.get(r.field_id) ?? null) : null;
    const resolved =
      baseVenueId !== null
        ? resolveVenueForMatch(baseVenueId, matchStart, venues)
        : null;
    const venueId = resolved?.venueId ?? null;
    const key = `${venueId ?? `raw:${r.field}`}|${r.match_start}`;
    if (canceledSeen.has(key)) continue;
    canceledSeen.add(key);
    const venue = venueId !== null ? (venueById.get(venueId) ?? null) : null;
    const cost = resolved?.cost ?? null;
    canceled.push({
      matchStartIso: r.match_start,
      matchStart,
      venueId,
      venueRawName: venue?.raw_venue_name ?? (r.field as string),
      venueDisplayName: venue?.venue_name ?? (r.field as string),
      city: venue?.city ?? "—",
      dayLabel: dayLabelFromDate(matchStart),
      timeLabel: timeLabelFromDate(matchStart),
      spotsSold: 0,
      memberSpots: 0,
      grossRevenue: 0,
      // Canceled match → no members attended → zero allocation. The
      // upload-time fin_member_spots aggregate already excludes
      // canceled matches' rows, so we stay reconciled with the
      // venue-month totals.
      allocatedMemberRev: 0,
      fieldCost: cost,
      net: cost === null ? null : -cost,
      status: "canceled",
    });
  }

  return { active, canceled };
}

export type CanceledSummary = {
  totalMatches: number;
  // Sum of fieldCost across canceled matches whose venue has a
  // cost_per_match set. Matches without a cost contribute zero
  // (and are surfaced separately in matchesWithoutCost).
  sunkCost: number;
  matchesWithoutCost: number;
};

export function summarizeCanceled(rows: MatchPnLRow[]): CanceledSummary {
  let sunkCost = 0;
  let matchesWithoutCost = 0;
  for (const r of rows) {
    if (r.fieldCost === null) matchesWithoutCost++;
    else sunkCost += r.fieldCost;
  }
  return { totalMatches: rows.length, sunkCost, matchesWithoutCost };
}

export function summarize(rows: MatchPnLRow[]): MatchPnLSummary {
  let totalRevenue = 0;
  let totalMemberRev = 0;
  let totalMemberSpots = 0;
  let totalFieldCost = 0;
  let losingMatches = 0;
  let matchesWithoutCost = 0;
  for (const r of rows) {
    totalRevenue += r.grossRevenue;
    totalMemberRev += r.allocatedMemberRev;
    totalMemberSpots += r.memberSpots;
    if (r.fieldCost !== null) totalFieldCost += r.fieldCost;
    else matchesWithoutCost++;
    if (r.status === "loss") losingMatches++;
  }
  return {
    totalMatches: rows.length,
    totalRevenue,
    totalMemberRev,
    totalMemberSpots,
    totalFieldCost,
    net: totalRevenue + totalMemberRev - totalFieldCost,
    losingMatches,
    matchesWithoutCost,
  };
}
