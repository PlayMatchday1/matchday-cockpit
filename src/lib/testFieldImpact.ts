// TEST FIELDS ON THE LOCATIONS MAP, what a field at a pin would add. Pure. The route
// (/api/growth/locations/test-fields/impact) reads Supabase and hands the rows here; the browser gets
// counts only, never a player row.
//
// THE SAME BUBBLES AS THE MAP. Coverage on the Map tab is per bubble (locationsMap.ts buildCore): an
// in-market player's bubble is (city, zip or ~1-mile grid cell), sits at its players' EXACT average,
// and is covered at reach r when an active venue is within r of that centre. This file groups the
// same way, so "Coverage now" here equals the Map tab's coverage card for the same rows. A pin is one
// more venue: "with test fields" = the nearest of the real venues AND every pin.
//
// CITY-LEVEL ONLY IS LEFT OUT (Ryan, 2026-10-27). A player counts only with a zip or a GPS share
// (areaSource "zip" or any other non-"none" value, playerAreaModel.ts). One with neither is counted in
// `leftOut` and in no other number here, before or after.
//
// A TEST PIN IS NEVER A REAL FIELD. It lives in growth_test_fields, and nothing but this file and its
// route ever treats one as a venue.

import { areaGroupKey, milesBetween, type AreaCity } from "./playerAreaModel";
import { effectiveVerdict } from "./locationsInsights";
import { REACHES, type Reach } from "./locationsMap";

export const ACTIVE_RECENT_DAYS = 90;
const MAX_REACH = REACHES[REACHES.length - 1];
const r1 = (n: number) => Math.round(n * 10) / 10;

export type TestPlayerRow = {
  player_id: number;
  zip: string | null;
  area_source: string | null;
  lat: number | null;
  lng: number | null;
  verdict: "in_market" | "waitlist" | "unidentified";
  verdict_city_id: number | null;
};
export type VenuePoint = { id: number; title: string; cityId: number; lat: number; lng: number };
export type PinPoint = { key: string; lat: number; lng: number };

type Bubble = { cityId: number | null; lat: number; lng: number; members: number[]; existingMi: number | null };

const validCoord = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng)
  && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

/** A zip, or a location source that is set (anything but "none" / absent). Otherwise city-level only. */
export const hasPreciseLocation = (p: Pick<TestPlayerRow, "zip" | "area_source">) =>
  p.zip != null || (p.area_source != null && p.area_source !== "" && p.area_source !== "none");

/** The map's bubbles: in market per city, outside coverage on their own. Unidentified and unplaced
 *  players are on no bubble, as on the map. */
export function testFieldBubbles(input: { players: TestPlayerRow[]; cities: AreaCity[]; venues: VenuePoint[] }) {
  const cityIds = new Set(input.cities.map((c) => c.id));
  const markets = new Set(input.venues.map((v) => v.cityId));
  const leftOutByCity = new Map<number | null, number>();
  const groups = new Map<string, { cityId: number | null; sLat: number; sLng: number; members: number[] }>();
  for (const raw of input.players) {
    const p = effectiveVerdict(raw, markets);
    if (p.verdict === "unidentified" || !validCoord(p.lat, p.lng)) continue;
    const cityId = p.verdict === "in_market" ? p.verdict_city_id : null;
    if (p.verdict === "in_market" && (cityId == null || !cityIds.has(cityId))) continue;
    if (!hasPreciseLocation(p)) { leftOutByCity.set(cityId, (leftOutByCity.get(cityId) ?? 0) + 1); continue; }
    const key = `${cityId ?? "w"}|${areaGroupKey(p.zip, p.lat, p.lng)}`;
    const g = groups.get(key) ?? { cityId, sLat: 0, sLng: 0, members: [] };
    g.sLat += p.lat; g.sLng += p.lng as number; g.members.push(p.player_id);
    groups.set(key, g);
  }
  const bubbles: Bubble[] = [...groups.values()].map((g) => {
    const lat = g.sLat / g.members.length, lng = g.sLng / g.members.length;
    let existingMi: number | null = null;
    for (const v of input.venues) {
      const d = milesBetween(lat, lng, v.lat, v.lng);
      if (existingMi == null || d < existingMi) existingMi = d;
    }
    return { cityId: g.cityId, lat, lng, members: g.members, existingMi };
  });
  return { bubbles, leftOutByCity, markets };
}

/** Everyone on a bubble within the largest reach of any pin: whose last play the route must read. */
export function playersNearPins(bubbles: Bubble[], pins: PinPoint[]): number[] {
  const out: number[] = [];
  for (const b of bubbles) if (pins.some((p) => milesBetween(b.lat, b.lng, p.lat, p.lng) <= MAX_REACH)) out.push(...b.members);
  return out;
}

