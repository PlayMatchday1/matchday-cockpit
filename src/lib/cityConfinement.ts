// ── THE CITY BOUNDARY ──────────────────────────────────────────────────────────────────────────
//
// ONE PLACE. The city-manager predicate is written twice — adminAuth.ts:46 and capabilities.ts:64
// — and two copies of a gate is how they drift. This one lives here and is imported by both, by
// every route that enforces it, and by the rail that draws the courtesy version of it.
//
// A BOUNDARY, NOT A ROLE — AND THAT IS WHY is_admin DOES NOT WIN HERE.
//
//   is_city_manager  is a ROLE. An admin who somehow also carries it is still an admin, because
//                    the role describes what they DO. So is_admin wins (adminAuth.ts:43-45).
//   a CITY_IDENTIFIER is a BOUNDARY. It describes what an account may SEE. An admin flag inside a
//                    boundary does not widen it — it would erase it.
//
// The two rules therefore disagree ON PURPOSE. Do not "fix" the inconsistency: making is_admin win
// here turns a confined account into an unconfined one the moment anybody ticks a box, which is
// the whole failure this column exists to prevent.
//
// THE COLUMN IS app_users.city_identifier — the one the User access screen's city select already
// writes, and the one cityManagerGate already scopes on. There is no second "which city" column:
// 0131 added one, 0132 dropped it. Proven safe against production first — no account carried a
// city_identifier without is_city_manager, so redefining "has a city" as "is confined to it"
// changed nobody.
//
// is_city_manager REMAINS INDEPENDENT. It decides membership of the city-manager ledger and the
// pay pages; it does NOT decide confinement. A city and no city-manager box is exactly the Warsaw
// shape: scoped everywhere, and absent from that ledger.
//
// NULL MEANS UNCONFINED.

import { resolveCityScope, cityNameFor } from "./cityScope";

/** The shape both auth layers already carry. */
export type ConfinableRow = { city_identifier?: unknown; is_admin?: unknown };

/**
 * The city this account is confined to, or null if it is not confined.
 *
 * VALIDATED AGAINST THE ALLOWLIST, not returned raw. city_identifier is free text (0120 put no
 * CHECK on it, deliberately), and a typo like "waw" or "WAW " would compare equal to
 * nothing and scope the account to an empty page that looks exactly like a working one. An
 * unrecognised value is therefore NOT "unconfined" — see isConfined below.
 */
export function confinedCity(row: ConfinableRow | null | undefined): string | null {
  if (!row) return null;
  const raw = typeof row.city_identifier === "string" ? row.city_identifier : "";
  if (!raw) return null;
  return resolveCityScope(raw)?.identifier ?? null;
}

/**
 * Is this account confined at all?
 *
 * TRUE FOR AN UNRECOGNISED VALUE TOO. If the column holds something the allowlist does not know,
 * the account is confined to a city that cannot be resolved — the safe reading is "confined and
 * showing nothing", never "unconfined and showing everything". confinedCity() returns null there,
 * so every scoped query filters on a city that matches no row.
 */
export function isConfined(row: ConfinableRow | null | undefined): boolean {
  if (!row) return false;
  const raw = typeof row.city_identifier === "string" ? row.city_identifier.trim() : "";
  return raw.length > 0;
}

/** The display name for the confined city — "Warsaw" for WAW. */
export function confinedCityName(row: ConfinableRow | null | undefined): string | null {
  const id = confinedCity(row);
  return id ? cityNameFor(id) : null;
}

/**
 * THE SIX PAGES, and nothing else. Keyed on the capability each page gates on today, so this list
 * cannot drift from the permission model: matchops covers Gameday Ops, Player Lookup, Promo Codes
 * and Reviews; chats covers Match Chats and Player Chats.
 */
export const CONFINED_CAPABILITIES: ReadonlySet<string> = new Set(["matchops", "chats"]);

/** The rail's six, by their MATCH_OPS_SECTIONS keys. The rail is a courtesy; the server decides. */
export const CONFINED_RAIL_KEYS: readonly string[] = [
  "gameday", "player-lookup", "promos", "reviews", "match-chats", "player-chats",
  /* SEVENTH, AND THE FIRST WRITE SURFACE A CONFINED ACCOUNT HAS. Everything above it is read-only;
   * Master Schedule carries Copy match and the inline editor so a new market can build its own
   * schedule. The write boundary is NOT this list — it is assertMatchInScope on the editor's save
   * and the fieldId check on create (099147a). This only decides what appears in the rail. */
  /* "master", NOT "master-schedule". These are MATCH_OPS_SECTIONS keys, and that section's key is
   * "master" while its href is /match-ops/master-schedule. The href spelling was written here and
   * never matched, so Master Schedule has been filtered out of every confined rail since the day
   * it was added — six items rendered, not seven. verify-confined-rail now asserts every entry in
   * this list resolves to a real section key, which is what would have caught it. */
  "master",
];

export const CONFINED_ERROR =
  "This account is confined to one city. That page is outside it.";

export const CONFINED_CITY_ERROR =
  "That resource is not in your city.";

