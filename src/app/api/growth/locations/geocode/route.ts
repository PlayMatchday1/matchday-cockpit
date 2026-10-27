// GET /api/growth/locations/geocode?q=<address or place>: candidates for "Add a test field" on the
// Locations map. Growth only. Never MatchDay.
//
// WHICH GEOCODER (2026-10-27): the Clubhouse had none. A 5-digit zip is answered from our own
// zip_centroids (migration 0221, Census ZCTA points). Anything else goes to OpenStreetMap's Nominatim,
// the same OpenStreetMap the map tiles come from: no key, US only. Its usage policy allows at most
// one request a second, an identifying User-Agent and no search-as-you-type, so this runs only on an
// explicit "Find", is spaced a second apart per server instance, and never retries.

import { authenticateCapability } from "@/lib/capabilityAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = "MatchDay-Clubhouse/1.0 (internal ops tool; playmatchday.com)";
let lastCallMs = 0;

export type GeocodeHit = { label: string; lat: number; lng: number; source: "zip" | "openstreetmap" };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < 3) return Response.json({ error: "Type an address or place name, at least 3 characters." }, { status: 400 });

  if (/^\d{5}$/.test(q)) {
    const { data, error } = await auth.supabase.from("zip_centroids").select("zip,lat,lng").eq("zip", q).maybeSingle();
    if (error) return Response.json({ error: error.message }, { status: 502 });
    const hits: GeocodeHit[] = data ? [{ label: `Zip ${q} (centre of the zip)`, lat: Number(data.lat), lng: Number(data.lng), source: "zip" }] : [];
    return Response.json({ hits });
  }

  const wait = lastCallMs + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallMs = Date.now();
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", q);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "5");
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US" }, signal: AbortSignal.timeout(8000), cache: "no-store" });
    if (!res.ok) return Response.json({ error: `The geocoder answered HTTP ${res.status}. Try again in a moment, or click the map instead.` }, { status: 502 });
    const rows = (await res.json()) as { display_name?: string; lat?: string; lon?: string }[];
    const hits: GeocodeHit[] = rows.flatMap((r) => {
      const lat = Number(r.lat), lng = Number(r.lon);
      return Number.isFinite(lat) && Number.isFinite(lng) && r.display_name ? [{ label: r.display_name, lat, lng, source: "openstreetmap" as const }] : [];
    });
    return Response.json({ hits });
  } catch (e) {
    return Response.json({ error: `The geocoder did not answer (${e instanceof Error ? e.message : String(e)}). Click the map instead.` }, { status: 502 });
  }
}
