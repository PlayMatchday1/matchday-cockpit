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

/* ── REMOVAL: THERE IS NO ENDPOINT ─────────────────────────────────────────────────────────────
 * Probed against production and read out of the Retool export: the /city-managers family exposes
 * GET /city-managers and GET /city-managers/users and NOTHING ELSE. Retool's entire cityManagers
 * group is reads plus attachCityManagerToMatch, which is a PUT on a MATCH — it attaches an existing
 * manager to one fixture; it does not add or remove anyone from a city's roster.
 *
 * So the control is DISABLED and says why. A button that looks live and does nothing is the thing
 * we do not ship, and match-managers-test asserts this constant is false so that enabling the
 * control without an endpoint fails the gate loudly. */
export const CAN_REMOVE_MATCH_MANAGER = false;
export const CAN_ADD_MATCH_MANAGER = false;
export const NO_MUTATION_REASON =
  "The MatchDay API exposes no endpoint to add or remove a match manager — only to attach an " +
  "existing one to a match. Changes have to be made in the MatchDay app.";
