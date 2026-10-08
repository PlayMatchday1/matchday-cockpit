// THE LOCATIONS MAP, aggregated — pure. /api/growth/locations/map reads Supabase and hands the rows
// here; the browser gets cities, fields and per-zip bubbles, never a player row.
//
// NO MATCHDAY CALLS, NO NEW SYNC. Every input is already in Supabase:
//   players  player_area_seen (written by the 6-hourly player-areas sync)
//   cities   player_area_sync_runs.cities — the US city lat/lng/radiusMiles that sync read
//   fields   mdapi_matches.raw.field — the field object every synced match carries (lat, lng,
//            cityId, deletedAt, title). A field that never hosted a match is absent, which the
//            ACTIVE definition below makes moot.
//
// ACTIVE FIELD = not deleted upstream (field.deletedAt null) AND a non-cancelled, non-deleted match
// in the last 60 days or upcoming. Not a stored flag — a definition, stated here and on the page.
//
// ZIP-LEVEL COVERAGE. A zip's bubble sits at the average lat/lng of its players; the zip is "in
// reach" when that point is within the reach of any active field, and all its players count as
// covered. The bubble colour, the coverage card and the gaps list therefore always agree.
//
// PRIVACY. Bubble positions are ROUNDED to 2 decimals (~1 km) before they leave the server: a GPS
// share is a home, and a one-player zip would otherwise place that player exactly. Distances are
// computed from the unrounded averages.

import { areaGroupKey, areaGroupName, milesBetween, placeName, type AreaCity } from "./playerAreaModel";

export const REACHES = [3, 5, 10, 15] as const;
export type Reach = (typeof REACHES)[number];
type ByReach = Record<Reach, number>;
const zeroByReach = () => Object.fromEntries(REACHES.map((r) => [r, 0])) as ByReach;

export type MapPlayerRow = {
  zip: string | null;
  area_label: string | null;
  /** Migration 0216: worked out by the sync from lat/lng. */
  state: string | null;
  lat: number | null;
  lng: number | null;
  verdict: "in_market" | "waitlist" | "unidentified";
  verdict_city_id: number | null;
};

export type FieldSnapshot = {
  fieldId: number;
  title: string | null;
  cityId: number | null;
  lat: unknown;
  lng: unknown;
  deletedAt: unknown;
  updatedAt: string;
};

export type MapField = { id: number; title: string; cityId: number; lat: number; lng: number; reach: ByReach };
/** A city-view bubble: one zip, or — for players with no zip — one ~1-mile grid cell
 *  (playerAreaModel.areaGroupKey). `area` is what to call it: the zip, the cell's shared area
 *  label, or "GPS, no zip". `key` is unique within a city. */
export type MapZip = {
  key: string; zip: string | null; area: string; cityId: number; lat: number; lng: number; players: number;
  nearestFieldId: number | null; nearestFieldMi: number | null;
  /** Exact-distance verdict per reach, so the browser never compares a rounded number. */
  inReach: Record<Reach, boolean>;
  /** Every active field within the LARGEST reach, nearest first: `mi` is for display (rounded),
   *  `minReach` the smallest reach that contains it on the EXACT distance. Selecting a bubble lists
   *  the fields with minReach <= the current reach. */
  nearby: { fieldId: number; mi: number; minReach: Reach }[];
};
export type MapCity = AreaCity & {
  players: number; fields: number; coverage: ByReach;
  unplaced: number; // in this city's market but no lat/lng to place (unidentified zips have no city)
};
/** All-cities view: one bubble per (verdict, zip) across the country — in-market AND outside
 *  coverage. Same rounding and averaging as MapZip. nearestCity is the nearest US city CENTRE. */
export type NationalZip = {
  /** In market: the player's own city (verdict_city_id); null outside coverage. Bubbles never merge
   *  across cities, so an in-market zip only ever rolls up into its own city. */
  cityId: number | null;
  key: string; zip: string | null; area: string; label: string | null; verdict: "in_market" | "waitlist";
  lat: number; lng: number; players: number; nearestCityId: number | null; nearestCityMi: number | null;
};
/** Outside coverage grouped by place: area label, falling back to zip, falling back to the ~1-mile
 *  grid cell (shown as "GPS, no zip"). lat/lng = the players' average (rounded), so a row can zoom
 *  the map to its bubble. */
export type OutsidePlace = {
  place: string; players: number; nearestCityId: number | null; nearestCityMi: number | null;
  lat: number; lng: number; zipKeys: string[];
};
export type LocationsMap = {
  cities: MapCity[];
  fields: MapField[];
  zips: MapZip[];
  national: NationalZip[];
  outside: OutsidePlace[];
  badFields: { id: number; title: string; cityId: number | null; lat: unknown; lng: unknown }[];
  waitlistPlayers: number;
  unidentifiedPlayers: number;
  activeWindowDays: number;
};

export const ACTIVE_WINDOW_DAYS = 60;

