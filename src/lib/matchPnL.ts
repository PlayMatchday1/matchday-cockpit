// Per-match unit P&L for the Match P&L subtab on /admin/finance/field-costs.
//
// Pipeline:
//   1. Fetch match_registrations for one Mon-Sun week (current upload).
//   2. Filter out canceled matches and player-canceled rows.
//   3. ALSO filter on payment_type — explicit allow-list of player
//      booking types ("DAILY PAID", "MEMBER"). Defensive: rentals are
//      not in match_registrations by data-model design, but if any
//      do leak in (admin imports, bugs), they'd typically have a
//      different payment_type and would be excluded here. Mirrors
//      the spirit of the conservative filtering elsewhere; explicit
//      so a future reader sees exactly what's counted.
//   4. Resolve field → venue via the canonical longest-prefix match
//      using the same buildFieldToVenueMap pattern as projections.
//   5. Aggregate by (venueId, match_start) → spotsSold, grossRevenue.
//      spotsSold counts ALL non-canceled fills (DPP + Member);
//      grossRevenue sums match_price_paid (members are $0).
//   6. Look up venue.cost_per_match. Compute net = gross − cost.
//   7. Bin by status: < -10 loss, [-10, 10] breakeven, > 10 profit.
//      Missing cost_per_match → "missing-cost" status, separate row
//      group at bottom of the table.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FinVenue } from "./useFinanceData";

// Allow-list of player-booking payment types. Anything else (NULL,
// rental codes, comp markers) gets filtered out as not a real
// fill-the-spots booking event.
const ALLOWED_PAYMENT_TYPES = new Set(["DAILY PAID", "MEMBER"]);

export type MatchPnLStatus = "loss" | "breakeven" | "profit" | "missing-cost";

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
  spotsSold: number;
  grossRevenue: number;
  fieldCost: number | null;
  net: number | null;
  status: MatchPnLStatus;
};

export type MatchPnLSummary = {
  totalMatches: number;
  totalRevenue: number;
  totalFieldCost: number; // sum across rows where cost is known
  net: number; // totalRevenue − totalFieldCost
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

export async function fetchWeekMatchPnL(
  supabase: SupabaseClient,
  weekStart: Date,
  weekEnd: Date, // Sunday end-of-day
  venues: FinVenue[],
): Promise<MatchPnLRow[]> {
  const uploadId = await fetchCurrentUploadId(supabase);
  if (uploadId === null) return [];

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

  // Defensive filters per the rationale at top of file.
  const eligible = regs.filter(
    (r) =>
      !!r.field &&
      !r.match_canceled &&
      !(
        r.player_canceled_at && r.player_canceled_at.trim() !== ""
      ) &&
      ALLOWED_PAYMENT_TYPES.has((r.payment_type ?? "").toUpperCase()),
  );

  const fields = new Set<string>();
  for (const r of eligible) if (r.field) fields.add(r.field);
  const fieldToVenue = buildFieldToVenueMap(fields, venues);
  const venueById = new Map(venues.map((v) => [v.id, v]));

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
    grossRevenue: number;
  };
  const buckets = new Map<string, Bucket>();

  for (const r of eligible) {
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
        grossRevenue: 0,
      };
      buckets.set(key, b);
    }
    b.spotsSold += 1;
    b.grossRevenue += Number(r.match_price_paid ?? 0) || 0;
  }

  const rows: MatchPnLRow[] = [];
  for (const b of buckets.values()) {
    const venue = b.venueId !== null ? (venueById.get(b.venueId) ?? null) : null;
    const cost = venue?.cost_per_match ?? null;
    const net = cost === null ? null : b.grossRevenue - cost;
    rows.push({
      matchStartIso: b.matchStartIso,
      matchStart: b.matchStart,
      venueId: b.venueId,
      venueRawName: b.venueRawName,
      venueDisplayName: b.venueDisplayName,
      city: b.city,
      dayLabel: dayLabelFromDate(b.matchStart),
      timeLabel: timeLabelFromDate(b.matchStart),
      spotsSold: b.spotsSold,
      grossRevenue: b.grossRevenue,
      fieldCost: cost,
      net,
      status: statusFor(net),
    });
  }
  return rows;
}

export function summarize(rows: MatchPnLRow[]): MatchPnLSummary {
  let totalRevenue = 0;
  let totalFieldCost = 0;
  let losingMatches = 0;
  let matchesWithoutCost = 0;
  for (const r of rows) {
    totalRevenue += r.grossRevenue;
    if (r.fieldCost !== null) totalFieldCost += r.fieldCost;
    else matchesWithoutCost++;
    if (r.status === "loss") losingMatches++;
  }
  return {
    totalMatches: rows.length,
    totalRevenue,
    totalFieldCost,
    net: totalRevenue - totalFieldCost,
    losingMatches,
    matchesWithoutCost,
  };
}
