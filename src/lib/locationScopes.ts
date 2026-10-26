// A LOCATIONS SCOPE — one market's slice of the Locations page, for an account confined to it.
// Pure; imported by the sync (which city rows count), the scoped routes and the page.
//
// ONE SCOPE TODAY: Poland, for the WAW-confined accounts (Match Ops → Locations,
// /match-ops/market-locations). The US page (/growth/locations) is unscoped and unchanged in shape.
//
// WHO IS IN IT: a player whose MatchDay area label ends ", Poland" — the country MatchDay itself
// geocoded the location to. Measured 2026-10-23 on player_area_seen: 97 placed players carry a
// "…, Poland" label and exactly the same 97 sit inside a Poland bounding box (49–55°N, 14–24.2°E),
// so the label and the coordinates agree. A player with coordinates and NO label would be missed;
// there were none. The filter is applied in SQL (`ilike`), so no other player row is read.
//
// WHY THE RADIUS IS OURS, NOT MATCHDAY'S. /admin/cities gives Warsaw `radiusMiles: 1000` (and
// `country: "Europe"`), seen on the embedded preferableCity object in mdapi_users.raw. A 1,000-mile
// coverage radius would make London, Paris and Athens players "in market" for Warsaw. Coverage here
// uses 100 miles, the radius every US city carries, so Warsaw is a market the way Austin is.

export const KM_PER_MI = 1.609344;
export type DistanceUnit = "mi" | "km";
/** Multiply a distance in miles by this to get it in `unit`. */
export const perMile = (unit: DistanceUnit | undefined) => (unit === "km" ? KM_PER_MI : 1);

export type LocationScope = {
  key: string;
  /** What the page calls the market: "Poland". */
  name: string;
  /** The MatchDay city in it, by abbr (= app_users.city_identifier, = mdapi_matches.city_identifier). */
  cityAbbr: string;
  cityName: string;
  /** The country suffix MatchDay writes on area labels: "Warsaw, Poland". */
  country: string;
  /** EVERY MatchDay city in this market, by abbr (= city_identifier) and name. The Fields page
   *  scopes a confined account to these (src/lib/fieldScope.ts). One today; a second Polish city
   *  is a line here, not a code change. */
  cities: readonly { abbr: string; name: string }[];
  unit: DistanceUnit;
  coverageRadiusMiles: number;
  /** Where the map opens before it has fitted to the players. */
  center: [number, number];
};

export const POLAND: LocationScope = {
  key: "PL", name: "Poland", cityAbbr: "WAW", cityName: "Warsaw", country: "Poland",
  cities: [{ abbr: "WAW", name: "Warsaw" }],
  unit: "km", coverageRadiusMiles: 100, center: [52.07, 19.48],
};

const BY_CITY: Readonly<Record<string, LocationScope>> = { WAW: POLAND };

/** The scope a confined city carries, or null. Exact match on the resolved identifier. */
export function locationScopeForCity(city: string | null | undefined): LocationScope | null {
  return city ? BY_CITY[city] ?? null : null;
}

/** Cities the player-areas sync keeps besides the US ones, with the radius coverage uses. */
export function scopedCityRadius(abbr: unknown): number | null {
  return typeof abbr === "string" && BY_CITY[abbr] ? BY_CITY[abbr].coverageRadiusMiles : null;
}

/** The PostgREST `ilike` pattern for this scope's players' area_label. */
export const areaLabelPattern = (s: LocationScope) => `%, ${s.country}`;

/** "4.2 km" / "12 mi" — one decimal under 10. */
export function fmtDistance(n: number | null | undefined, unit: DistanceUnit, empty = "—"): string {
  return n == null ? empty : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${unit}`;
}
