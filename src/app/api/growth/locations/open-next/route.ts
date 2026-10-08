// GET /api/growth/locations/open-next?reach=10 — the Overview's "Where to open next" table.
// READ ONLY, Supabase only, Growth's gate. The method is src/lib/locationsInsights.ts (openNextForCity).
//
// CACHED until the next sync: the result depends only on the stored player locations (which change
// when a player-areas run finishes), the active field set (which changes with the match sync) and
// the reach. All three are in the key, so a new sync or a field change recomputes and nothing older
// is served. In memory, per server instance — a cold instance simply computes it once (milliseconds
// per city).

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { activeFields } from "@/lib/locationsMap";
import { fetchFieldSnapshots, fetchLatestCities } from "@/lib/locationsData";
import { placeName } from "@/lib/playerAreaModel";
import { effectiveVerdict, openNextForCity, MIN_PLAYERS_FOR_SUGGESTIONS, type CityOpenNext, type Verdict } from "@/lib/locationsInsights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const REACHES = new Set([3, 5, 10, 15]);
type Payload = { reach: number; minPlayers: number; cities: { id: number; name: string }[]; results: CityOpenNext[] };
const cache = new Map<string, Payload>();

type Row = { zip: string | null; lat: number | null; lng: number | null; area_label: string | null; state: string | null; verdict: Verdict; verdict_city_id: number | null };

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;
  const reach = Number(new URL(req.url).searchParams.get("reach") ?? 10);
  if (!REACHES.has(reach)) return Response.json({ error: "reach must be 3, 5, 10 or 15" }, { status: 400 });

  try {
    const [latest, snaps] = await Promise.all([fetchLatestCities(sb), fetchFieldSnapshots(sb)]);
    const { fields } = activeFields(snaps, latest.cities);
    const fieldsKey = fields.map((f) => `${f.id}:${f.lat},${f.lng}`).sort().join("|");
    const generation = `${latest.asOf}|${fieldsKey}`;
    const key = `${generation}|${reach}`;
    const hit = cache.get(key);
    if (hit) return Response.json({ ...hit, cached: true }, { headers: { "Cache-Control": "no-store" } });

    const markets = new Set(fields.map((f) => f.cityId));
    const rows = await selectAll<Row>(() => sb.from("player_area_seen")
      .select("zip,lat,lng,area_label,state,verdict,verdict_city_id")
      .eq("has_area", true).eq("is_internal", false).order("player_id"));
    const byCity = new Map<number, { lat: number; lng: number; label: string | null; zip: string | null }[]>();
    for (const raw of rows) {
      const r = effectiveVerdict(raw, markets);
      if (r.verdict !== "in_market" || r.verdict_city_id == null || r.lat == null || r.lng == null) continue;
      const list = byCity.get(r.verdict_city_id) ?? [];
      list.push({ lat: r.lat, lng: r.lng, label: placeName(r.area_label, r.state), zip: r.zip });
      byCity.set(r.verdict_city_id, list);
    }
    // Every MARKET city gets a row: suggestions, or "not enough players yet". A city with no field is
    // not a market (its players are New markets material), so it is not in this table.
    const marketCities = latest.cities.filter((c) => markets.has(c.id));
    const results = marketCities.map((c) => openNextForCity(c.id, byCity.get(c.id) ?? [], fields, reach));
    const payload: Payload = { reach, minPlayers: MIN_PLAYERS_FOR_SUGGESTIONS, cities: marketCities.map((c) => ({ id: c.id, name: c.name })), results };
    // Keep this generation's other reaches; drop older generations, which can never be served again.
    for (const k of cache.keys()) if (!k.startsWith(`${generation}|`)) cache.delete(k);
    cache.set(key, payload);
    return Response.json({ ...payload, cached: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
