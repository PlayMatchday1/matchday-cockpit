// MATCH MANAGERS — the pure model. No network, no clock, no Supabase.
//
// ── THE NAME IS THE WHOLE PROBLEM, SO IT IS SETTLED HERE ───────────────────────────────────────
// In Clubhouse these people are MATCH MANAGERS. The word "city manager" appears in this codebase
// for TWO OTHER, UNRELATED THINGS, and conflating any of the three is how the next permissions bug
// gets written:
//
//   1. app_users.is_city_manager — a CLUBHOUSE LOGIN with city confinement. 5 rows. This is the
//      thing that broke twice this month.
//   2. the `city_managers` TABLE — one named contact per city with a phone number. 6 rows. A
//      directory, not a permission and not a roster.
//   3. the MatchDay API's /city-managers — THESE people: 87 of them, 107 city assignments, the
//      ones who run matches and are paid through Manager Pay.
//
// Measured overlap between (1) and (3): 6 of 87 match managers hold an app_users row at all, and
// only 3 of those carry is_city_manager. They are different populations that happen to share a
// noun. Nothing in this module, its route, or its component uses "city manager" for (3) except the
// one banner that explains the API's own naming.

/** One row of GET /city-managers — a PERSON-IN-A-CITY, not a person. */
export type ApiAssignment = {
  id: number;
  userId: number;
  cityId: number;
  user?: {
    id?: number; email?: string | null; firstName?: string | null; lastName?: string | null;
    phoneNumber?: string | null;
  } | null;
  city?: { id?: number; name?: string | null; abbr?: string | null } | null;
};

export type MatchManager = {
  userId: number;
  name: string;
  email: string | null;
  /** True when the address is an Apple private relay token — see relayDisplay. */
  relay: boolean;
  phone: string | null;
  cities: { cityId: number; label: string }[];
  matchesRun: number;
  lastMatch: string | null;   // YYYY-MM-DD
};

/* ── APPLE PRIVATE RELAY ───────────────────────────────────────────────────────────────────────
 * A meaningful share of these people sign in with @privaterelay.appleid.com — a random token and
 * no name. Rendering it as an address is worse than useless: it reads as corrupt data, and it is
 * not something anyone can search for or write to. So it is LABELLED, and the ID and phone carry
 * the identity instead. Measured: 14 of 87. */
export const RELAY_DOMAIN = "privaterelay.appleid.com";
export const isRelayEmail = (email: string | null | undefined): boolean =>
  /@privaterelay\.appleid\.com$/i.test(String(email ?? "").trim());

/** What the email column shows. Never a relay token, and never blank without saying why. */
export function emailDisplay(m: Pick<MatchManager, "email" | "relay" | "userId">): string {
  if (m.relay) return `Apple private relay · ID ${m.userId}`;
  const e = String(m.email ?? "").trim();
  return e || `No email on file · ID ${m.userId}`;
}

/** Is this address one an operator could actually search or write to? */
export const isFindableEmail = (email: string | null | undefined): boolean => {
  const e = String(email ?? "").trim();
  return e.length > 0 && e.includes("@") && !isRelayEmail(e);
};

/* ── ONE ROW PER PERSON ────────────────────────────────────────────────────────────────────────
 * The API returns 107 rows and Retool shows 107 rows, because a row is a person-in-a-city:
 * zelfine.nick is Austin AND Houston AND six more. A table of assignments cannot answer "who are
 * our match managers", which is the question this page exists for. So the rows are folded into
 * PEOPLE and the cities become chips.
 *
 * BOTH COUNTS STAY VISIBLE. The header says "87 people · 107 city assignments" so Retool's number
 * still reconciles, and the footer says why they differ — city chips sum to 107 while All reads
 * 87, which looks like a bug in any page that does not say it isn't. */
