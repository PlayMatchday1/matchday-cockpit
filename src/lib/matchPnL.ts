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

// =====================================================================
// Field → venue resolution (longest-prefix match, same pattern as
// projectionsStats and partnerStats — copied here so this lib stays
// self-contained for the targeted-week fetch).
// =====================================================================

function buildFieldToVenueMap(
  fields: Set<string>,
  venues: { id: number; venue_name: string; raw_venue_name: string }[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const field of fields) {
    const lf = field.toLowerCase();
    let best: { id: number; nameLen: number; rawName: string } | null = null;
    for (const v of venues) {
      // Match on raw_venue_name first (preserves split-rate venue
      // distinctions like ATH Katy vs ATH Katy Sunday) — fall back
      // to canonical venue_name if no raw match.
      const candidates = [v.raw_venue_name, v.venue_name];
      for (const cand of candidates) {
        const lc = cand.toLowerCase();
        if (!lc || !lf.includes(lc)) continue;
        if (
          !best ||
          lc.length > best.nameLen ||
          (lc.length === best.nameLen && cand < best.rawName)
        ) {
          best = { id: v.id, nameLen: lc.length, rawName: cand };
        }
        break;
      }
    }
    if (best) map.set(field, best.id);
  }
  return map;
}

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

type RegRow = {
  field: string | null;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  match_price_paid: number | null;
};

async function fetchCurrentUploadId(
  supabase: SupabaseClient,
): Promise<number | null> {
  const { data } = await supabase
    .from("data_uploads")
    .select("id")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: number }>();
  return data?.id ?? null;
}

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
  const uploadId = await fetchCurrentUploadId(supabase);
  if (uploadId === null) return { active: [], canceled: [] };

  // ISO bounds — match_start is stored as a timestamp; use a wide
  // string range that covers the local Mon 00:00 → Sun 23:59:59.
  const isoStart = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, "0")}-${String(weekStart.getDate()).padStart(2, "0")}T00:00:00`;
  const isoEnd = `${weekEnd.getFullYear()}-${String(weekEnd.getMonth() + 1).padStart(2, "0")}-${String(weekEnd.getDate()).padStart(2, "0")}T23:59:59`;

  const regs: RegRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("match_registrations")
      .select(
        "field, match_start, match_canceled, player_canceled_at, payment_type, match_price_paid",
      )
      .eq("upload_id", uploadId)
      .gte("match_start", isoStart)
      .lte("match_start", isoEnd)
      // Stable ordering required for paginated .range() — without an
      // ORDER BY, Postgres can return rows in different orders across
      // page queries, silently dropping or duplicating rows.
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`Match P&L fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    regs.push(...(data as RegRow[]));
    if (data.length < 1000) break;
  }

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

  // Build a single field-to-venue map covering both buckets so the
  // resolver does the same work for canceled matches as for active.
  const fields = new Set<string>();
  for (const r of activeEligible) if (r.field) fields.add(r.field);
  for (const r of canceledRegs) if (r.field) fields.add(r.field);
  const fieldToVenue = buildFieldToVenueMap(fields, venues);
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
  };
  const buckets = new Map<string, Bucket>();
  for (const r of activeEligible) {
    const matchStart = parseLocalTimestamp(r.match_start);
    if (!matchStart) continue;
    const venueId = fieldToVenue.get(r.field as string) ?? null;
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
    const cost = venue?.cost_per_match ?? null;
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
    const venueId = fieldToVenue.get(r.field as string) ?? null;
    const key = `${venueId ?? `raw:${r.field}`}|${r.match_start}`;
    if (canceledSeen.has(key)) continue;
    canceledSeen.add(key);
    const venue = venueId !== null ? (venueById.get(venueId) ?? null) : null;
    const cost = venue?.cost_per_match ?? null;
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
  let totalFieldCost = 0;
  let losingMatches = 0;
  let matchesWithoutCost = 0;
  for (const r of rows) {
    totalRevenue += r.grossRevenue;
    totalMemberRev += r.allocatedMemberRev;
    if (r.fieldCost !== null) totalFieldCost += r.fieldCost;
    else matchesWithoutCost++;
    if (r.status === "loss") losingMatches++;
  }
  return {
    totalMatches: rows.length,
    totalRevenue,
    totalMemberRev,
    totalFieldCost,
    net: totalRevenue + totalMemberRev - totalFieldCost,
    losingMatches,
    matchesWithoutCost,
  };
}
