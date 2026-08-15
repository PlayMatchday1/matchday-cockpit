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
    isCancelled: !!m.isCancelled, autoCanceledMinutes: num(m.autoCanceledMinutes) ?? 0,
    // THE AUTO-CANCEL SWITCH ITSELF. Without it the board could only see the MINUTES field and so
    // drew a decide-by countdown for every match that had one, whether or not the match can
    // actually auto-cancel. A deadline that will never fire is a fiction the row was telling.
    autoCanceled: m.autoCanceled === true,
    minPlayerCount: num(m.minPlayerCount) ?? 0, maxPlayerCount: num(m.maxPlayerCount),
    registrationPrice: num(m.registrationPrice), additionalSpotPrice: num(m.additionalSpotPrice),
    fakeSpotLeft36h: num(m.fakeSpotLeft36h) ?? 0, fakeSpotLeft24h: num(m.fakeSpotLeft24h) ?? 0,
    fakeSpotLeft12h: num(m.fakeSpotLeft12h) ?? 0, fakeSpotLeft6h: num(m.fakeSpotLeft6h) ?? 0,
    fakeSpotLeft3h: num(m.fakeSpotLeft3h) ?? 0,
    isAutoBump: !!m.isAutoBump, category: (m.category as string) ?? null, type: (m.type as string) ?? null,
    _count: { players: m._count?.players ?? 0, fakePlayers: m._count?.fakePlayers ?? 0 },
    field: { title: ((field.title as string | undefined) ?? "").trim() || null,
      city: { id: (city.id as number) ?? null, name: (city.name as string) ?? null,
        timeZone: { abbr: ((tz.abbr as string | undefined) ?? "").trim() || null, name: (tz.name as string) ?? null } } },
    manager: mgr ? { firstName: (mgr.firstName as string) ?? "", lastName: (mgr.lastName as string) ?? "" } : null,
    teams: Array.isArray(m.teams) ? m.teams.map((t) => ({ teamNumber: (t.teamNumber as number) ?? null })) : [],
  };
}

export type TrimmedMatch = ReturnType<typeof trimMatch>;

// THE CITY OF A ROW, as the live API reports it. Probed on production 2026-08-15/16: field.city.name
// carries exactly the names CITY_SCOPES pins — "Austin", "San Antonio", "Dallas / Fort Worth",
// "Houston", "Atlanta", "Oklahoma City" — so a city_identifier maps to ONE api city name and the
// comparison below is an equality, not a fuzzy match. scripts/city-scope-test.ts pins the pairs, so
// a rename upstream fails a test instead of silently unscoping somebody.
export function apiCityNameOf(m: TrimmedMatch): string | null {
  return m.field?.city?.name ?? null;
}
