// IMPORTANT: when MatchDay launches a new city (e.g., Phoenix), add
// it here. useReviewData and the upload paths skip rows that don't
// normalize, so reviews/matches in unmapped cities silently
// disappear from dashboards.
export const CSV_TO_COCKPIT_CITY: Record<string, string> = {
  "Dallas / Fort Worth": "Dallas",
  "Oklahoma City": "OKC",
  Austin: "Austin",
  Houston: "Houston",
  "San Antonio": "San Antonio",
  "St. Louis": "St. Louis",
  Atlanta: "Atlanta",
  "El Paso": "El Paso",
};

export function normalizeCity(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return CSV_TO_COCKPIT_CITY[trimmed] ?? null;
}

// Map MatchDay platform abbrs (city_identifier on mdapi_*) to cockpit
// city names. Used by useFinanceData and membershipSnapshots when
// reading mdapi_subscriptions, plus by stripeSync's email→city map.
//
// IMPORTANT: keep in sync with CSV_TO_COCKPIT_CITY above. New cities
// (e.g., Phoenix) need to be added here AND to CSV_TO_COCKPIT_CITY,
// or rows in unmapped cities silently disappear from dashboards.
export const CITY_ABBR_TO_COCKPIT: Record<string, string> = {
  ATX: "Austin",
  HOU: "Houston",
  SATX: "San Antonio",
  DFW: "Dallas", // API uses DFW, not DAL
  ATL: "Atlanta",
  OKC: "OKC",
  STL: "St. Louis",
  ELP: "El Paso", // forward-compat; 0 rows today
};

export function cityFromAbbr(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return CITY_ABBR_TO_COCKPIT[trimmed] ?? null;
}

// Inverse of cityFromAbbr. Returns the upstream abbreviation
// (mdapi_matches.city_identifier) for a cockpit city name, or null
// if the city isn't in the map. Used by useMatchWindowData to
// translate the City prop into the server-side filter value.
const COCKPIT_TO_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(CITY_ABBR_TO_COCKPIT).map(([abbr, city]) => [city, abbr]),
);

export function cityToAbbr(raw: string | undefined | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  return COCKPIT_TO_ABBR[trimmed] ?? null;
}