/**
 * THE PER-REQUEST REFUSAL. Call it with whatever city the request NAMES — a ?city= param, a
 * match's city_identifier, a path segment — before doing anything with it.
 *
 * HIDING A CONTROL DOES NOT STOP A REQUEST. A confined account can type another city's id into a
 * URL as easily as anyone; this is what turns that into a 403 instead of another city's data.
 * Comparison is exact against the resolved identifier, so a request naming "waw" is refused
 * rather than quietly accepted.
 */
export function assertConfinedScope(
  row: ConfinableRow | null | undefined,
  requested: string | null | undefined,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!isConfined(row)) return { ok: true };
  return assertScope(confinedCity(row), requested, true);
}

/**
 * THE SAME REFUSAL, for callers that already hold the RESOLVED scope rather than the row — the
 * Match Ops and capability gates both hand one out, and re-deriving it from a shimmed row object
 * at each call site is how a check ends up reading a field nobody sets.
 *
 * `confined` says whether the caller is bounded at all: a null scope means "unconfined" for an
 * ordinary account and "confined to something unresolvable" for a bounded one, and those two must
 * not collapse into the same answer.
 */
export function assertScope(
  scope: string | null,
  requested: string | null | undefined,
  confined = true,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!confined) return { ok: true };
  // Confined to a value the allowlist does not know: refuse everything that names a city.
  if (!scope) return { ok: false, status: 403, error: CONFINED_ERROR };
  // Nothing named => the account's own scope applies and the query filters on it.
  if (requested === null || requested === undefined || requested === "") return { ok: true };
  if (String(requested).trim() !== scope) {
    return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  }
  return { ok: true };
}


/**
 * WHAT THIS ACCOUNT ACTUALLY GETS, in one sentence, for the User access screen.
 *
 * THE SAME CONTROL PRODUCES TWO DIFFERENT RESULTS. A city plus the City Manager box scopes someone
 * to the /city/* pages; a city WITHOUT it scopes them to the Match Ops six. Describing both as
 * "six Match Ops pages" would tell four of the five existing city managers something false about
 * their own account.
 *
 * THE COUNT IS PASSED IN, NEVER WRITTEN DOWN. Callers hand it the length of the list the RAIL is
 * built from — CONFINED_RAIL_KEYS here, CITY_SECTIONS there — so the sentence cannot drift from
 * the behaviour. Writing "six" as a literal would be wrong the first time somebody adds a seventh
 * page, and wrong silently.
 */
export function confinementSummary(input: {
  cityName: string;
  isCityManager: boolean;
  pageCount: number;
}): string {
  const { cityName, isCityManager, pageCount } = input;
  return isCityManager
    ? `Confined to ${cityName} — ${pageCount} city manager ${pageCount === 1 ? "page" : "pages"} only`
    : `Confined to ${cityName} — ${pageCount} Match Ops ${pageCount === 1 ? "page" : "pages"} only`;
}


/**
 * THE ROUTES THE SIX PAGES ACTUALLY CALL — and a confined account may reach NOTHING ELSE.
 *
 * WHY THIS EXISTS. The six pages gate on can_access_matchops and can_access_chats, and a confined
 * account holds both. But those two capabilities also gate SEVENTEEN routes that belong to pages
 * outside the six — /community/* (chat automation), /manager-pay/* (the city-manager ledger this
 * account is explicitly meant never to touch), /partner-dashboards/*, /veo/codes/*, /inventory/*,
 * /match-promotion, /slate-notes, and /admin/users/permissions. Every one of those PAGES bounces
 * at the rail or an AdminGuard, and every one of those ROUTES would have answered.
 *
 * That is the failure this codebase has shipped twice and named as non-negotiable: a rail that
 * hides an item the server still serves. Hiding a page is not refusing a request.
 *
 * DENY BY DEFAULT. This is an ALLOWLIST of prefixes, not a blocklist of known-bad ones — a route
 * added tomorrow is refused until somebody puts it here on purpose, which is the only direction
 * that fails safe.
 */
export const CONFINED_ROUTE_PREFIXES: readonly string[] = [
  // Gameday Ops — the board, a match, its roster, its check-ins.
  "/api/matchday/",
  "/api/matchops/checkin/",
  // Player Lookup — search, profile, the two panels, and the registered list.
  "/api/lookup/",
  "/api/players/registered",
  // Player Finder — the same page, the same mirror, the same scope check. A confined account
  // reaches it and sees only its own city; the city SELECT is a convenience and this list plus
  // assertScope() is the boundary.
  "/api/players/finder",
  // Promo Codes — reads only; every write route gates on managePromos, which this account lacks.
  "/api/promos/list",
  "/api/promos/detail/",
  "/api/promos/check",
  "/api/promos/fields",
  "/api/promos/matches",
  // Reviews.
  "/api/reviews",
  // Match Chats and Player Chats.
  "/api/match-chats/",
  "/api/crm/",
];

