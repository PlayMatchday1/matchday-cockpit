// POST /api/growth/locations/test-fields/impact: what fields at these pins would add. READ ONLY,
// Supabase only, never MatchDay. Body { pins: [{ key, lat, lng }] }, saved pins and unsaved ones alike.
// The model is src/lib/testFieldImpact.ts; the answer is counts only, never a player row.
//
// Same inputs as the Map tab (locationsInputs.ts), minus the full play history: only the players
// within 15 mi of a pin have their last play read, so this answers in a few seconds.

import { authenticateCapability } from "@/lib/capabilityAuth";
import { selectAll } from "@/lib/supabasePagination";
import { activeFields } from "@/lib/locationsMap";
import { fetchFieldSnapshots, fetchLatestCities, fetchVenueLinks } from "@/lib/locationsData";
import { groupIntoUnits } from "@/lib/venueUnits";
import { fetchPlayHistory } from "@/lib/playHistory";
import { playersNearPins, testFieldBubbles, testFieldImpact, type PinPoint, type TestPlayerRow } from "@/lib/testFieldImpact";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_PINS = 25;

export async function POST(req: Request) {
  const auth = await authenticateCapability(req, "growth");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  let body: { pins?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "Body is not JSON." }, { status: 400 }); }
  const raw = Array.isArray(body.pins) ? body.pins : [];
  if (raw.length > MAX_PINS) return Response.json({ error: `At most ${MAX_PINS} test pins at a time.` }, { status: 400 });
  const pins: PinPoint[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    const lat = Number(p?.lat), lng = Number(p?.lng), key = String(p?.key ?? "");
    if (!key || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return Response.json({ error: "Each pin needs a key and a valid lat and lng." }, { status: 400 });
    }
    pins.push({ key, lat, lng });
  }

  try {
    const now = new Date();
    const [players, snaps, latest, links] = await Promise.all([
      selectAll<TestPlayerRow>(() => sb.from("player_area_seen")
        .select("player_id,zip,area_source,lat,lng,verdict,verdict_city_id")
        .eq("has_area", true).eq("is_internal", false).order("player_id")),
      fetchFieldSnapshots(sb, now),
      fetchLatestCities(sb),
      fetchVenueLinks(sb),
    ]);
    const { fields } = activeFields(snaps, latest.cities);
    const venues = groupIntoUnits(fields, links);
    const { bubbles, leftOutByCity, markets } = testFieldBubbles({ players, cities: latest.cities, venues });
    const near = playersNearPins(bubbles, pins);
    const history = near.length ? await fetchPlayHistory(sb, near, new Set(fields.map((f) => f.id)), now) : null;
    const lastPlayMs = new Map<number, number>();
    for (const [id, plays] of history?.playsByPlayer ?? []) if (plays.length) lastPlayMs.set(id, Math.max(...plays.map((p) => p.ms)));
    const impact = testFieldImpact({ bubbles, leftOutByCity, markets, cities: latest.cities, venues, pins, lastPlayMs, nowMs: now.getTime() });
    return Response.json({ ...impact, citiesAsOf: latest.asOf }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
