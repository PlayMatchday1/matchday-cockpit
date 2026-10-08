// THE LOCATIONS MODEL — pure, shared by the sync (which stores verdicts) and the page route (which
// only reads them). Facts it rests on: docs/matchday-api-facts.md, "Player location / home area".
//
// NO TIMES IN THIS FILE. first_seen_at is a true UTC instant written by our own sync; the page
// renders it in America/Chicago. Nothing here touches match wall-clock or promo UTC helpers.

export type AreaCity = { id: number; name: string; abbr: string; lat: number; lng: number; radiusMiles: number };

export type Verdict = "in_market" | "waitlist" | "unidentified";

/** SOURCE IS THE areaSource VALUE ALONE (Ryan, confirmed by Vitalii, 2026-10-08): "zip" is Zip,
 *  "none"/absent is not set, ANY other value is GPS. Zip and coordinates cannot tell them apart —
 *  the backend looks a zip up from GPS coordinates and coordinates up from a zip, so both kinds carry
 *  both. KNOWN BACKEND BUG at time of writing: GPS shares are labelled "zip", so GPS reads 0 until
 *  Vitalii's fix lands (the page says so under the GPS card while it is 0). The raw value is stored
 *  and displayed, so the GPS spelling shows when it arrives. */
export type SourceKind = "zip" | "gps" | "none";
export function sourceKind(raw: unknown): SourceKind {
  if (raw == null || raw === "" || raw === "none") return "none";
  return raw === "zip" ? "zip" : "gps";
}

const INTERNAL = /@(play)?matchday\.com$/i;
export function isInternalEmail(email: unknown): boolean {
  return typeof email === "string" && INTERNAL.test(email.trim());
}

/** Zips are strings. A number here would already have lost its leading zero, so refuse it. */
export function zipOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const z = raw.trim();
  return z === "" ? null : z;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A player has an area when areaSource says so — "none" is not set, whatever else the row carries. */
export function hasArea(p: { areaSource?: unknown }): boolean {
  return sourceKind(p.areaSource) !== "none";
}

const EARTH_MI = 3958.7613;
export function milesBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type VerdictResult = {
  verdict: Verdict;
  verdictCityId: number | null;
  nearestCityId: number | null;
  nearestCityMi: number | null;
};

/** Unidentified = no usable lat/lng (a zip the backend did not resolve). Otherwise IN MARKET if the
 *  point is inside ANY city's radius — the nearest such city wins, since Austin and San Antonio
 *  overlap — and WAITLIST if it is outside every radius. nearestCity is the nearest overall. */
export function computeVerdict(lat: unknown, lng: unknown, cities: AreaCity[]): VerdictResult {
  const la = num(lat), ln = num(lng);
  if (la == null || ln == null || cities.length === 0) {
    return { verdict: "unidentified", verdictCityId: null, nearestCityId: null, nearestCityMi: null };
  }
  let nearest: { id: number; mi: number } | null = null;
  let inside: { id: number; mi: number } | null = null;
  for (const c of cities) {
    const mi = milesBetween(la, ln, c.lat, c.lng);
    if (!nearest || mi < nearest.mi) nearest = { id: c.id, mi };
    if (mi <= c.radiusMiles && (!inside || mi < inside.mi)) inside = { id: c.id, mi };
  }
  return {
    verdict: inside ? "in_market" : "waitlist",
    verdictCityId: inside?.id ?? null,
    nearestCityId: nearest!.id,
    nearestCityMi: Math.round(nearest!.mi * 10) / 10,
  };
}

/** US cities only — Warsaw is excluded from verdicts and from the page (Ryan). */
export function usCities(raw: unknown[]): AreaCity[] {
  const out: AreaCity[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const id = num(c?.id), lat = num(c?.lat), lng = num(c?.lng), radiusMiles = num(c?.radiusMiles);
    if (c?.country !== "United States" || id == null || lat == null || lng == null || radiusMiles == null) continue;
    out.push({ id, name: String(c.name ?? ""), abbr: String(c.abbr ?? ""), lat, lng, radiusMiles });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Changes whenever any city's centre or radius changes, or a city is added or removed. */
export function geometryKey(cities: AreaCity[]): string {
  return cities.map((c) => `${c.id}:${c.lat},${c.lng},${c.radiusMiles}`).join("|");
}