export type PinReach = { players: number; newCoverage: number; outsideMarket: number; activeRecent: number };
/** ONE PLAYER NEAR A PIN, for the admin-only "Players in this area" table. `reach` = the smallest reach
 *  that holds their bubble on the EXACT distance; `fieldReach` = the same for the nearest real venue
 *  (null: none within the largest reach). Within r = reach <= r; new coverage at r = also
 *  (fieldReach null or > r). The SAME tests byReach counts by, so the table matches the pin. */
export type PinMember = { id: number; mi: number; reach: Reach; fieldReach: Reach | null };
export type PinImpact = {
  key: string;
  /** The market the pin sits in: the nearest city with an active venue whose radius contains it. */
  cityId: number | null;
  byReach: Record<Reach, PinReach>;
  nearestFields: { id: number; title: string; cityId: number; mi: number }[];
  /** Admin only: the route drops this for anyone else. */
  members?: PinMember[];
};
export type CityImpact = { cityId: number; players: number; leftOut: number; before: Record<Reach, number>; after: Record<Reach, number> };
export type TestFieldImpact = { pins: PinImpact[]; cities: CityImpact[]; leftOut: number; activeRecentDays: number };

export function testFieldImpact(input: {
  bubbles: Bubble[]; leftOutByCity: Map<number | null, number>; markets: Set<number>;
  cities: AreaCity[]; venues: VenuePoint[]; pins: PinPoint[];
  /** Each nearby player's last valid play (ms). Absent = never played. */
  lastPlayMs: Map<number, number>; nowMs: number;
}): TestFieldImpact {
  const { bubbles, cities, venues, pins } = input;
  const recentFrom = input.nowMs - ACTIVE_RECENT_DAYS * 86_400_000;
  const isRecent = (id: number) => (input.lastPlayMs.get(id) ?? -Infinity) >= recentFrom;
  const zero = (): PinReach => ({ players: 0, newCoverage: 0, outsideMarket: 0, activeRecent: 0 });

  const pinOut: PinImpact[] = pins.map((pin) => {
    let home: { id: number; mi: number } | null = null;
    for (const c of cities) {
      if (!input.markets.has(c.id)) continue;
      const d = milesBetween(pin.lat, pin.lng, c.lat, c.lng);
      if (d <= c.radiusMiles && (!home || d < home.mi)) home = { id: c.id, mi: d };
    }
    const byReach = Object.fromEntries(REACHES.map((r) => [r, zero()])) as Record<Reach, PinReach>;
    const members: PinMember[] = [];
    for (const b of bubbles) {
      const d = milesBetween(b.lat, b.lng, pin.lat, pin.lng);
      if (d > MAX_REACH) continue;
      const reach = REACHES.find((r) => d <= r)!;
      const fieldReach = b.existingMi == null ? null : REACHES.find((r) => b.existingMi! <= r) ?? null;
      for (const id of b.members) members.push({ id, mi: r1(d), reach, fieldReach });
      const recent = b.members.filter(isRecent).length;
      for (const r of REACHES) {
        if (d > r) continue;
        const x = byReach[r];
        x.players += b.members.length;
        x.activeRecent += recent;
        if (b.existingMi == null || b.existingMi > r) x.newCoverage += b.members.length;
        if (b.cityId == null) x.outsideMarket += b.members.length;
      }
    }
    const nearestFields = venues
      .map((v) => ({ id: v.id, title: v.title, cityId: v.cityId, mi: milesBetween(pin.lat, pin.lng, v.lat, v.lng) }))
      .sort((a, b) => a.mi - b.mi).slice(0, 3).map((v) => ({ ...v, mi: r1(v.mi) }));
    return { key: pin.key, cityId: home?.id ?? null, byReach, nearestFields, members };
  });

  // Every city a pin sits in, and any other whose coverage a pin changes.
  const cityOut: CityImpact[] = [];
  for (const c of cities) {
    if (!input.markets.has(c.id)) continue;
    const before = Object.fromEntries(REACHES.map((r) => [r, 0])) as Record<Reach, number>;
    const after = { ...before };
    let players = 0;
    for (const b of bubbles) {
      if (b.cityId !== c.id) continue;
      players += b.members.length;
      let best = b.existingMi ?? Infinity;
      for (const p of pins) best = Math.min(best, milesBetween(b.lat, b.lng, p.lat, p.lng));
      for (const r of REACHES) {
        if (b.existingMi != null && b.existingMi <= r) before[r] += b.members.length;
        if (best <= r) after[r] += b.members.length;
      }
    }
    const touched = pinOut.some((p) => p.cityId === c.id) || REACHES.some((r) => after[r] !== before[r]);
    if (touched) cityOut.push({ cityId: c.id, players, leftOut: input.leftOutByCity.get(c.id) ?? 0, before, after });
  }
  const leftOut = [...input.leftOutByCity.values()].reduce((s, n) => s + n, 0);
  return { pins: pinOut, cities: cityOut, leftOut, activeRecentDays: ACTIVE_RECENT_DAYS };
}
