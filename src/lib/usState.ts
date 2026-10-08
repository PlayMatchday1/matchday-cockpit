// The US state a coordinate falls in — SERVER-ONLY (the player-areas sync). Never import this from a
// client component: the boundaries file is ~115 KB and the page reads the stored result instead.
//
// Boundaries: us-atlas 3.0.1 states-10m.json, a TopoJSON redistribution of the US Census Bureau's
// 2017 cartographic boundary files at 1:10,000,000. At that scale a border can be off by a few
// hundred metres, so a home right on a state line may resolve to its neighbour. A point outside
// every state (offshore, abroad, or bad coordinates) returns null and the page shows the city alone.

import "server-only";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import statesTopo from "us-atlas/states-10m.json";

// FIPS state code → USPS two-letter code. Stable; the Census ids in states-10m are these strings.
const FIPS_TO_USPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
  "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
  "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
  "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
};

type Ring = number[][]; // [lng, lat][]
type Shape = { code: string; polys: Ring[][]; minX: number; minY: number; maxX: number; maxY: number };

let shapes: Shape[] | null = null;

function load(): Shape[] {
  if (shapes) return shapes;
  const topo = statesTopo as unknown as Topology<{ states: GeometryCollection<{ name: string }> }>;
  const fc = feature(topo, topo.objects.states);
  const out: Shape[] = [];
  for (const f of fc.features) {
    const code = FIPS_TO_USPS[String(f.id ?? "")];
    if (!code || !f.geometry) continue;
    const g = f.geometry;
    const polys: Ring[][] = g.type === "Polygon" ? [g.coordinates as Ring[]]
      : g.type === "MultiPolygon" ? (g.coordinates as Ring[][]) : [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const poly of polys) for (const [x, y] of poly[0] ?? []) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    out.push({ code, polys, minX, minY, maxX, maxY });
  }
  shapes = out;
  return out;
}

/** Ray casting. Even-odd, so a hole ring (a lake, an enclave) correctly flips the point back out. */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x: number, y: number, poly: Ring[]): boolean {
  if (!poly[0] || !inRing(x, y, poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (inRing(x, y, poly[h])) return false;
  return true;
}

/** Two-letter state for a coordinate, or null when it is outside every state. */
export function stateForPoint(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const s of load()) {
    if (lng < s.minX || lng > s.maxX || lat < s.minY || lat > s.maxY) continue;
    for (const poly of s.polys) if (inPolygon(lng, lat, poly)) return s.code;
  }
  return null;
}
