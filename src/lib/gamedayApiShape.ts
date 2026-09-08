// THE GAMEDAY BOARD PAYLOAD — one shape, one trim, two routes.
//
// Both /api/matchday/{env}/gameday (admin, every city) and /api/city/gameday (city manager, one
// city) feed the SAME component, so they must return the same rows. This module is the reason they
// cannot drift: a field added for the admin board that the city route forgot would render as a
// blank rail or a missing countdown for a city manager only — a bug that shows up on one account
// and nowhere in the admin's own testing.
//
// Only the fields the board needs. No player arrays, no manager email/phone — a name is all a
// triage tile shows, and the roster is a route this tier must not reach at all.

export type RawCount = { players?: number; fakePlayers?: number };
export type Raw = Record<string, unknown> & {
  _count?: RawCount;
  field?: Record<string, unknown>;
  manager?: Record<string, unknown> | null;
  teams?: Record<string, unknown>[];
};

export function trimMatch(m: Raw) {
  const field = (m.field ?? {}) as Record<string, unknown>;
  const city = (field.city ?? {}) as Record<string, unknown>;
  const tz = (city.timeZone ?? {}) as Record<string, unknown>;
  const mgr = m.manager as Record<string, unknown> | null;
  const num = (v: unknown) => (typeof v === "number" ? v : v == null ? null : Number(v));
  return {
    id: m.id as number, name: (m.name as string) ?? "",
    startDate: m.startDate as string, startDateUtc: m.startDateUtc as string,
    /* THE END INSTANT, for "how long since the whistle". TRUE UTC, like startDateUtc — endDate
     * carries a Z it does not mean and must never be parsed. Needed because a row only reaches the
     * finished band 90 minutes PAST KICKOFF, so an age measured from kickoff can never read less
     * than 90 minutes and the "just whistled, nothing in yet" state would be unreachable. */
    endDateUtc: (m.endDateUtc as string) ?? null,
    isCancelled: !!m.isCancelled, autoCanceledMinutes: num(m.autoCanceledMinutes) ?? 0,
    // THE AUTO-CANCEL SWITCH ITSELF. Without it the board could only see the MINUTES field and so
    // drew a decide-by countdown for every match that had one, whether or not the match can
    // actually auto-cancel. A deadline that will never fire is a fiction the row was telling.
    autoCanceled: m.autoCanceled === true,
    minPlayerCount: num(m.minPlayerCount) ?? 0, maxPlayerCount: num(m.maxPlayerCount),
    /* MAX SPOTS AT EACH SHAPE, and like the rating these cost nothing: both are ALREADY on the
     * /admin/matches LIST rows this route pages through — measured on production for 2026-09-07,
     * all 19 rows carried maxTeamSize2Team and maxTeamSize4Team. They were simply not passed on.
     * No second read, no extra latency.
     * THEY ARE TOTALS, NOT PER SIDE — proven on 17522, see checkinModel.ts:51. maxPlayerCount is
     * capacity NOW (the bookable cap) and it moves; these do not. See maxSpots() in gamedayModel. */
    maxTeamSize2Team: num(m.maxTeamSize2Team), maxTeamSize4Team: num(m.maxTeamSize4Team),
    /* THE FIELD ID, so the route can join to the venue's own max_players. It is on the same list
     * rows as everything else here and was simply not passed through — the payload kept
     * field.title and field.city and dropped the id that identifies the pitch. */
    fieldId: num(m.fieldId),
    registrationPrice: num(m.registrationPrice), additionalSpotPrice: num(m.additionalSpotPrice),
    fakeSpotLeft36h: num(m.fakeSpotLeft36h) ?? 0, fakeSpotLeft24h: num(m.fakeSpotLeft24h) ?? 0,
    fakeSpotLeft12h: num(m.fakeSpotLeft12h) ?? 0, fakeSpotLeft6h: num(m.fakeSpotLeft6h) ?? 0,
    fakeSpotLeft3h: num(m.fakeSpotLeft3h) ?? 0,
    isAutoBump: !!m.isAutoBump, category: (m.category as string) ?? null, type: (m.type as string) ?? null,
    /* THE RATING, AND IT COSTS NOTHING. `starRating` and `starRatingCount` are ALREADY on the
     * /admin/matches LIST rows this route pages through — measured on production 2026-09-02, all
     * 22 rows for a past day carried both. They were simply not being passed through. The board
     * therefore needs NO second read: no extra request, no extra latency on refresh.
     *
     * starRating is 0 (not null) when nothing has been left, so COUNT is the field that says
     * whether a rating exists. Never test the average for zero — a genuine 0.00 would vanish. */
    starRating: num(m.starRating) ?? 0, starRatingCount: num(m.starRatingCount) ?? 0,
    _count: { players: m._count?.players ?? 0, fakePlayers: m._count?.fakePlayers ?? 0 },
    field: { title: ((field.title as string | undefined) ?? "").trim() || null,
      city: { id: (city.id as number) ?? null, name: (city.name as string) ?? null,
        timeZone: { abbr: ((tz.abbr as string | undefined) ?? "").trim() || null, name: (tz.name as string) ?? null } } },
    manager: mgr ? { firstName: (mgr.firstName as string) ?? "", lastName: (mgr.lastName as string) ?? "" } : null,
    teams: Array.isArray(m.teams) ? m.teams.map((t) => ({ teamNumber: (t.teamNumber as number) ?? null })) : [],
  };
}

