// VENUES, NOT FIELD RECORDS, ON THE LOCATIONS PAGE (Ryan, 2026-10-09) — pure, shared by server and page.
//
// MatchDay keeps several field records at one place (Round Rock Multipurpose Complex, Round Rock
// Tournaments and Stadium Field at Round Rock M.C. are all 2001 N Kenney Fort Blvd). The unit on
// the Locations page is the CANONICAL VENUE: fin_venue_fields (mdapi_field_id -> fin_venue_id,
// mdapi_field_id unique) and fin_venues.venue_name. One pin, one Fields-list row, one "Where they
// play" line per venue.
//
//   UNIT ID   a venue's unit id is MINUS its fin_venue_id (venueUnitId); a field with no venue link
//             keeps its own MatchDay field id and is marked unmapped. Ids never collide: field ids
//             are positive.
//   ACTIVE    a venue is active if ANY of its fields is active (the Map's 60-day rule) — not
//             fin_venues.is_active, which is a finance flag.
//   POSITION  the mean of its fields' positions (they share one today); city = its fields' city.
//
// excluded_from_venue is a FINANCE flag (the field leaves the venue's matches, revenue and cost); the
// field is still at that place, so it still groups with its venue here.

export type VenueLink = { venueId: number; venueName: string };
export const venueUnitId = (venueId: number) => -venueId;
export const isVenueUnit = (unitId: number) => unitId < 0;
export const unitIdOf = (fieldId: number, links: ReadonlyMap<number, VenueLink>) => {
  const l = links.get(fieldId);
  return l ? venueUnitId(l.venueId) : fieldId;
};

export type UnitMember = { id: number; title: string };
export type Unit = {
  id: number; title: string; cityId: number; lat: number; lng: number;
  venueId: number | null;
  /** The MatchDay field records inside it (one, for an unmapped field). */
  fields: UnitMember[];
};

const mode = <T,>(xs: T[]): T => {
  const c = new Map<T, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1])[0][0];
};

/** Field records -> venue units. Order: as the fields came. */
export function groupIntoUnits(fields: { id: number; title: string; cityId: number; lat: number; lng: number }[], links: ReadonlyMap<number, VenueLink>): Unit[] {
  const g = new Map<number, typeof fields>();
  for (const f of fields) { const k = unitIdOf(f.id, links); g.set(k, [...(g.get(k) ?? []), f]); }
  return [...g].map(([id, fs]) => {
    const l = links.get(fs[0].id);
    return {
      id, title: l ? l.venueName : fs[0].title, cityId: mode(fs.map((f) => f.cityId)),
      lat: fs.reduce((s, f) => s + f.lat, 0) / fs.length, lng: fs.reduce((s, f) => s + f.lng, 0) / fs.length,
      venueId: l ? l.venueId : null,
      fields: fs.map((f) => ({ id: f.id, title: f.title })).sort((a, b) => a.title.localeCompare(b.title)),
    };
  });
}
