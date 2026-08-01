// GET /api/schedule-master/field-map — the venue→field mapping the Master
// Schedule duplicate detector needs. Returns every fin_venue_fields row
// (fin_venue_id, mdapi_field_id) plus the venue name/city, so the client can
// build: field_id → fin_venue, and fin_venue → field count. Read-only.
//
// A venue "has N fields" = COUNT(*) of fin_venue_fields rows for its
// fin_venue_id. A match's field_id that appears in no row = an unmapped venue
// (duplicates can't be checked). Same auth as the schedule-master data it
// augments.

import { authenticateCrm } from "@/lib/crmAuth";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function GET(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }
  const { supabase } = auth;

  const vf = await supabase
    .from("fin_venue_fields")
    .select("fin_venue_id, mdapi_field_id, field_title_at_link");
  if (vf.error) {
    console.error("[schedule-master:field-map] fin_venue_fields error", vf.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const rows = (vf.data ?? []) as {
    fin_venue_id: number;
    mdapi_field_id: number;
    field_title_at_link: string | null;
  }[];

  const venueIds = Array.from(new Set(rows.map((r) => r.fin_venue_id)));
  const venuesRes = venueIds.length
    ? await supabase.from("fin_venues").select("id, venue_name, city").in("id", venueIds)
    : { data: [], error: null };
  if (venuesRes.error) {
    console.error("[schedule-master:field-map] fin_venues error", venuesRes.error);
    return Response.json({ error: "DB error" }, { status: 500 });
  }
  const venues = (venuesRes.data ?? []) as { id: number; venue_name: string | null; city: string | null }[];

  return Response.json({ fields: rows, venues }, { status: 200 });
}
