// ONE VIEW'S SHARE OF THE LOCATIONS MAP (2026-10-27). Pure. /api/growth/locations/map builds the whole
// map exactly as before (buildLocationsMap) and sends only what the view on screen reads:
//
//   All cities (no city)  cities, national bubbles (both colourings), New markets, played fields, every
//                         field, the missing-field warning. No city bubbles.
//   one city              cities, that city's bubbles (both colourings), played fields, every field
//                         (a bubble's "nearby" can name a field across a city line). No national bubbles.
//
// Every number in a slice is the full build's own, so a slice cannot disagree with the map it came from.

import type { LocationsMap } from "./locationsMap";

export function sliceLocationsMap(map: LocationsMap, cityId: number | null): LocationsMap {
  if (cityId == null) return { ...map, zips: [], zipsActivity: [] };
  return { ...map, zips: map.zips.filter((z) => z.cityId === cityId), zipsActivity: map.zipsActivity.filter((z) => z.cityId === cityId),
    national: [], nationalActivity: [], outside: [] };
}

/** ?city=<positive integer>, or null for All cities. */
export function cityParam(url: string): number | null {
  const n = Number(new URL(url).searchParams.get("city"));
  return Number.isInteger(n) && n > 0 ? n : null;
}
