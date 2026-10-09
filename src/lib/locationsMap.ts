// THE LOCATIONS MAP, aggregated — pure. /api/growth/locations/map reads Supabase and hands the rows
// here; the browser gets cities, fields and per-zip bubbles, never a player row.
//
// NO MATCHDAY CALLS, NO NEW SYNC. Every input is already in Supabase:
//   players  player_area_seen (written by the player-areas sync, three times a day)
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
import { clusterOutside, effectiveVerdict, type OutsidePoint } from "./locationsInsights";
import { activityOf, emptyActivity, summarizePlays, type Activity, type BubblePlays, type Play, type PlayField } from "./wherePlayed";

export const REACHES = [3, 5, 10, 15] as const;
export type Reach = (typeof REACHES)[number];
type ByReach = Record<Reach, number>;
const zeroByReach = () => Object.fromEntries(REACHES.map((r) => [r, 0])) as ByReach;

export type MapPlayerRow = {
  /** Used on the server only (to join play history); never sent to the browser. */
  player_id?: number;
  zip: string | null;
  area_label: string | null;
  /** Migration 0216: worked out by the sync from lat/lng. */
  state: string | null;
  lat: number | null;
  lng: number | null;
  verdict: "in_market" | "waitlist" | "unidentified";
  verdict_city_id: number | null;
  /** Migration 0221: 'zip_centroid' = located from zip (MatchDay sent no coordinates). */
  location_source?: string | null;
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
  /** Where this bubble's players have played (wherePlayed.ts), and how recently. */
  plays: BubblePlays;
  activity: Record<Activity, number>;
  /** Set on the Activity-mode bubbles only: every player in this bubble is in this bucket. */
  bucket?: Activity;
  /** Players in this bubble located from zip (placed at the zip's Census centre). */
  fromZip: number;
};
export type MapCity = AreaCity & {
  /** False for a city with no active field: not a market (kept out of the pills and the city list). */
  hasFields: boolean;
  players: number; fields: number; coverage: ByReach;
  unplaced: number; // in this city's market but no lat/lng to place (unidentified zips have no city)
  /** The city's placed players by when they last played (the All cities badge in Activity mode). */
  activity: Record<Activity, number>;
};
/** All-cities view: one bubble per (verdict, zip) across the country — in-market AND outside
 *  coverage. Same rounding and averaging as MapZip. nearestCity is the nearest US city CENTRE. */
export type NationalZip = {
  /** In market: the player's own city (verdict_city_id); null outside coverage. Bubbles never merge
   *  across cities, so an in-market zip only ever rolls up into its own city. */
  cityId: number | null;
  key: string; zip: string | null; area: string; label: string | null; verdict: "in_market" | "waitlist";
  lat: number; lng: number; players: number; nearestCityId: number | null; nearestCityMi: number | null;
  plays: BubblePlays;
  activity: Record<Activity, number>;
  bucket?: Activity;
  fromZip: number;
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
  /** ACTIVITY MODE: the same bubbles, split so that a bubble only ever holds one activity bucket. */
  zipsActivity: MapZip[];
  nationalActivity: NationalZip[];
  /** Every field any bubble's players have played at — active or closed — for the lines and the table. */
  playFields: PlayField[];
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
  /** Each player's plays (playHistory.ts) and the fields they were at. Optional: absent = none known. */
  history?: { playsByPlayer: Map<number, Play[]>; fields: Map<number, PlayField> };
  now?: Date;
}): LocationsMap {
  const core = buildCore(input, null);
  const split = buildCore(input, "activity");
  return { ...core, zipsActivity: split.zips, nationalActivity: split.national,
    playFields: [...(input.history?.fields.values() ?? [])] };
}

/* THE BUBBLES, built once per mode. `split` = "activity" adds each player's activity bucket to every
 * grouping key, so no bubble mixes buckets (the browser's pixel clustering keeps them apart too). */
