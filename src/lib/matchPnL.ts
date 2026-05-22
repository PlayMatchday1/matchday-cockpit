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
import { cityMembershipRevenueFor } from "./financeStats";
import {
  fetchLegacyMatchRegistrations,
  hasActiveSubAtMatchTime,
  loadActiveSubscriptionsByEmail,
} from "./mdapiMatchesRead";
import { buildFieldIdToVenueIdMap, resolveVenueForMatch } from "./venueNormalization";
import { selectAll } from "./supabasePagination";

// Allow-list of real-attendee payment types. Spots Booked counts every
// non-promo, non-guest fill regardless of payment shape. PROMOCODE
// rows are excluded entirely — they're a separate channel that
// doesn't belong in the Match P&L view.
const ALLOWED_PAYMENT_TYPES = new Set([
  "DAILY PAID",
  "MEMBER",
  "FREE_NON_MEMBER",
]);

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
  // Total non-cancelled attendees: MEMBER + DPP + PROMOCODE + FREE_NON_MEMBER.
  spotsSold: number;
  // DAILY PAID only (excludes MEMBER, FREE_NON_MEMBER, PROMOCODE).
  // The "real cash gate count" for that match.
  paidSpots: number;
  // Subscription-joined members only. Drives allocatedMemberRev and
  // the city-month byCityMonth denominator.
  memberSpots: number;
  // paid_status='FREE' rows whose email did NOT match an ACTIVE
  // subscription at match time (first-match-free signups, guest
  // passes, manager-added fills). Surfaced as "+N free" next to
  // Spots Booked so operators can see when comps inflate the count.
  freeNonMemberSpots: number;
  // DPP gate revenue: sum of match_price_paid for DAILY PAID rows
  // only. Promo and free spots contribute $0.
  grossRevenue: number;
  // Member play valued at the April benchmark rate:
  //   memberSpots × (cityAprMembershipRev / cityAprMemberSpots).
  // NOT collected membership revenue — that lives only in fin_revenue
  // and is surfaced on the /finance Cities tab. This column is a
  // stable per-spot valuation so the per-row figure reconciles with
  // the April benchmark sub-line on the city header, instead of
  // drifting month-by-month under the prior match-month allocation.
  allocatedMemberRev: number;
  // Sum of credit_amount across every non-cancelled, non-fake,
  // non-absent player row at this match. Already included in
  // grossRevenue via the booking-value amount; surfaced as its own
  // column to make credit usage visible without changing the DPP
  // math.
  credit: number;
  fieldCost: number | null;
  // net = grossRevenue + allocatedMemberRev − fieldCost. Null when
  // fieldCost is null (cost not set on venue).
  net: number | null;
  status: MatchPnLStatus;
  // True for Soccer Central matches with max_player_count > 22 —
  // those use two side-by-side 9v9 fields and bill $120 instead of
  // $60. Drives the "Tournament" badge on the venue-name cell and
  // selects the Soccer Central Tournament fin_venues row for the
  // venueId / fieldCost on this row. False for non-SC venues and
  // for SC matches at ≤22 capacity.
  isTournament: boolean;
};

