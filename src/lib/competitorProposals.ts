// "LOOKS LIKE OURS" — the Competitors page's name-match proposals, SERVER-ONLY, Supabase only.
// Moved here unchanged from /api/growth/competitors so the Locations map skips exactly the
// facilities the Competitors page flags (Ryan, 2026-10-09).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proposeLink, sortFormats, type NameCandidate } from "./competitorSupply";
import type { SharedVenue } from "./competitorVenues";

/** What the capture calls a city, against what fin_venues calls it. */
export const CITY_LABEL_TO_OURS: Record<string, string> = {
  Houston: "Houston",
  "Dallas / Fort Worth": "Dallas",
};

/* ── THE PROPOSALS ────────────────────────────────────────────────────────────────────────────
 * THEY ARE BOOKING OUR FIELDS, and that is the most actionable thing in the capture. But
 * our_venue_id stays NULL until a person accepts: "Athlete Training & Health | Cypress" and
 * "Athlete Training and Health | Katy" differ by one word and are different places, one of
 * which is ours. So the page flags the PROPOSAL, distinct from a confirmed link, and shows the
 * evidence beside it. Nothing here writes. */
export async function competitorProposals(
  sb: SupabaseClient,
  captures: { id: number; city_label: string }[],
  supply: Record<string, unknown>[],
  venues: { id: number; venue_name: string; city: string }[],
  venueFields: Map<number, number>,
  tableReady: boolean,
) {
  const titlesByVenue = new Map<number, Set<string>>();
  if (tableReady) {
    const { data: titleRows } = await sb.from("mdapi_matches")
      .select("field_id, field_title")
      .gte("start_date", "2026-01-01T00:00:00Z").lte("start_date", "2026-12-31T23:59:59Z")
      .limit(20000);
    for (const t of titleRows ?? []) {
      const vid = venueFields.get(Number(t.field_id));
      if (!vid) continue;
      if (!titlesByVenue.has(vid)) titlesByVenue.set(vid, new Set());
      titlesByVenue.get(vid)!.add(String(t.field_title ?? ""));
    }
  }
  const capById = new Map(captures.map((c) => [c.id, c]));
  /* A TIE GOES TO A VENUE WITH A FIELD, then the lower id (Ryan, 2026-10-09). proposeLink keeps the
   * first of equal scores, and fin_venues was read with no ORDER BY, so "Athlete Training and Health |
   * Katy" (0.9 against both ATH Katy, venue 7, and ATH Katy Sunday, venue 23, which has no field)
   * could propose either depending on row order. */
  const withField = new Set(venueFields.values());
  const ordered = [...venues].sort((a, b) => Number(withField.has(b.id)) - Number(withField.has(a.id)) || a.id - b.id);
  return supply.map((s) => {
    const cap = capById.get(Number(s.capture_id));
    const ourCity = cap ? CITY_LABEL_TO_OURS[cap.city_label] : null;
    const cands: NameCandidate[] = [];
    for (const v of ordered) {
      if (v.city !== ourCity) continue;
      for (const via of [v.venue_name, ...(titlesByVenue.get(v.id) ?? [])])
        cands.push({ venueId: v.id, venueName: v.venue_name, via });
    }
    /* A FACILITY SOMEBODY HAS ALREADY RULED ON IS NOT PROPOSED AGAIN. Ryan ruled both HatTrick
     * locations are a different facility from our venue 52, same owner; re-asking every time
     * Houston is re-captured is how a settled question becomes noise. */
    if (s.not_ours === true || s.our_venue_id != null) return null;
    const p = proposeLink(String(s.facility), cands);
    return { supplyId: Number(s.id), ...p };
  }).filter((p): p is NonNullable<typeof p> => p != null && p.venueId != null);
}