/* ── EXACT ROUTES, NOT SUBTREES ───────────────────────────────────────────────────────────────
 * Master Schedule's week — and ONLY that path.
 *
 * IT IS HERE RATHER THAN IN THE PREFIX LIST BECAUSE A PREFIX WOULD HAVE OPENED /api/veo/codes,
 * the camera-code admin surface that city-confinement-test explicitly refuses. Adding "/api/veo"
 * above turned that assertion red, which is the allowlist behaving exactly as 099147a describes:
 * a blanket prefix exposes everything beneath it, and the only thing that caught this was a test
 * someone had already written naming the route that must stay shut.
 *
 * The week route is safe to open only because fetchVeoWeek is scoped to the caller's confined city
 * in the same commit. /api/veo/cameras, /api/veo/codes, /api/veo/intent and /api/veo/inbound stay
 * refused — a confined account reads its week and changes no fleet configuration. */
const CONFINED_ROUTE_EXACT: readonly string[] = [
  "/api/veo",
  /* THE DOOR TO THE CHATS PAGE, and it was shut while every room behind it was open.
   *
   * /api/match-chats/ is on the prefix list, so a confined account's chat LIST rendered perfectly —
   * two active, one upcoming, two past, all Warsaw. The message pane then failed, because opening a
   * thread needs a Firebase custom token and THIS route was on no list. The refusal reads "This
   * account is confined to one city. That page is outside it.", which sent everyone looking for a
   * city that did not resolve. Nothing about the city was wrong: city_identifier is "WAW" on both
   * accounts, the list resolved it, and this guard never compares a city at all — it compares a
   * PATHNAME against this allowlist.
   *
   * EXACT, NOT A PREFIX, for the reason the Veo entry above records: "/api/firebase" as a prefix
   * would open anything added beneath it later. */
  "/api/firebase-token",
  /* MATCH MANAGERS — the collapsible roster under Player Finder, on the SAME PAGE a confined
   * account already reaches. Adding it here is the whole lesson of the firebase-token entry above:
   * the page opened, the panel rendered, and one route it calls was on no list. The route scopes
   * the roster to the caller's confined city in the same commit, and a confined account naming
   * another city is refused by assertScope rather than quietly re-pointed.
   *
   * EXACT, NOT A PREFIX. There is nothing beneath this path today, and a prefix is a promise about
   * routes that do not exist yet. */
  "/api/match-managers",
];

/**
 * Is this path one of the confined pages' routes?
 *
 * The pathname is taken from the REQUEST, so it cannot be spoofed by a body or a header, and the
 * comparison is a plain prefix match on an allowlist — no regex to get subtly wrong.
 */
export function isConfinedRouteAllowed(pathname: string): boolean {
  const p = (pathname || "").split("?")[0];
  if (CONFINED_ROUTE_EXACT.includes(p)) return true;
  return CONFINED_ROUTE_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

/** The refusal for a route outside the six, with the path named so a 403 is debuggable. */
export function assertConfinedRoute(
  row: ConfinableRow | null | undefined,
  reqUrl: string,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!isConfined(row)) return { ok: true };
  let pathname = reqUrl;
  try { pathname = new URL(reqUrl).pathname; } catch { /* already a path */ }
  if (isConfinedRouteAllowed(pathname)) return { ok: true };
  return { ok: false, status: 403, error: CONFINED_ERROR };
}

/* ── THE CITY BOUNDARY ON A PLAYER-GRAIN ROUTE ─────────────────────────────────────────────────
 * A confined account may read and adjust credits ONLY for players whose stated city is its own.
 * The city comes from app_users.city_identifier via the session — never from the request.
 *
 * WHY preferable_city_name AND NOT A ROSTER TEST. There is no player-in-city definition to build
 * one from: GET /admin/players rejects every city parameter, and a roster-based test breaks on real
 * people — someone who plays in Warsaw but prefers Austin, someone who prefers Warsaw and has never
 * played. A stated preference is the only field that exists, and in a NEW market there is no legacy
 * overlap for it to be wrong about.
 *
 * IT IS PLAYER-EDITABLE, KNOWINGLY. A player can change their own preferable city, so this bounds
 * WHO AN OPERATOR MAY ACT ON, not who may enter the set. A player switching to Warsaw does not
 * credit themselves — it puts them in a list an operator still has to act on. The operator is the
 * control. Revisit if a confined market ever stops being new.
 *
 * NULL IS A REFUSAL. 4,187 players have no preferred city and none of them belong to anybody.
 * Deny by default: an unreadable player, a missing city, or any mismatch is a 403 by id. */
export function playerCityAllowed(confinedCity: string | null, player: Record<string, unknown>): boolean {
  if (!confinedCity) return true; // unconfined accounts are unaffected
  const pc = player.preferableCity as Record<string, unknown> | null | undefined;
  if (!pc) return false;
  // `abbr` IS the same identifier app_users stores ("WAW"), so the common path needs no name
  // mapping at all. The name is a fallback for a payload that omits abbr, never the primary test.
  const abbr = typeof pc.abbr === "string" ? pc.abbr.trim() : "";
  if (abbr) return abbr === confinedCity;
  const name = typeof pc.name === "string" ? pc.name.trim() : "";
  const want = cityNameFor(confinedCity);
  return !!name && !!want && name === want;
}
