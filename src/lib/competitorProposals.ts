// "LOOKS LIKE OURS" — the Competitors page's name-match proposals, SERVER-ONLY, Supabase only.
// Moved here unchanged from /api/growth/competitors so the Locations map skips exactly the
// facilities the Competitors page flags (Ryan, 2026-10-09).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proposeLink, type NameCandidate } from "./competitorSupply";

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
  return supply.map((s) => {
    const cap = capById.get(Number(s.capture_id));
    const ourCity = cap ? CITY_LABEL_TO_OURS[cap.city_label] : null;
    const cands: NameCandidate[] = [];
    for (const v of venues) {
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