const validCoord = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** The ACTIVE fields with a believable location, and the ones without (shown as "missing from the
 *  map"). Shared by the map and the Overview's player detail, so both mean the same field set. */
export function activeFields(snaps: FieldSnapshot[], cities: AreaCity[]): { fields: Omit<MapField, "reach">[]; badFields: LocationsMap["badFields"] } {
  const cityIds = new Set(cities.map((c) => c.id));
  // --- fields: newest snapshot per field, active (not deleted upstream), in a US city ---
  const latest = new Map<number, FieldSnapshot>();
  for (const s of snaps) {
    const prev = latest.get(s.fieldId);
    if (!prev || s.updatedAt >= prev.updatedAt) latest.set(s.fieldId, s);
  }
  const fieldsRaw: Omit<MapField, "reach">[] = [];
  const badFields: LocationsMap["badFields"] = [];
  for (const s of latest.values()) {
    if (s.deletedAt) continue;
    if (s.cityId == null || !cityIds.has(s.cityId)) continue; // Warsaw / unknown city
    /* A LOCATION THAT CANNOT BE RIGHT is a missing one. Invalid numbers (664 Lou Fusz: lat/lng
     * swapped), and a field farther from its own city's centre than that city's radius — 1849
     * Wheatley Heights (San Antonio) is stored at lng +98.42, a dropped minus sign that put it in
     * China and zoomed the San Antonio map out to the whole world. Every other active field is
     * within 28 miles of its centre (2026-10-08). Both go to the "missing from the map" warning. */
    const city = cities.find((c) => c.id === s.cityId)!;
    if (!validCoord(s.lat, s.lng) || milesBetween(s.lat, s.lng as number, city.lat, city.lng) > city.radiusMiles) {
      badFields.push({ id: s.fieldId, title: s.title ?? `Field ${s.fieldId}`, cityId: s.cityId, lat: s.lat, lng: s.lng });
      continue;
    }
    fieldsRaw.push({ id: s.fieldId, title: s.title ?? `Field ${s.fieldId}`, cityId: s.cityId, lat: s.lat, lng: s.lng as number });
  }

  return { fields: fieldsRaw, badFields };
}

export function buildLocationsMap(input: {
  players: MapPlayerRow[];
  cities: AreaCity[];
  /** One snapshot per match row in the active window; the newest updatedAt per field wins. */
  fieldSnapshots: FieldSnapshot[];
}): LocationsMap {
  const cityIds = new Set(input.cities.map((c) => c.id));
  // Labels become "City, ST" ONCE, here, so every bubble, place and detail card carries the state.
  input = { ...input, players: input.players.map((p) => ({ ...p, area_label: placeName(p.area_label, p.state) })) };

  const { fields: fieldsRaw, badFields } = activeFields(input.fieldSnapshots, input.cities);

  // --- national bubbles + outside places: every placed player, in market or not ---
  const nearestCity = (lat: number, lng: number) => {
    let best: { id: number; mi: number } | null = null;
    for (const c of input.cities) {
      const d = milesBetween(lat, lng, c.lat, c.lng);
      if (!best || d < best.mi) best = { id: c.id, mi: d };
    }
    return best;
  };
  type Acc = { zip: string | null; cityId: number | null; sLat: number; sLng: number; n: number; labels: (string | null)[]; zipKeys: Set<string> };
  const add = (m: Map<string, Acc>, key: string, p: MapPlayerRow, zipKey: string) => {
    const g = m.get(key) ?? { zip: p.zip, cityId: p.verdict === "in_market" ? p.verdict_city_id : null, sLat: 0, sLng: 0, n: 0, labels: [], zipKeys: new Set() };
    g.sLat += p.lat as number; g.sLng += p.lng as number; g.n++;
    g.labels.push(p.area_label);
    g.zipKeys.add(zipKey);
    m.set(key, g);
  };
  const topLabel = (g: Acc) => {
    const c = new Map<string, number>();
    for (const l of g.labels) if (l) c.set(l, (c.get(l) ?? 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };
  const nat = new Map<string, Acc>();
  const out = new Map<string, Acc>();
  for (const p of input.players) {
    if (p.verdict === "unidentified" || !validCoord(p.lat, p.lng)) continue;
    const area = areaGroupKey(p.zip, p.lat, p.lng)!; // valid coordinates, so never null
    const key = `${p.verdict}|${p.verdict === "in_market" ? p.verdict_city_id : ""}|${area}`;
    add(nat, key, p, key);
    // A place is its label, else its zip, else its grid cell — so two unlabelled no-zip players
    // miles apart are two places, not one.
    if (p.verdict === "waitlist") add(out, p.area_label ? `label:${p.area_label}` : area, p, key);
  }
  const national: NationalZip[] = [...nat].map(([key, g]) => {
    const verdict = key.slice(0, key.indexOf("|")) as "in_market" | "waitlist";
    const lat = g.sLat / g.n, lng = g.sLng / g.n;
    const nc = nearestCity(lat, lng);
    const area = areaGroupName(g.zip, g.labels);
    return { cityId: g.cityId, key, zip: g.zip, area: g.zip ? area : placeName(area) ?? area, label: placeName(topLabel(g)), verdict,
      lat: r2(lat), lng: r2(lng), players: g.n, nearestCityId: nc?.id ?? null, nearestCityMi: nc ? r1(nc.mi) : null };
  }).sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));
  const outside: OutsidePlace[] = [...out].map(([placeKey, g]) => {
    const lat = g.sLat / g.n, lng = g.sLng / g.n;
    const nc = nearestCity(lat, lng);
    const raw = placeKey.startsWith("label:") ? placeKey.slice(6) : areaGroupName(g.zip, g.labels);
    const place = placeName(raw) ?? raw;
    return { place, players: g.n, nearestCityId: nc?.id ?? null, nearestCityMi: nc ? r1(nc.mi) : null,
      lat: r2(lat), lng: r2(lng), zipKeys: [...g.zipKeys] };
  }).sort((a, b) => b.players - a.players || a.place.localeCompare(b.place));

  // --- city bubbles: in-market players with coordinates, grouped by (city, zip or grid cell) ---
  let waitlistPlayers = 0, unidentifiedPlayers = 0;
  const unplaced = new Map<number, number>();
  const groups = new Map<string, { key: string; zip: string | null; labels: (string | null)[]; cityId: number; sLat: number; sLng: number; n: number }>();
  for (const p of input.players) {
    if (p.verdict === "waitlist") { waitlistPlayers++; continue; }
    if (p.verdict === "unidentified") { unidentifiedPlayers++; continue; }
    const cityId = p.verdict_city_id;
    if (cityId == null || !cityIds.has(cityId)) continue;
    if (!validCoord(p.lat, p.lng)) { unplaced.set(cityId, (unplaced.get(cityId) ?? 0) + 1); continue; }
    const key = `${cityId}|${areaGroupKey(p.zip, p.lat, p.lng)}`;
    const g = groups.get(key) ?? { key, zip: p.zip, labels: [], cityId, sLat: 0, sLng: 0, n: 0 };
    g.sLat += p.lat; g.sLng += p.lng as number; g.n++;
    g.labels.push(p.area_label);
    groups.set(key, g);
  }

  const zipsExact = [...groups.values()].map((g) => ({ ...g, lat: g.sLat / g.n, lng: g.sLng / g.n }));
  // Coverage compares the EXACT nearest distance; only the displayed value is rounded.
  const nearestExact = new Map<string, number>();
  const zips: MapZip[] = zipsExact.map((z) => {
    let best: { id: number; mi: number } | null = null;
    for (const f of fieldsRaw) {
      const mi = milesBetween(z.lat, z.lng, f.lat, f.lng);
      if (!best || mi < best.mi) best = { id: f.id, mi };
    }
    if (best) nearestExact.set(z.key, best.mi);
    const inReach = Object.fromEntries(REACHES.map((r) => [r, best != null && best.mi <= r])) as Record<Reach, boolean>;
    const nearby: MapZip["nearby"] = [];
    for (const f of fieldsRaw) {
      const d = milesBetween(z.lat, z.lng, f.lat, f.lng);
      const minReach = REACHES.find((r) => d <= r);
      if (minReach != null) nearby.push({ fieldId: f.id, mi: r1(d), minReach });
    }
    nearby.sort((a, b) => a.mi - b.mi || a.fieldId - b.fieldId);
    const name = areaGroupName(z.zip, z.labels);
    return { key: z.key, zip: z.zip, area: z.zip ? name : placeName(name) ?? name, cityId: z.cityId,
      lat: r2(z.lat), lng: r2(z.lng), players: z.n,
      nearestFieldId: best?.id ?? null, nearestFieldMi: best ? r1(best.mi) : null, inReach, nearby };
  }).sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));

  const fields: MapField[] = fieldsRaw.map((f) => {
    const reach = zeroByReach();
    for (const z of zipsExact) {
      const mi = milesBetween(z.lat, z.lng, f.lat, f.lng);
      for (const r of REACHES) if (mi <= r) reach[r] += z.n;
    }
    return { ...f, reach };
  }).sort((a, b) => b.reach[5] - a.reach[5] || a.title.localeCompare(b.title));

  const cities: MapCity[] = input.cities.map((c) => {
    const cz = zips.filter((z) => z.cityId === c.id);
    const coverage = zeroByReach();
    for (const z of cz) {
      const mi = nearestExact.get(z.key);
      for (const r of REACHES) if (mi != null && mi <= r) coverage[r] += z.players;
    }
    return { ...c, players: cz.reduce((s, z) => s + z.players, 0), fields: fields.filter((f) => f.cityId === c.id).length,
      coverage, unplaced: unplaced.get(c.id) ?? 0 };
  }).sort((a, b) => b.players - a.players || b.fields - a.fields || a.name.localeCompare(b.name));

  return { cities, fields, zips, national, outside, badFields, waitlistPlayers, unidentifiedPlayers, activeWindowDays: ACTIVE_WINDOW_DAYS };
}
