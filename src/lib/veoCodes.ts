// Server-only access to the veo_codes table: the runtime code→field map (with
// a short in-memory cache) plus the venue/field options that power the editor.
// The pure resolve/validate logic stays in src/lib/veo.ts.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeVeoCode,
  VEO_FIELD_CODES,
  type VeoFieldCode,
} from "@/lib/veo";

export type VeoCodeRow = {
  id: string;
  code: string;
  fin_venue_id: number;
  field_ids: number[];
  field_label: string;
  city: string;
  confirmed: boolean;
};

// Fresh SELECT of all code rows (for the editor + building the resolver map).
export async function fetchVeoCodeRows(
  supabase: SupabaseClient,
): Promise<VeoCodeRow[]> {
  const res = await supabase
    .from("veo_codes")
    .select("id, code, fin_venue_id, field_ids, field_label, city, confirmed")
    .order("code");
  if (res.error) throw new Error(`veo_codes query failed: ${res.error.message}`);
  return (res.data ?? []).map((r) => ({
    id: r.id as string,
    code: r.code as string,
    fin_venue_id: r.fin_venue_id as number,
    field_ids: Array.isArray(r.field_ids) ? (r.field_ids as unknown[]).map(Number) : [],
    field_label: r.field_label as string,
    city: r.city as string,
    confirmed: r.confirmed === true,
  }));
}

export function veoCodeRowsToMap(rows: VeoCodeRow[]): Record<string, VeoFieldCode> {
  const map: Record<string, VeoFieldCode> = {};
  for (const r of rows) {
    map[normalizeVeoCode(r.code)] = {
      finVenueId: r.fin_venue_id,
      fieldIds: r.field_ids,
      fieldLabel: r.field_label,
      city: r.city,
      confirmed: r.confirmed,
    };
  }
  return map;
}

// Cached resolver map for the hot matching path (inbound). Short TTL so an
// admin edit (confirm/rename) takes effect within ~a minute across instances;
// the editor's own reads use fetchVeoCodeRows (fresh) so the UI is never stale.
// Falls back to the in-code constant if the table read fails, so posting still
// works during a DB blip.
let cache: { map: Record<string, VeoFieldCode>; at: number } | null = null;
const TTL_MS = 60_000;

export async function getVeoCodesMap(
  supabase: SupabaseClient,
): Promise<Record<string, VeoFieldCode>> {
  const nowMs = Date.now();
  if (cache && nowMs - cache.at < TTL_MS) return cache.map;
  try {
    const map = veoCodeRowsToMap(await fetchVeoCodeRows(supabase));
    cache = { map, at: nowMs };
    return map;
  } catch (err) {
    console.error("[veo:codes] load failed — falling back to constant", err);
    return VEO_FIELD_CODES;
  }
}

export function invalidateVeoCodesCache(): void {
  cache = null;
}

// Real fields grouped by venue, for the editor's field multi-select — so a code
// can only ever map to field_ids that actually exist under a venue.
export type VenueFieldOption = {
  fin_venue_id: number;
  venue_name: string;
  city: string;
  fields: { mdapi_field_id: number; field_title: string }[];
};

export async function loadVenueFieldOptions(
  supabase: SupabaseClient,
): Promise<VenueFieldOption[]> {
  const [venuesRes, fieldsRes] = await Promise.all([
    supabase.from("fin_venues").select("id, venue_name, city").order("city").order("venue_name"),
    supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id, field_title_at_link"),
  ]);
  if (venuesRes.error) throw new Error(`fin_venues query failed: ${venuesRes.error.message}`);
  if (fieldsRes.error) throw new Error(`fin_venue_fields query failed: ${fieldsRes.error.message}`);

  const byVenue = new Map<number, { mdapi_field_id: number; field_title: string }[]>();
  for (const f of fieldsRes.data ?? []) {
    const vid = f.fin_venue_id as number;
    if (!byVenue.has(vid)) byVenue.set(vid, []);
    byVenue.get(vid)!.push({
      mdapi_field_id: f.mdapi_field_id as number,
      field_title: (f.field_title_at_link as string | null) ?? `field ${f.mdapi_field_id}`,
    });
  }

  const out: VenueFieldOption[] = [];
  for (const v of venuesRes.data ?? []) {
    const fields = byVenue.get(v.id as number);
    if (!fields || fields.length === 0) continue;
    fields.sort((a, b) => a.mdapi_field_id - b.mdapi_field_id);
    out.push({
      fin_venue_id: v.id as number,
      venue_name: v.venue_name as string,
      city: v.city as string,
      fields,
    });
  }
  return out;
}

// Validate that every requested field_id exists AND belongs to fin_venue_id
// (via fin_venue_fields). Returns null on success, or an error message.
export async function validateFieldOwnership(
  supabase: SupabaseClient,
  finVenueId: number,
  fieldIds: number[],
): Promise<string | null> {
  const res = await supabase
    .from("fin_venue_fields")
    .select("mdapi_field_id")
    .eq("fin_venue_id", finVenueId)
    .in("mdapi_field_id", fieldIds);
  if (res.error) return "Could not verify fields.";
  const owned = new Set((res.data ?? []).map((r) => r.mdapi_field_id as number));
  const missing = fieldIds.filter((id) => !owned.has(id));
  if (missing.length > 0) {
    return `Field ${missing.join(", ")} does not belong to the selected venue.`;
  }
  return null;
}