export function foldToPeople(
  rows: readonly ApiAssignment[],
  runs?: Map<number, { matchesRun: number; lastMatch: string | null }>,
): MatchManager[] {
  const by = new Map<number, MatchManager>();
  for (const r of rows) {
    const u = r.user ?? {};
    const cur = by.get(r.userId) ?? {
      userId: r.userId,
      name: [u.firstName, u.lastName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || `ID ${r.userId}`,
      email: u.email ?? null,
      relay: isRelayEmail(u.email),
      phone: u.phoneNumber ?? null,
      cities: [],
      matchesRun: runs?.get(r.userId)?.matchesRun ?? 0,
      lastMatch: runs?.get(r.userId)?.lastMatch ?? null,
    };
    // ONE CHIP PER CITY, never a duplicate — the same person twice in a city would double the chip
    // count and break the reconciliation the footer promises.
    if (!cur.cities.some((c) => c.cityId === r.cityId)) {
      cur.cities.push({ cityId: r.cityId, label: r.city?.abbr || r.city?.name || String(r.cityId) });
    }
    by.set(r.userId, cur);
  }
  const out = [...by.values()];
  for (const p of out) p.cities.sort((a, b) => a.label.localeCompare(b.label));
  // Busiest first — the people who actually run matches are the ones anyone is looking for.
  out.sort((a, b) => b.matchesRun - a.matchesRun || a.name.localeCompare(b.name));
  return out;
}

export type Counts = { people: number; assignments: number; byCity: { label: string; n: number }[] };

export function counts(people: readonly MatchManager[]): Counts {
  const byCity = new Map<string, number>();
  let assignments = 0;
  for (const p of people) for (const c of p.cities) { assignments++; byCity.set(c.label, (byCity.get(c.label) ?? 0) + 1); }
  return {
    people: people.length,
    assignments,
    byCity: [...byCity].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)),
  };
}

/** Never run a match. The tile the mockup puts beside the counts. */
export const neverRan = (people: readonly MatchManager[]): number =>
  people.filter((p) => p.matchesRun === 0).length;

export function filterPeople(people: readonly MatchManager[], q: string, city: string | null): MatchManager[] {
  const t = q.trim().toLowerCase();
  return people.filter((p) => {
    if (city && !p.cities.some((c) => c.label === city)) return false;
    if (!t) return true;
    // The relay label is searchable by ID, because the ID is the only handle those people have.
    return [p.name, p.email ?? "", p.phone ?? "", String(p.userId)].join(" ").toLowerCase().includes(t);
  });
}

/* ── ADD AND REMOVE: THE ENDPOINTS EXIST, AND CLUBHOUSE NOW USES THEM ─────────────────────────
 *
 * An earlier version of this file recorded "the /city-managers family exposes GET and NOTHING
 * ELSE", on the strength of grepping the Retool export for `createCityManager` and
 * `deleteCityManager` — NAMES I INVENTED. Retool's queries are called exactly that, so the grep
 * should have hit; it did not, because I searched for a guessed name instead of tracing the
 * control. Following addCityManagerBtn's own click handler found it in one step.
 *
 * READ THE BUTTON, NOT A NAME YOU EXPECT TO FIND. An absence proved by grep is not an absence.
 *
 * Both proven on staging, each verified by reading the list back: POST took /city-managers from 19
 * rows to 20 with the row present, DELETE took it back to 19 with the row gone, state restored. */
export const ADD_MATCH_MANAGER_ENDPOINT = "POST /city-managers {userId, cityId}";
export const REMOVE_MATCH_MANAGER_ENDPOINT = "DELETE /city-managers?userId=&cityId=";
export const ENDPOINTS_PROOF =
  "Traced from Retool's addCityManagerBtn / deleteCityManagerBtn click handlers, then proven on " +
  "staging: POST took /city-managers from 19 rows to 20 and DELETE took it back to 19, each " +
  "verified by reading the list back.";