export type MatchPnLSummary = {
  totalMatches: number;
  totalRevenue: number; // DPP gross
  totalMemberRev: number; // member spots valued at April rate
  totalMemberSpots: number; // count of MEMBER fills across all matches
  totalPaidSpots: number; // count of DAILY PAID fills across all matches
  totalCredit: number; // sum of credit_amount across all matches
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
// mdapiMatchesRead lib.
type RegRow = {
  field: string;
  field_id: number | null;
  email: string | null;
  match_start: string;
  match_canceled: boolean;
  player_canceled_at: string | null;
  payment_type: string | null;
  match_price_paid: number;
  credit_paid: number;
  user_type: string | null;
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
  // Load ACTIVE subscriptions so derivePaymentType can distinguish
  // real members (FREE + active sub at match time) from FREE_NON_MEMBER
  // (first-match-free, guest passes, manager-added fills). Without
  // this map, the legacy "FREE → MEMBER" fallback over-counts members.
  const subscriptionsByEmail = await loadActiveSubscriptionsByEmail(supabase);
  const regs: RegRow[] = await fetchLegacyMatchRegistrations(
    supabase,
    {
      fromDate: ymd(weekStart),
      toDate: ymd(weekEnd),
    },
    subscriptionsByEmail,
  );

  // Split into canceled (match_canceled=true) and active (the rest).
  // Canceled rows skip the active filter chain entirely — they go
  // straight to the canceled bucketing pass.
  //
  // GUEST exclusion in both paths: user_type='GUEST' rows are phantom
  // seats from a host buying multiple spots (same person, second seat).
  // They carry amount=0 and represent no distinct customer. Excluded
  // from spotsSold, paidSpots, memberSpots, freeNonMemberSpots, and
  // from the canceled-match dedup so nothing is counted off them.
  const canceledRegs = regs.filter(
    (r) => !!r.field && r.match_canceled && r.user_type !== "GUEST",
  );
  const activeEligible = regs.filter(
    (r) =>
      !!r.field &&
      !r.match_canceled &&
      r.user_type !== "GUEST" &&
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

  // Soccer Central rate depends on the slot's configured capacity
  // (max_player_count). Pull a small parallel query — same week
  // window, ~50-100 rows — so the bucketing pass can route SC
  // matches to the $60 vs $120 leg and exclude null/0-capacity
  // special-event rows. Keyed by `${field_id}|${slice16(start_date)}`
  // because LegacyMatchRegRow's match_start is the slice-16 wall-
  // clock string; mdapi_matches.start_date encodes the same wall-
  // clock as a UTC-suffixed timestamp, so slicing the first 16 chars
  // yields the same `YYYY-MM-DDTHH:MM` on both sides.
  const matchMetaRows = await selectAll<{
    field_id: number | null;
    start_date: string | null;
    max_player_count: number | null;
  }>(() =>
    supabase
      .from("mdapi_matches")
      .select("field_id, start_date, max_player_count")
      .gte("start_date", `${ymd(weekStart)}T00:00:00Z`)
      .lte("start_date", `${ymd(weekEnd)}T23:59:59Z`),
  );
  const matchMaxPlayer = new Map<string, number | null>();
  for (const m of matchMetaRows) {
    if (m.field_id == null || !m.start_date) continue;
    const k = `${m.field_id}|${m.start_date.slice(0, 16)}`;
    matchMaxPlayer.set(
      k,
      m.max_player_count == null ? null : Number(m.max_player_count),
    );
  }

  // Look up + re-resolve a registration's venue against the Soccer
  // Central split. Returns null IFF the row should be excluded
  // entirely (SC special event — World Cup bracket match with
  // null/0 capacity). Returns the same venue+cost otherwise, or
  // re-routes to the Soccer Central Tournament leg ($120) when the
  // capacity is > 22.
  type ScResolved = { venueId: number; cost: number | null; isTournament: boolean };
  function resolveSoccerCentral(
    baseVenueId: number,
    baseCost: number | null,
    fieldId: number | null,
    matchStartIso: string,
  ): ScResolved | null {
    const v = venueById.get(baseVenueId);
    if (!v) return { venueId: baseVenueId, cost: baseCost, isTournament: false };
    if (
      v.raw_venue_name !== "Soccer Central" &&
      v.raw_venue_name !== "Soccer Central Tournament"
    ) {
      return { venueId: baseVenueId, cost: baseCost, isTournament: false };
    }
    const lookupKey = `${fieldId}|${matchStartIso.slice(0, 16)}`;
    const maxPlayerCount = matchMaxPlayer.get(lookupKey) ?? null;
    if (maxPlayerCount == null || maxPlayerCount <= 0) return null;
    const isTournament = maxPlayerCount > 22;
    const targetName = isTournament
      ? "Soccer Central Tournament"
      : "Soccer Central";
    if (v.raw_venue_name === targetName) {
      return { venueId: v.id, cost: v.cost_per_match, isTournament };
    }
    const target = venues.find(
      (x) => x.city === v.city && x.raw_venue_name === targetName,
    );
    if (!target) {
      // No tournament row provisioned yet — keep the base venue/cost
      // so we don't silently drop matches. The split-rate migration
      // adds the row; this fallback is just defensive.
      return { venueId: baseVenueId, cost: baseCost, isTournament };
    }
    return {
      venueId: target.id,
      cost: target.cost_per_match,
      isTournament,
    };
  }

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
    paidSpots: number;
    memberSpots: number;
    freeNonMemberSpots: number;
    grossRevenue: number;
    credit: number;
    // Day-aware cost captured at row time so the bucket records the
    // resolved rate (incl. the sibling-cost-null fallback to base
    // venue's rate). See resolveVenueForMatch.
    cost: number | null;
    isTournament: boolean;
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
    let venueId = resolved?.venueId ?? null;
    let cost: number | null = resolved?.cost ?? null;
    let isTournament = false;
    // Soccer Central second pass: route to the $120 Tournament leg
    // when max_player_count > 22, drop entirely on null/0 capacity
    // (World Cup bracket special events). No-op for non-SC venues.
    if (venueId !== null) {
      const sc = resolveSoccerCentral(
        venueId,
        cost,
        r.field_id ?? null,
        r.match_start,
      );
      if (sc === null) continue; // SC special event — skip
      venueId = sc.venueId;
      cost = sc.cost;
      isTournament = sc.isTournament;
    }
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
        paidSpots: 0,
        memberSpots: 0,
        freeNonMemberSpots: 0,
        grossRevenue: 0,
        credit: 0,
        cost,
        isTournament,
      };
      buckets.set(key, b);
    }
    const pt = (r.payment_type ?? "").toUpperCase();
    // Member status is checked INDEPENDENTLY of payment_type so a
    // paid_status='PAID' row whose email has an active subscription
    // at match time counts as both a paid spot AND a member spot
    // (a member who paid full DPP for that match). derivePaymentType
    // only flips to 'MEMBER' when paid_status='FREE' + active sub,
    // so the cross-check here picks up PAID + active sub cases.
    const isMember = hasActiveSubAtMatchTime(
      r.email,
      r.match_start,
      subscriptionsByEmail,
    );
    b.spotsSold += 1;
    if (isMember) b.memberSpots += 1;
    if (pt === "FREE_NON_MEMBER") {
      b.freeNonMemberSpots += 1;
    } else if (pt === "DAILY PAID") {
      const amount = Number(r.match_price_paid ?? 0) || 0;
      // DPP Rev and Credit always accumulate for eligible DAILY PAID
      // rows. paidSpots only counts rows that actually moved money
      // (amount > 0), so $0 placeholder rows don't inflate the
      // paid-spot count.
      b.grossRevenue += amount;
      b.credit += Number(r.credit_paid ?? 0) || 0;
      if (amount > 0) b.paidSpots += 1;
    }
    // pt === "MEMBER" (FREE + active sub) is already counted in
    // memberSpots above; no other increment needed. PROMOCODE rows
    // never reach here (excluded by ALLOWED_PAYMENT_TYPES).
  }

  // April benchmark rate per city: cityAprMembershipRev / cityAprMemberSpots.
  // Computed once per city that appears in this week's buckets so every
  // row in the same city values its MEMBER spots at the identical
  // structural rate the April benchmark sub-line on the city header
  // displays. Cities with no recorded April member spots get rate=0,
  // so allocatedMemberRev = $0 for all their rows (reconciles with the
  // "no member spots recorded" fallback on the city header).
  const cityAprRate = new Map<string, number>();
  for (const b of buckets.values()) {
    if (cityAprRate.has(b.city)) continue;
    const aprMemberRev = cityMembershipRevenueFor(data, b.city, "Apr 2026");
    const aprMemberSpots =
      data.mdapiMemberSpots.byCityMonth.get(`${b.city}|Apr 2026`)?.member ?? 0;
    cityAprRate.set(b.city, aprMemberSpots > 0 ? aprMemberRev / aprMemberSpots : 0);
  }

  const active: MatchPnLRow[] = [];
  for (const b of buckets.values()) {
    const cost = b.cost;
    // Member play valued at the city's April benchmark rate. Stable
    // across the quarter regardless of which week the match falls in,
    // so the per-row figure equals memberSpots × the April benchmark
    // rate shown on the city header.
    const aprRate = cityAprRate.get(b.city) ?? 0;
    const allocatedMemberRev = b.memberSpots * aprRate;
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
      paidSpots: b.paidSpots,
      memberSpots: b.memberSpots,
      freeNonMemberSpots: b.freeNonMemberSpots,
      grossRevenue: b.grossRevenue,
      allocatedMemberRev,
      credit: b.credit,
      fieldCost: cost,
      net,
      status: statusFor(net),
      isTournament: b.isTournament,
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
    let venueId = resolved?.venueId ?? null;
    let cost: number | null = resolved?.cost ?? null;
    let isTournament = false;
    if (venueId !== null) {
      const sc = resolveSoccerCentral(
        venueId,
        cost,
        r.field_id ?? null,
        r.match_start,
      );
      if (sc === null) continue; // SC special event — skip
      venueId = sc.venueId;
      cost = sc.cost;
      isTournament = sc.isTournament;
    }
    const key = `${venueId ?? `raw:${r.field}`}|${r.match_start}`;
    if (canceledSeen.has(key)) continue;
    canceledSeen.add(key);
    const venue = venueId !== null ? (venueById.get(venueId) ?? null) : null;
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
      paidSpots: 0,
      memberSpots: 0,
      freeNonMemberSpots: 0,
      grossRevenue: 0,
      // Canceled match → no members attended → zero allocation. The
      // upload-time fin_member_spots aggregate already excludes
      // canceled matches' rows, so we stay reconciled with the
      // venue-month totals.
      allocatedMemberRev: 0,
      credit: 0,
      fieldCost: cost,
      net: cost === null ? null : -cost,
      status: "canceled",
      isTournament,
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
  let totalPaidSpots = 0;
  let totalCredit = 0;
  let totalFieldCost = 0;
  let losingMatches = 0;
  let matchesWithoutCost = 0;
  for (const r of rows) {
    totalRevenue += r.grossRevenue;
    totalMemberRev += r.allocatedMemberRev;
    totalMemberSpots += r.memberSpots;
    totalPaidSpots += r.paidSpots;
    totalCredit += r.credit;
    if (r.fieldCost !== null) totalFieldCost += r.fieldCost;
    else matchesWithoutCost++;
    if (r.status === "loss") losingMatches++;
  }
  return {
    totalMatches: rows.length,
    totalRevenue,
    totalMemberRev,
    totalMemberSpots,
    totalPaidSpots,
    totalCredit,
    totalFieldCost,
    net: totalRevenue + totalMemberRev - totalFieldCost,
    losingMatches,
    matchesWithoutCost,
  };
}
