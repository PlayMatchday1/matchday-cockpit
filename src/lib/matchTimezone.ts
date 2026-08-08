// A match's timezone, from its field's city — for the drawer's "entered as local
// wall-clock in X" line and the cross-timezone warning.
//
// The MatchDay API has no timezone on a match; it comes from the city. We reuse
// the existing city-code -> IANA map (cityTimezones) and city-name -> code
// normaliser (cityNormalization) so there is ONE source of truth for which city
// is in which zone. Zones are ranked by how far WEST they sit: for the SAME wall
// clock, a match moved to a further-west zone happens LATER in real terms, a
// further-east zone EARLIER (each rank = 1 hour; DST shifts both together).

import { normalizeCityName } from "./cityNormalization";
import { timezoneFor } from "./cityTimezones";

const ZONE: Record<string, { label: string; westRank: number }> = {
  "America/New_York": { label: "Eastern", westRank: 0 },
  "America/Chicago": { label: "Central", westRank: 1 },
  "America/Denver": { label: "Mountain", westRank: 2 },
};

export function zoneOfCity(cityName: string | null | undefined): string | null {
  return timezoneFor(normalizeCityName(cityName ?? ""));
}

// Human label for the drawer chip / tz line. Falls back to "UTC" (visible gap)
// rather than guessing, matching cityTimezones' own fallback discipline.
export function tzLabelOfCity(cityName: string | null | undefined): string {
  const z = zoneOfCity(cityName);
  return z && ZONE[z] ? ZONE[z].label : "UTC";
}

// Same wall clock, moving from -> to. LATER when the target is further west,
// EARLIER when further east; hours = the rank gap. null when either city is
// unknown or the zone does not change (no warning needed).
export function tzShift(
  fromCity: string | null | undefined,
  toCity: string | null | undefined,
): { hours: number; direction: "earlier" | "later"; fromLabel: string; toLabel: string } | null {
  const zf = zoneOfCity(fromCity);
  const zt = zoneOfCity(toCity);
  if (!zf || !zt || !ZONE[zf] || !ZONE[zt]) return null;
  const gap = ZONE[zt].westRank - ZONE[zf].westRank;
  if (gap === 0) return null;
  return {
    hours: Math.abs(gap),
    direction: gap > 0 ? "later" : "earlier",
    fromLabel: ZONE[zf].label,
    toLabel: ZONE[zt].label,
  };
}
