// THE LOCATIONS PAGE'S DERIVED VIEWS — pure. Shared by the Overview and the Map so both tabs agree.
//
//   effectiveVerdict  a city with no active field is not a market (the sync stores this too; applying
//                     it on read keeps the page right between a field change and the next sync)
//   clusterOutside    "New markets": outside-coverage players grouped within 25 miles of each other
//   openNext          "Where to open next": where one more field would reach the most players in a
//                     city who have no field in reach today
//
// Every distance is straight-line (haversine) on the player's exact coordinates, server-side.

import { milesBetween, GPS_NO_ZIP, type AreaCity } from "./playerAreaModel";

export type Verdict = "in_market" | "waitlist" | "unidentified";

/** In market only for a city that has an active field; otherwise outside coverage. */
export function effectiveVerdict<T extends { verdict: Verdict; verdict_city_id: number | null }>(row: T, markets: ReadonlySet<number>): T {
  if (row.verdict === "in_market" && (row.verdict_city_id == null || !markets.has(row.verdict_city_id))) {
    return { ...row, verdict: "waitlist", verdict_city_id: null };
  }
  return row;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const mode = (xs: (string | null)[]) => {
  const c = new Map<string, number>();
  for (const x of xs) if (x) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
};
/** "Irving, TX" → "Irving": suggestion names read "Near Irving". */
const cityPart = (label: string | null) => (label ? label.split(",")[0].trim() : null);

// ── NEW MARKETS ───────────────────────────────────────────────────────────────────────────────
export const NEW_MARKET_CLUSTER_MI = 25;
export type OutsidePoint = { lat: number; lng: number; label: string | null; zip: string | null; key: string };
export type NewMarket = {
  key: string; name: string; players: number; lat: number; lng: number;
  nearestCityId: number | null; nearestCityMi: number | null; memberKeys: string[];
};

/** Single-linkage clusters: two players within 25 mi of each other share a cluster (and so,
 *  transitively, does anyone within 25 mi of either). Named by the most common place label. */
export function clusterOutside(points: OutsidePoint[], cities: AreaCity[], withinMi = NEW_MARKET_CLUSTER_MI): NewMarket[] {
  const parent = points.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (milesBetween(points[i].lat, points[i].lng, points[j].lat, points[j].lng) <= withinMi) parent[find(i)] = find(j);
  }
  const groups = new Map<number, OutsidePoint[]>();
  points.forEach((p, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), p]); });
  return [...groups.values()].map((g) => {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length, lng = g.reduce((s, p) => s + p.lng, 0) / g.length;
    let nearest: { id: number; mi: number } | null = null;
    for (const c of cities) { const d = milesBetween(lat, lng, c.lat, c.lng); if (!nearest || d < nearest.mi) nearest = { id: c.id, mi: d }; }
    const label = mode(g.map((p) => p.label));
    const zips = new Set(g.map((p) => p.zip));
    const name = label ?? (zips.size === 1 && g[0].zip ? g[0].zip : GPS_NO_ZIP);
    const memberKeys = [...new Set(g.map((p) => p.key))];
    return { key: memberKeys.slice().sort().join("+"), name, players: g.length, lat: r2(lat), lng: r2(lng),
      nearestCityId: nearest?.id ?? null, nearestCityMi: nearest ? r1(nearest.mi) : null, memberKeys };
  }).sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
}

// ── WHERE TO OPEN NEXT ────────────────────────────────────────────────────────────────────────
/** A city needs at least this many players with a location before it gets suggestions. */
export const MIN_PLAYERS_FOR_SUGGESTIONS = 25;
/** A suggestion that would reach fewer new players than this is not made. */
export const MIN_PLAYERS_PER_SUGGESTION = 5;
export const MAX_SUGGESTIONS_PER_CITY = 3;
const GRID_MI = 1;

export type CityPlayer = { lat: number; lng: number; label: string | null; zip: string | null };
export type FieldPoint = { id: number; title: string; lat: number; lng: number };
export type Suggestion = {
  cityId: number; rank: number; name: string;
  /** Players with no field in reach today (and not reached by a higher-ranked suggestion in this
   *  city) whom a field here would reach. Summing a city's rows never double-counts. */
  playersReached: number;
  /** Share of the city's players with a field in reach: today, and with this field (and the
   *  higher-ranked suggestions in the same city) added. */
  coverageNowPct: number; coverageWithPct: number;
  nearestFieldId: number | null; nearestFieldTitle: string | null; nearestFieldMi: number | null;
};
export type CityOpenNext =
  | { cityId: number; status: "ok"; players: number; suggestions: Suggestion[] }
  | { cityId: number; status: "too_few"; players: number; needed: number };

