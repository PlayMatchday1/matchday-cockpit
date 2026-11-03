// FIELD OPS' CITY GROUPS — which cities appear, and in what order. Pure.
//
// NO TYPED LIST DECIDES MEMBERSHIP ANY MORE. Field Ops drew CITIES.filter(has a venue) — CITIES
// (lib/types) has eight cities and no Philadelphia, so venue #92 Friends Select School was active
// and never drawn. Now:
//   groups   every city an active venue carries. A venue can no longer be dropped for its city.
//            This needs no network read, so it cannot fail separately from the venues themselves.
//   order    the order Field Ops has always used for the cities it knew (Austin, Dallas, Houston,
//            San Antonio, Atlanta, St. Louis, OKC, El Paso) so the existing page does not reshuffle;
//            every other city after them, alphabetically. Order only — a city absent from that
//            list still appears.
//   the Add venue form  MatchDay's GET /cities (via /api/city-directory) less Warsaw, so a city
//            with no venue yet can be picked: fin_venues is MatchDay's finance record
//            and Warsaw is a licensee, kept off it (the partner-market rule, migration 0142).
// The directory already drops El Paso and New York (cityDirectory.EXCLUDED_CITY_ABBRS).
import { CITIES } from "./types";

const KNOWN_ORDER: readonly string[] = CITIES;
const rank = (c: string) => { const i = KNOWN_ORDER.indexOf(c); return i < 0 ? KNOWN_ORDER.length : i; };

export function orderedCityGroups(venueCities: readonly (string | null | undefined)[]): string[] {
  const have = new Set(venueCities.map((c) => c ?? "").filter((c) => c.trim() !== ""));
  return [...have].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function venueFormCities(directory: readonly { abbr: string | null; display: string }[]): string[] {
  return directory.filter((c) => c.abbr !== "WAW").map((c) => c.display)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
