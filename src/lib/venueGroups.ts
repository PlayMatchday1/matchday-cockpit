// Split-rate venues live as multiple rows in fin_venues — e.g. ATH Katy
// (weekday $140) and ATH Katy Sunday ($160). Display, costing, and ranking
// should treat them as a SINGLE combined row everywhere on the dashboard.
//
// Two ways the legs can show up in `data.venues`:
//   Case A — venue aliases collapse the leg names to one canonical name.
//            data.venues has multiple rows with the SAME (city, venue_name).
//            Auto-grouping by (city, venue_name) catches them.
//   Case B — no alias; legs keep DISTINCT canonical names like "ATH Katy"
//            and "ATH Katy Sunday". COMBINE_BY_NAME below merges them
//            after the auto-grouping pass.
//
// To register a new split-rate venue, add an entry to COMBINE_BY_NAME and
// (optionally) COMBINED_LEG_LABELS for the formula display.

import type { FinVenue } from "./useFinanceData";

const COMBINE_BY_NAME: Array<{ primary: string; secondary: string }> = [
  { primary: "ATH Katy", secondary: "ATH Katy Sunday" },
];

const COMBINED_LEG_LABELS: Record<string, string[]> = {
  // Display name → leg labels in per_match_rate ASC order. legs[0] = lowest
  // rate (e.g. weekday $140), legs[1] = next (e.g. Sunday $160).
  "ATH Katy": ["weekday", "Sunday"],
};

export type VenueGroup = {
  key: string; // unique
  displayName: string;
  city: string;
  legs: FinVenue[]; // sorted by per_match_rate ASC; legs[0] is the primary
  isCombined: boolean;
};

export function groupVenues(venues: FinVenue[]): VenueGroup[] {
  // Step 1: bucket by (city, venue_name) to collapse Case A duplicates.
  const buckets = new Map<string, FinVenue[]>();
  for (const v of venues) {
    const key = `${v.city}|${v.venue_name}`;
    const arr = buckets.get(key);
    if (arr) arr.push(v);
    else buckets.set(key, [v]);
  }

  // Step 2: apply COMBINE_BY_NAME — merge distinct-name pairs (Case B).
  const cities = new Set<string>();
  for (const v of venues) cities.add(v.city);
  for (const cfg of COMBINE_BY_NAME) {
    for (const city of cities) {
      const primaryKey = `${city}|${cfg.primary}`;
      const secondaryKey = `${city}|${cfg.secondary}`;
      const primaryBucket = buckets.get(primaryKey);
      const secondaryBucket = buckets.get(secondaryKey);
      if (primaryBucket && secondaryBucket) {
        primaryBucket.push(...secondaryBucket);
        buckets.delete(secondaryKey);
      }
    }
  }

  // Step 3: build groups, sorting legs within each by per_match_rate ASC
  // (lowest = primary). For non-per_match billing, sort by id for stability.
  const out: VenueGroup[] = [];
  for (const [key, legs] of buckets.entries()) {
    const sorted = [...legs].sort((a, b) => {
      const ra = a.per_match_rate ?? 0;
      const rb = b.per_match_rate ?? 0;
      if (ra !== rb) return ra - rb;
      return a.id - b.id;
    });
    out.push({
      key,
      displayName: sorted[0].venue_name,
      city: sorted[0].city,
      legs: sorted,
      isCombined: sorted.length > 1,
    });
  }
  return out;
}

export function getLegLabel(group: VenueGroup, legIndex: number): string {
  const labels = COMBINED_LEG_LABELS[group.displayName];
  if (labels && legIndex < labels.length) return labels[legIndex];
  return `leg ${legIndex + 1}`;
}

// Route a schedule row's resolved venue_id to the correct split-rate leg by
// day-of-week. ATH Katy is the live case: the weekday leg ($140) has
// mdapi_field_id 892; the Sunday leg ($160) has no field_id, so every
// schedule_master row resolves to the weekday leg via the field_id path
// and Sunday matches would silently underbill by $20 each. Sunday
// (UTC-day-of-week = 0) routes to `secondary`; every other day stays on
// `primary`. Symmetric: works whether the initial venue_id matched the
// primary OR the secondary leg, so future split-rate configs can wire
// fin_venue_fields up to either side without changing this code.
//
// matchDate must be YYYY-MM-DD. UTC math is correct here because the date
// column is a calendar date with no timezone — same approach as
// scripts/backfill-schedule-master-from-mdapi.mjs.
export function resolveSplitRateVenueId(
  initialVenueId: number,
  matchDate: string,
  venues: FinVenue[],
): number {
  const v = venues.find((x) => x.id === initialVenueId);
  if (!v) return initialVenueId;
  const cfg = COMBINE_BY_NAME.find(
    (c) => c.primary === v.venue_name || c.secondary === v.venue_name,
  );
  if (!cfg) return initialVenueId;
  const d = new Date(`${matchDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return initialVenueId;
  const targetName = d.getUTCDay() === 0 ? cfg.secondary : cfg.primary;
  if (targetName === v.venue_name) return initialVenueId;
  const target = venues.find(
    (x) => x.city === v.city && x.venue_name === targetName,
  );
  return target?.id ?? initialVenueId;
}

// Find the group that owns a venue, by either canonical display name or any
// leg's raw venue_name. Useful when a caller has a venue string and wants to
// roll up to the group's view.
export function findGroupForVenue(
  groups: VenueGroup[],
  city: string,
  venueName: string,
): VenueGroup | null {
  for (const g of groups) {
    if (g.city !== city) continue;
    if (g.displayName === venueName) return g;
    if (g.isCombined && g.legs.some((l) => l.venue_name === venueName)) {
      return g;
    }
  }
  return null;
}