export type TrimmedMatch = ReturnType<typeof trimMatch>;

/* ── THE FIELD'S OWN CAPACITY, JOINED ONCE PER REQUEST ─────────────────────────────────────────
 * match.field_id -> fin_venue_fields.mdapi_field_id -> fin_venues.max_players. That is the path
 * /api/schedule-master/discrepancies already walks and calls the source of truth for field-to-venue
 * mapping (seeded in 0041); this follows it rather than inventing a second mapping.
 *
 * ONE QUERY PER REQUEST, NOT PER MATCH. Two small selects build a Map once, and every match is an
 * index lookup. A per-match read would be up to 132 round trips on a week view.
 *
 * IT IS ATTACHED AFTER THE CITY SCOPE, NEVER BEFORE. The scope decides which matches exist; this
 * only decorates the ones that survived it, so a Supabase read entering a route that had none
 * cannot widen what an operator sees. Both callers apply it last, and that is asserted.
 *
 * A FAILED READ IS NOT A FAILED REQUEST. If either select errors the map is empty, every match
 * falls through to maxSpots() and then maxPlayerCount, and the board renders with a slightly
 * coarser denominator instead of a 500. */
export async function fetchVenueMaxPlayers(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from: (t: string) => any },
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const [links, venues] = await Promise.all([
      supabase.from("fin_venue_fields").select("fin_venue_id, mdapi_field_id"),
      supabase.from("fin_venues").select("id, max_players"),
    ]);
    if (links.error || venues.error || !links.data || !venues.data) return out;
    const maxByVenue = new Map<number, number>();
    for (const v of venues.data as { id: number; max_players: number | null }[]) {
      if (v.max_players != null && Number(v.max_players) > 0) maxByVenue.set(v.id, Number(v.max_players));
    }
    for (const l of links.data as { fin_venue_id: number; mdapi_field_id: number | null }[]) {
      const n = maxByVenue.get(l.fin_venue_id);
      if (n != null && l.mdapi_field_id != null) out.set(Number(l.mdapi_field_id), n);
    }
  } catch { /* see above: a coarser denominator beats a 500 */ }
  return out;
}

/** Decorate trimmed matches with their field's max_players. Pure; call it AFTER the city scope. */
export function withVenueMaxPlayers<T extends { fieldId: number | null }>(
  matches: T[], byField: Map<number, number>,
): (T & { venueMaxPlayers: number | null })[] {
  return matches.map((m) => ({ ...m, venueMaxPlayers: m.fieldId != null ? byField.get(m.fieldId) ?? null : null }));
}

// THE CITY OF A ROW, as the live API reports it. Probed on production 2026-08-15/16: field.city.name
// carries exactly the names CITY_SCOPES pins — "Austin", "San Antonio", "Dallas / Fort Worth",
// "Houston", "Atlanta", "Oklahoma City" — so a city_identifier maps to ONE api city name and the
// comparison below is an equality, not a fuzzy match. scripts/city-scope-test.ts pins the pairs, so
// a rename upstream fails a test instead of silently unscoping somebody.
export function apiCityNameOf(m: TrimmedMatch): string | null {
  return m.field?.city?.name ?? null;
}
