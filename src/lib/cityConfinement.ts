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
  const scope = confinedCity(row);
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