export const CAN_ADD_MATCH_MANAGER = true;
export const CAN_REMOVE_MATCH_MANAGER = true;

/* ── THE CITY IS RESOLVED BY ID, FROM GET /cities, NEVER BY NAME ───────────────────────────────
 * The API's /cities has TEN cities — ATX HOU SATX ATL STL NYC DFW OKC ELP WAW — against the seven
 * markets the finance estate knows and the eight in CITY_SCOPES. NYC and ELP exist in the API and
 * nowhere else here, so any mapping written from our own list would silently lose them, and any
 * mapping written from a name would break the first time a city is renamed upstream. The numeric
 * id from that endpoint is the only key. */
export type ApiCity = { id: number; name?: string | null; abbr?: string | null };

export const cityLabel = (c: ApiCity): string => c.abbr || c.name || String(c.id);

/** The confinement key for a city id: the API's OWN abbr, which is what city_identifier holds. */
export function scopeOfCityId(cities: readonly ApiCity[], cityId: number): string | null {
  const c = cities.find((x) => Number(x.id) === Number(cityId));
  return c ? (c.abbr || c.name || null) : null;
}

/* ── THE WRITE BODIES. THE DIFF IS THE REQUEST BODY. ──────────────────────────────────────────
 * Add sends the two fields the API takes and nothing else. Remove sends NO BODY at all — the pair
 * is in the query string, which is the shape Retool uses and the shape proven on staging. */
export function addBody(userId: number, cityId: number): { userId: number; cityId: number } {
  return { userId, cityId };
}
export function removePath(userId: number, cityId: number): string {
  return `/city-managers?userId=${encodeURIComponent(String(userId))}&cityId=${encodeURIComponent(String(cityId))}`;
}

/** A userId/cityId off the wire. Anything that is not a positive integer is not an id. */
export function normalizeId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* ── THE CONFIRMATION, REQUIRED ON BOTH ───────────────────────────────────────────────────────
 * Retool asks NOTHING — requireConfirmation is false on both of its queries, so one stray click
 * puts someone on a roster or takes them off it. Here both name the person, the city and the
 * consequence, because the consequence is pay: a match manager is who Manager Pay pays, and taking
 * someone off a city's roster takes them off the list anyone can be attached from. */
export type RosterConfirm = { name: string; cityLabel: string; matchesRun?: number };

export function addConfirmLines(c: RosterConfirm): string[] {
  return [
    `Put ${c.name} on ${c.cityLabel}'s match-manager roster.`,
    `They become assignable to ${c.cityLabel} matches, and Manager Pay pays them per match they run.`,
    "Sent once. It is never retried.",
  ];
}

export function removeConfirmLines(c: RosterConfirm): string[] {
  const ran = c.matchesRun && c.matchesRun > 0
    ? `Matches they have already run stay on the record and stay paid — ${c.matchesRun.toLocaleString("en-US")} of them.`
    : "They have not run a match in this city.";
  return [
    `Take ${c.name} off ${c.cityLabel}'s match-manager roster.`,
    `They stop being assignable to ${c.cityLabel} matches. ${ran}`,
    "Sent once. It is never retried.",
  ];
}

/* ── THE SEARCH IS PLAYER LOOKUP'S, AND THAT IS THE POINT ──────────────────────────────────────
 * Retool's add modal searches GET /admin/players?email= — EMAIL ONLY. Fourteen of the 87 match
 * managers sign in with an @privaterelay.appleid.com token, so Retool's own add flow cannot find a
 * single one of them. Clubhouse adds from the Player Lookup search already on this page, which
 * takes phone, email, name or ID — and the ID is the handle a relay person actually has. There is
 * NO second search box; rebuilding the email-only one is the thing this feature exists to avoid. */
export const SEARCH_NOTE =
  "Find the player with the search at the top of this page — phone, email, name or ID. " +
  "Retool's add modal searches email only, which cannot find the 14 managers on an Apple relay address.";
