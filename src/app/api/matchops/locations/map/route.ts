// GET /api/matchops/locations/map — the Locations page's Map tab. READ ONLY, Supabase only.
//
// HARD RULE (Ryan, 2026-10-08): no MatchDay call on page load and no new or longer sync — the API
// dyno has a 512 MB quota and went down today. Field coordinates come from mdapi_matches.raw.field,
// which the existing match sync already stores; cities from the latest player-areas run; players
// from player_area_seen. Aggregation is src/lib/locationsMap.ts.

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { selectAll } from "@/lib/supabasePagination";
import { buildLocationsMap, ACTIVE_WINDOW_DAYS, type MapPlayerRow, type FieldSnapshot } from "@/lib/locationsMap";
import type { AreaCity } from "@/lib/playerAreaModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type MatchFieldRow = {
  api_id: number; field_id: number | null; field_title: string | null;
  lat: unknown; lng: unknown; cityId: unknown; del: unknown; upd: unknown;
};

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  /* THE ACTIVE WINDOW IS A DATE BOUNDARY ON A WALL-CLOCK COLUMN. mdapi_matches.start_date is local
   * wall clock carrying a Z it does not mean; comparing it to a YYYY-MM-DD string 60 days back can
   * misplace a match by a few hours at the edge, which cannot change whether a field played in the
   * last two months. No Date is built from start_date here. */
  const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);

  try {
    const [players, matches, okRun] = await Promise.all([
      selectAll<MapPlayerRow>(() => sb.from("player_area_seen")
        .select("zip,lat,lng,verdict,verdict_city_id")
        .eq("has_area", true).eq("is_internal", false)
        .order("player_id")),
      selectAll<MatchFieldRow>(() => sb.from("mdapi_matches")
        .select("api_id,field_id,field_title,lat:raw->field->lat,lng:raw->field->lng,cityId:raw->field->cityId,del:raw->field->deletedAt,upd:raw->field->updatedAt")
        .gte("start_date", since).is("deleted_at", null).eq("is_cancelled", false)
        .order("api_id")),
      sb.from("player_area_sync_runs").select("finished_at,cities")
        .eq("ok", true).order("finished_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (okRun.error) throw new Error(okRun.error.message);

    const cities = (Array.isArray(okRun.data?.cities) ? okRun.data!.cities : []) as AreaCity[];
    const fieldSnapshots: FieldSnapshot[] = [];
    for (const m of matches) {
      if (m.field_id == null) continue;
      fieldSnapshots.push({
        fieldId: m.field_id, title: m.field_title,
        cityId: typeof m.cityId === "number" ? m.cityId : null,
        lat: m.lat, lng: m.lng, deletedAt: m.del,
        updatedAt: typeof m.upd === "string" ? m.upd : "",
      });
    }

    const map = buildLocationsMap({ players, cities, fieldSnapshots });
    return Response.json({ ...map, citiesAsOf: okRun.data?.finished_at ?? null },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
