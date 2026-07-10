// Normalize city names returned by MatchDay's API to the short codes
// the cockpit uses internally. The API returns full English names
// ("Austin", "Oklahoma City", "St. Louis"); the cockpit's CITIES
// const, mdapi_subscriptions.city_identifier, and mdapi_matches.city_identifier
// all use short codes (ATX, OKC, STL).
//
// Used by the mdapi_users sync at write time so per-city aggregations
// can join on a single canonical column. The raw API value is also
// preserved on mdapi_users.preferable_city_name for audit.
//
// New cities: anything outside the map below returns null and logs a
// console.warn so a new city the API starts returning gets caught
// before silently going to null.

// Accepts either the human-readable name from MatchDay's API
// ("Austin", "Dallas / Fort Worth") or the canonical short code
// ("ATX", "DFW"). Self-aliases for the codes were added so the
// discrepancy route can pass either form through this helper.
const CITY_MAP: Record<string, string> = {
  austin: "ATX",
  atx: "ATX",
  atlanta: "ATL",
  atl: "ATL",
  dallas: "DFW",
  "dallas / fort worth": "DFW",
  "dallas/fort worth": "DFW",
  dfw: "DFW",
  houston: "HOU",
  hou: "HOU",
  "oklahoma city": "OKC",
  okc: "OKC",
  "san antonio": "SATX",
  satx: "SATX",
  "st. louis": "STL",
  "st louis": "STL",
  "saint louis": "STL",
  stl: "STL",
  "el paso": "ELP",
  elp: "ELP",
};

// Cache so we only warn once per unmapped city per process.
const warnedUnmapped = new Set<string>();

/**
 * Normalize a city name from MatchDay's API into the cockpit's short
 * code (e.g. "Austin" → "ATX"). Returns null for null/empty input or
 * for any name not in CITY_MAP. Unmapped names log a console.warn the
 * first time we see them in this process.
 */
export function normalizeCityName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  const code = CITY_MAP[key];
  if (code) return code;
  if (!warnedUnmapped.has(key)) {
    warnedUnmapped.add(key);
    console.warn(
      `[cityNormalization] Unknown city name "${trimmed}" — returning null. ` +
        `If this is a new MatchDay city, add it to CITY_MAP in src/lib/cityNormalization.ts.`,
    );
  }
  return null;
}

/**
 * Canonical short codes the cockpit recognizes. Useful for the Users
 * sub-tab UI when iterating known buckets.
 */
export const KNOWN_CITY_CODES = [
  "ATX",
  "ATL",
  "DFW",
  "HOU",
  "OKC",
  "SATX",
  "STL",
  "ELP",
] as const;

export type KnownCityCode = (typeof KNOWN_CITY_CODES)[number];

// Code-based mirror of types.HIDDEN_CITIES for the chat city-chip filter
// bars (which key off city CODES, not display names). ELP stays in
// KNOWN_CITY_CODES above so historical El Paso rows still normalize,
// color, and resolve — only the forward-facing chip is suppressed. Keep
// this in sync with types.HIDDEN_CITIES.
export const HIDDEN_CITY_CODES = new Set<string>(["ELP"]);
