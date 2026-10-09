// The Locations page's Supabase reads that more than one route needs — SERVER-ONLY. Never MatchDay.
//
// Field coordinates come from mdapi_matches.raw.field (the existing match sync stores them), US
// cities from the latest successful player-areas run. Shared by /api/growth/locations/map and the
// Overview's player detail (/api/growth/locations/player) so both see the same fields.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { ACTIVE_WINDOW_DAYS, type FieldSnapshot } from "./locationsMap";
import type { AreaCity } from "./playerAreaModel";
import type { VenueLink } from "./venueUnits";

type MatchFieldRow = {
  api_id: number; field_id: number | null; field_title: string | null;
  lat: unknown; lng: unknown; cityId: unknown; del: unknown; upd: unknown;
};

/* THE ACTIVE WINDOW IS A DATE BOUNDARY ON A WALL-CLOCK COLUMN. mdapi_matches.start_date is local
 * wall clock carrying a Z it does not mean; comparing it to a YYYY-MM-DD string 60 days back can
 * misplace a match by a few hours at the edge, which cannot change whether a field played in the
 * last two months. No Date is built from start_date here. */
export async function fetchFieldSnapshots(sb: SupabaseClient, now = new Date()): Promise<FieldSnapshot[]> {
  const since = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const matches = await selectAll<MatchFieldRow>(() => sb.from("mdapi_matches")
    .select("api_id,field_id,field_title,lat:raw->field->lat,lng:raw->field->lng,cityId:raw->field->cityId,del:raw->field->deletedAt,upd:raw->field->updatedAt")
    .gte("start_date", since).is("deleted_at", null).eq("is_cancelled", false)
    .order("api_id"));
  const out: FieldSnapshot[] = [];
  for (const m of matches) {
    if (m.field_id == null) continue;
    out.push({
      fieldId: m.field_id, title: m.field_title,
      cityId: typeof m.cityId === "number" ? m.cityId : null,
      lat: m.lat, lng: m.lng, deletedAt: m.del,
      updatedAt: typeof m.upd === "string" ? m.upd : "",
    });
  }
  return out;
}

export async function fetchLatestCities(sb: SupabaseClient): Promise<{ cities: AreaCity[]; asOf: string | null }> {
  const { data, error } = await sb.from("player_area_sync_runs").select("finished_at,cities")
    .eq("ok", true).order("finished_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return { cities: (Array.isArray(data?.cities) ? data!.cities : []) as AreaCity[], asOf: data?.finished_at ?? null };
}

/** Field -> canonical venue (fin_venue_fields + fin_venues.venue_name), for grouping field records into
 *  venues on the Locations page (venueUnits.ts). Every link, excluded_from_venue included. */
export async function fetchVenueLinks(sb: SupabaseClient): Promise<Map<number, VenueLink>> {
  const [links, venues] = await Promise.all([
    selectAll<{ mdapi_field_id: number; fin_venue_id: number }>(() => sb.from("fin_venue_fields").select("mdapi_field_id,fin_venue_id").order("mdapi_field_id")),
    selectAll<{ id: number; venue_name: string }>(() => sb.from("fin_venues").select("id,venue_name").order("id")),
  ]);
  const name = new Map(venues.map((v) => [Number(v.id), v.venue_name]));
  const out = new Map<number, VenueLink>();
  for (const l of links) if (l.mdapi_field_id != null && l.fin_venue_id != null)
    out.set(Number(l.mdapi_field_id), { venueId: Number(l.fin_venue_id), venueName: name.get(Number(l.fin_venue_id)) ?? `Venue ${l.fin_venue_id}` });
  return out;
}