/* WHICH BUBBLE EACH PLAYER IS IN — the admin-only "Players in this area" table (locate() below).
 * Recorded by the SAME loops that build the bubbles, so a bubble's player list cannot disagree with
 * its count. Never part of the map payload. */
type KeySink = Map<number, { nat?: string; city?: string; fieldReach?: Record<number, Reach>; verdict?: "in_market" | "waitlist"; cityId?: number | null; label?: string | null }>;
const sinkOf = (sink: KeySink, id: number) => { const e = sink.get(id) ?? {}; sink.set(id, e); return e; };

function buildCore(input: Parameters<typeof buildLocationsMap>[0], split: "activity" | null, sink?: KeySink): Omit<LocationsMap, "zipsActivity" | "nationalActivity" | "playFields"> {
  const nowMs = (input.now ?? new Date()).getTime();
  const playsOf = (p: MapPlayerRow): Play[] => (p.player_id != null ? input.history?.playsByPlayer.get(p.player_id) ?? [] : []);
  const actOf = (p: MapPlayerRow): Activity => {
    const plays = playsOf(p);
    return activityOf(plays.length ? Math.max(...plays.map((x) => x.ms)) : null, nowMs);
  };
  const sfx = (p: MapPlayerRow) => (split ? `|a:${actOf(p)}` : "");
  const fieldById = input.history?.fields ?? new Map<number, PlayField>();
  const summarize = (members: MapPlayerRow[], lat: number, lng: number) => summarizePlays(members.map(playsOf), { lat, lng }, fieldById);
  const tally = (members: MapPlayerRow[]) => { const a = emptyActivity(); for (const m of members) a[actOf(m)]++; return a; };
  const fromZipOf = (members: MapPlayerRow[]) => members.filter((m) => m.location_source === "zip_centroid").length;
  const cityIds = new Set(input.cities.map((c) => c.id));
  const { fields: fieldsRaw, badFields } = activeFields(input.fieldSnapshots, input.cities);
  // A city with no active field is not a market: its players count as outside coverage (the sync
  // stores the same; applying it here keeps the page right before the next run).
  const markets = new Set(fieldsRaw.map((f) => f.cityId));
  // Labels become "City, ST" ONCE, here, so every bubble, place and detail card carries the state.
  input = { ...input, players: input.players.map((p) => effectiveVerdict({ ...p, area_label: placeName(p.area_label, p.state) }, markets)) };

  // --- national bubbles + outside places: every placed player, in market or not ---
  const nearestCity = (lat: number, lng: number) => {
    let best: { id: number; mi: number } | null = null;
    for (const c of input.cities) {
      const d = milesBetween(lat, lng, c.lat, c.lng);
      if (!best || d < best.mi) best = { id: c.id, mi: d };
    }
    return best;
  };
  type Acc = { zip: string | null; cityId: number | null; sLat: number; sLng: number; n: number; labels: (string | null)[]; zipKeys: Set<string>; members: MapPlayerRow[] };
  const add = (m: Map<string, Acc>, key: string, p: MapPlayerRow, zipKey: string) => {
    const g = m.get(key) ?? { zip: p.zip, cityId: p.verdict === "in_market" ? p.verdict_city_id : null, sLat: 0, sLng: 0, n: 0, labels: [], zipKeys: new Set(), members: [] };
    g.sLat += p.lat as number; g.sLng += p.lng as number; g.n++;
    g.members.push(p);
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
  const outPts: OutsidePoint[] = [];
  for (const p of input.players) {
    if (p.verdict === "unidentified" || !validCoord(p.lat, p.lng)) continue;
    const area = areaGroupKey(p.zip, p.lat, p.lng)!; // valid coordinates, so never null
    const key = `${p.verdict}|${p.verdict === "in_market" ? p.verdict_city_id : ""}|${area}${sfx(p)}`;
    add(nat, key, p, key);
    if (sink && p.player_id != null) Object.assign(sinkOf(sink, p.player_id), { nat: key, verdict: p.verdict, cityId: p.verdict === "in_market" ? p.verdict_city_id : null, label: p.area_label });
    if (p.verdict === "waitlist") outPts.push({ lat: p.lat as number, lng: p.lng as number, label: p.area_label, zip: p.zip, key });
  }
  const national: NationalZip[] = [...nat].map(([key, g]) => {
    const verdict = key.slice(0, key.indexOf("|")) as "in_market" | "waitlist";
    const lat = g.sLat / g.n, lng = g.sLng / g.n;
    const nc = nearestCity(lat, lng);
    const area = areaGroupName(g.zip, g.labels);
    return { cityId: g.cityId, key, zip: g.zip, area: g.zip ? area : placeName(area) ?? area, label: placeName(topLabel(g)), verdict,
      lat: r2(lat), lng: r2(lng), players: g.n, nearestCityId: nc?.id ?? null, nearestCityMi: nc ? r1(nc.mi) : null,
      plays: summarize(g.members, lat, lng), activity: tally(g.members), fromZip: fromZipOf(g.members), ...(split ? { bucket: actOf(g.members[0]) } : {}) };
  }).sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));
  // NEW MARKETS: outside-coverage players clustered within 25 miles of each other (the Overview
  // shows the same clusters). zipKeys = the national bubbles in the cluster, for selecting one.
  const outside: OutsidePlace[] = clusterOutside(outPts, input.cities).map((c) => ({
    place: c.name, players: c.players, nearestCityId: c.nearestCityId, nearestCityMi: c.nearestCityMi,
    lat: c.lat, lng: c.lng, zipKeys: c.memberKeys,
  }));

  // --- city bubbles: in-market players with coordinates, grouped by (city, zip or grid cell) ---
  let waitlistPlayers = 0, unidentifiedPlayers = 0;
  const unplaced = new Map<number, number>();
  const groups = new Map<string, { key: string; zip: string | null; labels: (string | null)[]; cityId: number; sLat: number; sLng: number; n: number; members: MapPlayerRow[] }>();
  for (const p of input.players) {
    if (p.verdict === "waitlist") { waitlistPlayers++; continue; }
    if (p.verdict === "unidentified") { unidentifiedPlayers++; continue; }
    const cityId = p.verdict_city_id;
    if (cityId == null || !cityIds.has(cityId)) continue;
    if (!validCoord(p.lat, p.lng)) { unplaced.set(cityId, (unplaced.get(cityId) ?? 0) + 1); continue; }
    const key = `${cityId}|${areaGroupKey(p.zip, p.lat, p.lng)}${sfx(p)}`;
    const g = groups.get(key) ?? { key, zip: p.zip, labels: [], cityId, sLat: 0, sLng: 0, n: 0, members: [] };
    if (sink && p.player_id != null) sinkOf(sink, p.player_id).city = key;
    g.sLat += p.lat; g.sLng += p.lng as number; g.n++;
    g.members.push(p);
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
      nearestFieldId: best?.id ?? null, nearestFieldMi: best ? r1(best.mi) : null, inReach, nearby,
      plays: summarize(z.members, z.lat, z.lng), activity: tally(z.members), fromZip: fromZipOf(z.members), ...(split ? { bucket: actOf(z.members[0]) } : {}) };
  }).sort((a, b) => b.players - a.players || a.key.localeCompare(b.key));

  /* A FIELD'S PLAYERS are the ones whose bubble centre is within reach of it — the rule field.reach
   * counts by just below — so "within 10 mi of X" lists exactly the field card's number. */
  if (sink) for (const z of zipsExact) {
    const fr: Record<number, Reach> = {};
    for (const f of fieldsRaw) {
      const r = REACHES.find((x) => milesBetween(z.lat, z.lng, f.lat, f.lng) <= x);
      if (r != null) fr[f.id] = r;
    }
    for (const m of z.members) if (m.player_id != null) sinkOf(sink, m.player_id).fieldReach = fr;
  }

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
    const activity = emptyActivity();
    for (const z of cz) for (const k of Object.keys(activity) as Activity[]) activity[k] += z.activity[k];
    return { ...c, hasFields: markets.has(c.id), players: cz.reduce((s, z) => s + z.players, 0), fields: fields.filter((f) => f.cityId === c.id).length,
      coverage, unplaced: unplaced.get(c.id) ?? 0, activity };
  }).sort((a, b) => b.players - a.players || b.fields - a.fields || a.name.localeCompare(b.name));

  return { cities, fields, zips, national, outside, badFields, waitlistPlayers, unidentifiedPlayers, activeWindowDays: ACTIVE_WINDOW_DAYS };
}

