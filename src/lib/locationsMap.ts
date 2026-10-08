// THE LOCATIONS MAP, aggregated — pure. /api/matchops/locations/map reads Supabase and hands the rows
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

import { milesBetween, type AreaCity } from "./playerAreaModel";

export const REACHES = [3, 5, 10] as const;
export type Reach = (typeof REACHES)[number];
type ByReach = Record<Reach, number>;

export type MapPlayerRow = {
  zip: string | null;
  area_label: string | null;
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
export type MapZip = {
  zip: string; cityId: number; lat: number; lng: number; players: number;
  nearestFieldId: number | null; nearestFieldMi: number | null;
  /** Exact-distance verdict per reach, so the browser never compares a rounded number. */
  inReach: Record<Reach, boolean>;
};
export type MapCity = AreaCity & {
  players: number; fields: number; coverage: ByReach;
  unplaced: number; // in this city's market but no lat/lng to place (unidentified zips have no city)
};
/** All-cities view: one bubble per (verdict, zip) across the country — in-market AND outside
 *  coverage. Same rounding and averaging as MapZip. nearestCity is the nearest US city CENTRE. */
export type NationalZip = {
  key: string; zip: string; label: string | null; verdict: "in_market" | "waitlist";
  lat: number; lng: number; players: number; nearestCityId: number | null; nearestCityMi: number | null;
};
/** Outside coverage grouped by place (area label, falling back to zip). lat/lng = the players'
 *  average (rounded), so a row can zoom the map to its bubble. */
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

export function buildLocationsMap(input: {
  players: MapPlayerRow[];
  cities: AreaCity[];
  /** One snapshot per match row in the active window; the newest updatedAt per field wins. */
  fieldSnapshots: FieldSnapshot[];
}): LocationsMap {
  const cityIds = new Set(input.cities.map((c) => c.id));

  // --- fields: newest snapshot per field, active (not deleted upstream), in a US city ---
  const latest = new Map<number, FieldSnapshot>();
  for (const s of input.fieldSnapshots) {
    const prev = latest.get(s.fieldId);
    if (!prev || s.updatedAt >= prev.updatedAt) latest.set(s.fieldId, s);
  }
  const fieldsRaw: Omit<MapField, "reach">[] = [];
  const badFields: LocationsMap["badFields"] = [];
  for (const s of latest.values()) {
    if (s.deletedAt) continue;
    if (s.cityId == null || !cityIds.has(s.cityId)) continue; // Warsaw / unknown city
    if (!validCoord(s.lat, s.lng)) {
      badFields.push({ id: s.fieldId, title: s.title ?? `Field ${s.fieldId}`, cityId: s.cityId, lat: s.lat, lng: s.lng });
      continue;
    }
    fieldsRaw.push({ id: s.fieldId, title: s.title ?? `Field ${s.fieldId}`, cityId: s.cityId, lat: s.lat, lng: s.lng as number });
  }

  // --- national bubbles + outside places: every placed player, in market or not ---
  const nearestCity = (lat: number, lng: number) => {
    let best: { id: number; mi: number } | null = null;
    for (const c of input.cities) {
      const d = milesBetween(lat, lng, c.lat, c.lng);
      if (!best || d < best.mi) best = { id: c.id, mi: d };
    }
    return best;
  };
  type Acc = { sLat: number; sLng: number; n: number; labels: Map<string, number>; zipKeys: Set<string> };
  const add = (m: Map<string, Acc>, key: string, p: MapPlayerRow, zipKey: string) => {
    const g = m.get(key) ?? { sLat: 0, sLng: 0, n: 0, labels: new Map(), zipKeys: new Set() };
    g.sLat += p.lat as number; g.sLng += p.lng as number; g.n++;
    if (p.area_label) g.labels.set(p.area_label, (g.labels.get(p.area_label) ?? 0) + 1);
    g.zipKeys.add(zipKey);
    m.set(key, g);
  };
  const topLabel = (g: Acc) => [...g.labels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const nat = new Map<string, Acc>();
  const out = new Map<string, Acc>();
  for (const p of input.players) {
    if (p.verdict === "unidentified" || !validCoord(p.lat, p.lng)) continue;
    const key = `${p.verdict}|${p.zip ?? "No zip"}`;
    add(nat, key, p, key);
    if (p.verdict === "waitlist") add(out, p.area_label ?? p.zip ?? "No zip", p, key);
  }
  const national: NationalZip[] = [...nat].map(([key, g]) => {
    const [verdict, zip] = key.split("|") as ["in_market" | "waitlist", string];
    const lat = g.sLat / g.n, lng = g.sLng / g.n;
    const nc = nearestCity(lat, lng);
    return { key, zip, label: topLabel(g), verdict, lat: r2(lat), lng: r2(lng), players: g.n,
      nearestCityId: nc?.id ?? null, nearestCityMi: nc ? r1(nc.mi) : null };
  }).sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));
  const outside: OutsidePlace[] = [...out].map(([place, g]) => {
    const lat = g.sLat / g.n, lng = g.sLng / g.n;
    const nc = nearestCity(lat, lng);
    return { place, players: g.n, nearestCityId: nc?.id ?? null, nearestCityMi: nc ? r1(nc.mi) : null,
      lat: r2(lat), lng: r2(lng), zipKeys: [...g.zipKeys] };
  }).sort((a, b) => b.players - a.players || a.place.localeCompare(b.place));

  // --- zips: in-market players with coordinates, grouped by (city, zip) ---
  let waitlistPlayers = 0, unidentifiedPlayers = 0;
  const unplaced = new Map<number, number>();
  const groups = new Map<string, { zip: string; cityId: number; sLat: number; sLng: number; n: number }>();
  for (const p of input.players) {
    if (p.verdict === "waitlist") { waitlistPlayers++; continue; }
    if (p.verdict === "unidentified") { unidentifiedPlayers++; continue; }
    const cityId = p.verdict_city_id;
    if (cityId == null || !cityIds.has(cityId)) continue;
    if (!validCoord(p.lat, p.lng)) { unplaced.set(cityId, (unplaced.get(cityId) ?? 0) + 1); continue; }
    const zip = p.zip ?? "No zip";
    const key = `${cityId}|${zip}`;
    const g = groups.get(key) ?? { zip, cityId, sLat: 0, sLng: 0, n: 0 };
    g.sLat += p.lat; g.sLng += p.lng as number; g.n++;
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
    if (best) nearestExact.set(`${z.cityId}|${z.zip}`, best.mi);
    const within = (r: number) => best != null && best.mi <= r;
    return { zip: z.zip, cityId: z.cityId, lat: r2(z.lat), lng: r2(z.lng), players: z.n,
      nearestFieldId: best?.id ?? null, nearestFieldMi: best ? r1(best.mi) : null,
      inReach: { 3: within(3), 5: within(5), 10: within(10) } };
  }).sort((a, b) => b.players - a.players || a.zip.localeCompare(b.zip));

  const fields: MapField[] = fieldsRaw.map((f) => {
    const reach = { 3: 0, 5: 0, 10: 0 } as ByReach;
    for (const z of zipsExact) {
      const mi = milesBetween(z.lat, z.lng, f.lat, f.lng);
      for (const r of REACHES) if (mi <= r) reach[r] += z.n;
    }
    return { ...f, reach };
  }).sort((a, b) => b.reach[5] - a.reach[5] || a.title.localeCompare(b.title));

  const cities: MapCity[] = input.cities.map((c) => {
    const cz = zips.filter((z) => z.cityId === c.id);
    const coverage = { 3: 0, 5: 0, 10: 0 } as ByReach;
    for (const z of cz) {
      const mi = nearestExact.get(`${z.cityId}|${z.zip}`);
      for (const r of REACHES) if (mi != null && mi <= r) coverage[r] += z.players;
    }
    return { ...c, players: cz.reduce((s, z) => s + z.players, 0), fields: fields.filter((f) => f.cityId === c.id).length,
      coverage, unplaced: unplaced.get(c.id) ?? 0 };
  }).sort((a, b) => b.players - a.players || b.fields - a.fields || a.name.localeCompare(b.name));

  return { cities, fields, zips, national, outside, badFields, waitlistPlayers, unidentifiedPlayers, activeWindowDays: ACTIVE_WINDOW_DAYS };
}