/* ── SHARED VENUES (Ryan, 2026-10-09) ─────────────────────────────────────────────────────────────
 * A competitor listing that IS one of our fields: CONFIRMED (our_venue_id set by a person on the
 * Competitors page) or PROPOSED (the name match above, nobody has ruled yet). The Locations map draws
 * them at OUR field's position, and the Competitors page lists them, from this one function.
 *
 * OUR FIELD'S POSITION is the newest stored field object (mdapi_matches.raw.field) among the
 * MatchDay fields linked to that venue in fin_venue_fields. A venue with no linked field has no
 * position: `field` is null and the map says so rather than guessing a neighbour. */
export async function sharedVenues(
  sb: SupabaseClient,
  captures: { id: number; source: string; city_label: string; captured_at?: string | null }[],
  supply: Record<string, unknown>[],
  venues: { id: number; venue_name: string; city: string }[],
  venueFields: Map<number, number>,
  proposals: { supplyId: number; venueId: number | null }[],
): Promise<SharedVenue[]> {
  const capById = new Map(captures.map((c) => [c.id, c]));
  const venueById = new Map(venues.map((v) => [v.id, v]));
  const proposedFor = new Map(proposals.filter((p) => p.venueId != null).map((p) => [p.supplyId, p.venueId as number]));
  const rows = supply.flatMap((s) => {
    const id = Number(s.id);
    const confirmed = s.our_venue_id != null ? Number(s.our_venue_id) : null;
    const venueId = confirmed ?? proposedFor.get(id) ?? null;
    const cap = capById.get(Number(s.capture_id));
    if (venueId == null || !cap) return [];
    return [{ s, id, venueId, status: (confirmed != null ? "confirmed" : "proposed") as SharedVenue["status"], cap }];
  });
  // Our fields per venue, and each field's newest stored position.
  const fieldsOf = new Map<number, number[]>();
  for (const [fid, vid] of venueFields) fieldsOf.set(vid, [...(fieldsOf.get(vid) ?? []), fid]);
  const want = [...new Set(rows.flatMap((r) => fieldsOf.get(r.venueId) ?? []))];
  const pos = new Map<number, { title: string; lat: number; lng: number; last: string }>();
  for (const fid of want) {
    const { data } = await sb.from("mdapi_matches").select("start_date,field_title,lat:raw->field->lat,lng:raw->field->lng,del:raw->field->deletedAt")
      .eq("field_id", fid).is("deleted_at", null).order("start_date", { ascending: false }).limit(1);
    const m = data?.[0] as { start_date: string; field_title: string | null; lat: unknown; lng: unknown; del: unknown } | undefined;
    if (!m || m.del || typeof m.lat !== "number" || typeof m.lng !== "number" || !Number.isFinite(m.lat) || !Number.isFinite(m.lng) || (m.lat === 0 && m.lng === 0)) continue;
    pos.set(fid, { title: m.field_title ?? `Field ${fid}`, lat: m.lat, lng: m.lng, last: m.start_date });
  }
  return rows.map(({ s, id, venueId, status, cap }) => {
    const v = venueById.get(venueId);
    const best = (fieldsOf.get(venueId) ?? []).filter((f) => pos.has(f)).sort((a, b) => pos.get(b)!.last.localeCompare(pos.get(a)!.last))[0];
    const f = best != null ? pos.get(best)! : null;
    return {
      supplyId: id, source: cap.source as "plei" | "goodrec", cityLabel: cap.city_label, facility: String(s.facility),
      spots: Number(s.bookable_spots_per_week) || 0,
      lowCents: s.price_low_cents == null ? null : Number(s.price_low_cents),
      highCents: s.price_high_cents == null ? null : Number(s.price_high_cents),
      formats: sortFormats((s.formats as string[]) ?? []),
      firstCapturedAt: cap.captured_at ?? null,
      status, ourVenueId: venueId, ourVenueName: v?.venue_name ?? `Venue ${venueId}`, ourCity: v?.city ?? null,
      field: f && best != null ? { id: best, title: f.title, lat: f.lat, lng: f.lng } : null,
    };
  }).sort((a, b) => a.cityLabel.localeCompare(b.cityLabel) || a.ourVenueName.localeCompare(b.ourVenueName));
}