/* ── ONE ROW PER PLAYER, for the admin-only "Players in this area" table ─────────────────────────
 * Each placed player with the keys of the bubbles they sit in (Coverage and Activity, city and
 * national), the fields whose reach holds their bubble, and their own play summary. Built by the
 * same buildCore as the map, so selecting a bubble lists exactly the players it counts. */
export type PlayerPlace = {
  playerId: number;
  verdict: "in_market" | "waitlist";
  /** In market: their market city. Null outside coverage. */
  cityId: number | null;
  /** What their bubble is called (the zip, or the shared area label). */
  area: string;
  zip: string | null;
  /** "City, ST", from their area label. */
  label: string | null;
  state: string | null;
  activity: Activity;
  matches: number;
  lastDay: string | null;
  favouriteFieldId: number | null;
  keys: { nat: string; natAct: string; city: string | null; cityAct: string | null };
  /** Field id -> the smallest reach that contains this player's bubble. */
  fieldReach: Record<number, Reach>;
  /** Placed at their zip's Census centre because MatchDay sent no coordinates. */
  fromZip: boolean;
};

export function locatePlayers(input: Parameters<typeof buildLocationsMap>[0]): PlayerPlace[] {
  const cov: KeySink = new Map(), actS: KeySink = new Map();
  const core = buildCore(input, null, cov);
  buildCore(input, "activity", actS);
  const areaOf = new Map<string, string>([...core.national.map((z) => [z.key, z.area] as const), ...core.zips.map((z) => [z.key, z.area] as const)]);
  const nowMs = (input.now ?? new Date()).getTime();
  const stateOf = new Map(input.players.map((p) => [p.player_id, p.state]));
  const zipOf = new Map(input.players.map((p) => [p.player_id, p.zip]));
  const srcOf = new Map(input.players.map((p) => [p.player_id, p.location_source ?? null]));
  const out: PlayerPlace[] = [];
  for (const [id, e] of cov) {
    if (!e.nat || !e.verdict) continue;
    const a = actS.get(id) ?? {};
    const plays = input.history?.playsByPlayer.get(id) ?? [];
    let last: (typeof plays)[number] | null = null;
    const byField = new Map<number, { n: number; ms: number }>();
    for (const p of plays) {
      if (!last || p.ms > last.ms) last = p;
      const g = byField.get(p.fieldId) ?? { n: 0, ms: 0 };
      g.n++; g.ms = Math.max(g.ms, p.ms);
      byField.set(p.fieldId, g);
    }
    // FAVOURITE = the most matches; a tie goes to the one played most recently.
    const fav = [...byField].sort((x, y) => y[1].n - x[1].n || y[1].ms - x[1].ms)[0]?.[0] ?? null;
    out.push({
      playerId: id, verdict: e.verdict, cityId: e.cityId ?? null,
      area: areaOf.get(e.city ?? e.nat) ?? areaOf.get(e.nat) ?? "",
      zip: zipOf.get(id) ?? null, label: e.label ?? null, state: stateOf.get(id) ?? null,
      activity: activityOf(last ? last.ms : null, nowMs), matches: plays.length, lastDay: last?.day ?? null,
      favouriteFieldId: fav,
      keys: { nat: e.nat, natAct: a.nat ?? e.nat, city: e.city ?? null, cityAct: a.city ?? null },
      fieldReach: e.fieldReach ?? {},
      fromZip: srcOf.get(id) === "zip_centroid",
    });
  }
  return out;
}