/** Greedy max-coverage on a ~1-mile grid over the city's uncovered players. */
export function openNextForCity(cityId: number, players: CityPlayer[], fields: FieldPoint[], reachMi: number): CityOpenNext {
  if (players.length < MIN_PLAYERS_FOR_SUGGESTIONS) {
    return { cityId, status: "too_few", players: players.length, needed: MIN_PLAYERS_FOR_SUGGESTIONS };
  }
  const covered = players.map((p) => fields.some((f) => milesBetween(p.lat, p.lng, f.lat, f.lng) <= reachMi));
  const coveredNow = covered.filter(Boolean).length;
  let uncovered = players.map((p, i) => ({ p, i })).filter((x) => !covered[x.i]);

  /* THE GRID, in a flat miles-based projection around the city (x = lng scaled by cos(latitude),
   * y = lat), so the scan is a squared-distance test — ~50k candidate spots for a 200-mile-wide
   * city would be too slow on haversine. Within 15 miles the projection's error is a few hundredths
   * of a mile; the WINNING spot's players are then recounted exactly with haversine, and that exact
   * count is what is reported. The grid spans the uncovered players, padded by the reach. */
  const midLat = players.reduce((a, p) => a + p.lat, 0) / players.length;
  const kx = 69.172 * Math.cos((midLat * Math.PI) / 180), ky = 69.0;
  const r2max = reachMi * reachMi;
  const suggestions: Suggestion[] = [];
  let coveredSoFar = coveredNow;
  for (let rank = 1; rank <= MAX_SUGGESTIONS_PER_CITY && uncovered.length >= MIN_PLAYERS_PER_SUGGESTION; rank++) {
    const xs = uncovered.map((u) => u.p.lng * kx), ys = uncovered.map((u) => u.p.lat * ky);
    const x0 = Math.min(...xs) - reachMi, x1 = Math.max(...xs) + reachMi, y0 = Math.min(...ys) - reachMi, y1 = Math.max(...ys) + reachMi;
    let best: { x: number; y: number; n: number } | null = null;
    for (let y = y0; y <= y1; y += GRID_MI) {
      for (let x = x0; x <= x1; x += GRID_MI) {
        let n = 0;
        for (let k = 0; k < xs.length; k++) { const dx = xs[k] - x, dy = ys[k] - y; if (dx * dx + dy * dy <= r2max) n++; }
        if (!best || n > best.n) best = { x, y, n };
      }
    }
    if (!best) break;
    const spot = { lat: best.y / ky, lng: best.x / kx };
    const hits: number[] = [];
    for (let k = 0; k < uncovered.length; k++) if (milesBetween(spot.lat, spot.lng, uncovered[k].p.lat, uncovered[k].p.lng) <= reachMi) hits.push(k);
    if (hits.length < MIN_PLAYERS_PER_SUGGESTION) break;
    const reached = hits.map((k) => uncovered[k].p);
    const label = cityPart(mode(reached.map((p) => p.label)));
    const zips = new Set(reached.map((p) => p.zip));
    const sharedZip = zips.size === 1 && reached[0].zip ? reached[0].zip : null;
    const name = label ? `Near ${label}${sharedZip ? ` (${sharedZip})` : ""}` : sharedZip ? `Near ${sharedZip}` : "Unnamed area";
    let nf: { f: FieldPoint; mi: number } | null = null;
    for (const f of fields) { const d = milesBetween(spot.lat, spot.lng, f.lat, f.lng); if (!nf || d < nf.mi) nf = { f, mi: d }; }
    coveredSoFar += reached.length;
    suggestions.push({
      cityId, rank, name, playersReached: reached.length,
      coverageNowPct: Math.round((coveredNow / players.length) * 100),
      coverageWithPct: Math.round((coveredSoFar / players.length) * 100),
      nearestFieldId: nf?.f.id ?? null, nearestFieldTitle: nf?.f.title ?? null, nearestFieldMi: nf ? r1(nf.mi) : null,
    });
    const hit = new Set(hits);
    uncovered = uncovered.filter((_, k) => !hit.has(k));
  }
  return { cityId, status: "ok", players: players.length, suggestions };
}

