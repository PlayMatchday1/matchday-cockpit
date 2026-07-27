// Server-side shared bits for turning an mdapi match into a ONE-OFF
// schedule_master row. Shared by the auto-reconcile job (source='auto_completed')
// and one-click add (source='manual') so the two can never build rows
// differently. Kept out of scheduleReconcile.ts so that file stays pure/testable.

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCityName } from "@/lib/cityNormalization";
import { CITY_CODE_TO_DISPLAY, matchLocalDateTime } from "@/lib/scheduleReconcile";

export type VenueMaps = {
  fieldToVenueId: Map<number, number>;
  venueName: Map<number, string>;
};

export async function loadVenueMaps(supabase: SupabaseClient): Promise<VenueMaps> {
  const [vfRes, vRes] = await Promise.all([
    supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
    supabase.from("fin_venues").select("id, venue_name"),
  ]);
  if (vfRes.error) throw new Error(vfRes.error.message);
  if (vRes.error) throw new Error(vRes.error.message);
  const fieldToVenueId = new Map<number, number>();
  for (const r of vfRes.data ?? []) fieldToVenueId.set(r.mdapi_field_id as number, r.fin_venue_id as number);
  const venueName = new Map<number, string>();
  for (const r of vRes.data ?? []) venueName.set(r.id as number, r.venue_name as string);
  return { fieldToVenueId, venueName };
}

export type OneOffMatch = {
  api_id: number;
  field_id: number | null;
  field_title: string | null;
  start_date: string | null;
  max_player_count: number | null;
  city_identifier: string | null;
  city_name?: string | null;
  raw: { field?: { city?: { name?: string | null } | null } | null } | null;
};

export type OneOffRow = {
  match_api_id: number;
  city: string;
  venue: string;
  detail: string;
  match_date: string;
  match_time: string;
  max_spots: number;
  mdapi_field_id: number | null;
  source: "manual" | "auto_completed";
};

// Returns null when the match can't be placed on a real calendar date.
export function buildOneOffRow(
  m: OneOffMatch,
  maps: VenueMaps,
  source: "manual" | "auto_completed",
): OneOffRow | null {
  const local = matchLocalDateTime(m.start_date);
  if (!local) return null;
  const vid = m.field_id != null ? maps.fieldToVenueId.get(m.field_id) : undefined;
  const code = normalizeCityName(m.raw?.field?.city?.name ?? m.city_name ?? m.city_identifier);
  const cityDisplay = (code && CITY_CODE_TO_DISPLAY[code]) || m.city_name || code || "";
  return {
    match_api_id: m.api_id,
    city: cityDisplay,
    venue: (vid != null ? maps.venueName.get(vid) : undefined) ?? m.field_title ?? "?",
    detail: m.field_title ?? cityDisplay,
    match_date: local.date,
    match_time: local.timeLabel,
    max_spots: m.max_player_count ?? 0,
    mdapi_field_id: m.field_id,
    source,
  };
}
