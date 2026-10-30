// Phase 23 Step 2 Part D — the MATCH-OPS READ gate. Separate from authenticateAdmin ON PURPOSE.
//
// authenticateAdmin requires is_admin before it even computes the can_* flags, so those flags never
// granted access to anyone — they only ever restricted admins. This gate is the one the read flags
// were always meant to power: it requires can_access_matchops (NOT is_admin), so a non-admin who was
// granted Match Ops can READ the match-ops surface. WRITES stay gated — the returned flags
// (canEditMatches / canManagePlayers / canManagePromos) are derived exactly as in adminAuth, and each
// write route still checks its own flag.
//
// DENY BY DEFAULT. This gate is added, and routes are moved onto it ONE AT A TIME, explicitly. A route
// nobody moved keeps requiring is_admin — so a route we overlook stays CLOSED, never accidentally open.

import { type SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUser, deriveMatchOpsFlags, isCityManagerConfined, CITY_MANAGER_CONFINED_ERROR, type AppUserRow } from "./adminAuth";
import { confinedCity, isConfined, assertConfinedRoute, CONFINED_CITY_ERROR } from "./cityConfinement";
import { cityNameFor } from "./cityScope";

export type MatchOpsAuthResult =
  | { ok: true; supabase: SupabaseClient; appUserId: string; email: string; isAdmin: boolean;
      canEditMatches: boolean; canManagePlayers: boolean; canManagePromos: boolean;
      // 0195 — NOT gated on Match Ops; see deriveMatchOpsFlags. Moves money, stands alone.
      canEditMemberships: boolean;
      // THE SCOPE EVERY MATCH-OPS ROUTE MUST PUSH INTO ITS QUERY. null = unconfined, and the route
      // filters on nothing. Non-null = the route MUST add .eq() before fetching — filtering after
      // the fetch leaks through pagination counts, which is the whole reason this is returned by
      // the gate rather than left for each route to look up.
      confinedCity: string | null;
      // IS THE ACCOUNT BOUNDED AT ALL. confinedCity is null BOTH for an unconfined account and for
      // one confined to a value the allowlist cannot resolve, and a route reading confinedCity alone
      // treats the second as the first. The field routes read this pair (fieldScope.Bound) so an
      // unresolvable confinement is in scope for nothing rather than for everything.
      confined: boolean }
  | { ok: false; status: number; error: string };

// The E2E service account is blocked here EXPLICITLY, keyed on EMAIL (not full_name) — belt-and-
// suspenders atop the DB is_service_account trigger. A machine account must never read player data,
// regardless of what flags its row happens to carry.
export const E2E_SERVICE_EMAIL = "clubhouse-e2e@playmatchday.com";

// PURE decision — testable offline for every flag shape (admin, matchops-only, no-flags, service acct).
export function matchOpsReadGate(row: AppUserRow | null, email: string): { ok: true } | { ok: false; status: number; error: string } {
  if (!row) return { ok: false, status: 403, error: "Not a cockpit user" };
  if (email.toLowerCase() === E2E_SERVICE_EMAIL || row.is_service_account === true) {
    return { ok: false, status: 403, error: "Service accounts cannot access Match Ops" };
  }
  // Deny by default: a missing/false flag is a refusal. is_admin is not REQUIRED (that was the bug —
  // it locked out Match Ops grantees) but it is SUFFICIENT: an admin must never be denied a read they
  // could always do. So the gate opens for is_admin OR can_access_matchops; a no-flags account has
  // neither and is refused.
  // CONFINEMENT FIRST (Phase 29b). A city manager is refused here regardless of can_access_matchops
  // — that flag being true on their row IS the leak this closes, and revoking it by hand fixes the
  // rows that exist, not the next one someone grants from the grid.
  if (isCityManagerConfined(row)) {
    return { ok: false, status: 403, error: CITY_MANAGER_CONFINED_ERROR };
  }
  if (row.is_admin !== true && row.can_access_matchops !== true) {
    return { ok: false, status: 403, error: "Match Ops access required. Ask an admin to grant you Match Ops." };
  }
  return { ok: true };
}

export async function authenticateMatchOpsRead(req: Request): Promise<MatchOpsAuthResult> {
  const r = await resolveSessionUser(req);
  if (!r.ok) return r;
  const gate = matchOpsReadGate(r.row, r.email);
  if (!gate.ok) return gate;
  // A CONFINED ACCOUNT HOLDS can_access_matchops, and that capability also opens routes belonging
  // to pages outside its six. Hiding those pages is not refusing their requests — the allowlist is.
  const route = assertConfinedRoute(r.row, req.url);
  if (!route.ok) return route;
  return {
    ok: true,
    supabase: r.supabase,
    appUserId: r.row.id as string,
    email: r.email,
    isAdmin: r.row.is_admin === true,
    confinedCity: confinedCity(r.row),
    confined: isConfined(r.row),
    ...deriveMatchOpsFlags(r.row),
  };
}


/**
 * THE BOUNDARY ON A MATCH ID — call this in every route that ACTS on one.
 *
 * FILTERING A LIST IS NOT AUTHORISATION. Gameday Ops can only filter after the fetch (the MatchDay
 * admin API takes no city), so the list a confined account sees is a presentation decision. A match
 * id is a number: it can be typed, guessed, kept from a bookmark, or read out of a screenshot. If
 * the only thing standing between this account and another city's match were the list it was shown,
 * there would be no boundary at all — just a shorter menu.
 *
 * THE MIRROR FIRST, UNCHANGED. The city comes from mdapi_matches, the mirror every other scoped
 * query uses. When the mirror carries the match, that row decides, exactly as it always has.
 *
 * A MATCH THE MIRROR DOES NOT CARRY IS ASKED OF THE LIVE API (Ryan, 2026-10-29). The mirror syncs
 * once a day, so a match created since then used to be refused to the confined account whose city
 * it is in. Now its city is read from GET /admin/matches/{id} in the request's own environment and
 * compared by name, the way the board scopes its list. Still deny by default: a live read that
 * fails, a match with no city, or an environment that is not one of the two is a refusal.
 *
 * `env` is the route's own environment for /api/matchday/{env}/ routes; routes that only ever act on
 * production omit it. Returns { ok: true } immediately for unconfined accounts, with no query.
 */
export async function assertMatchInScope(
  supabase: SupabaseClient,
  scopeCity: string | null,
  matchApiId: string | number | null | undefined,
  env?: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!scopeCity) return { ok: true };
  const id = Number(matchApiId);
  if (!Number.isFinite(id)) return { ok: false, status: 400, error: "match id required" };
  const { data, error } = await supabase
    .from("mdapi_matches")
    .select("api_id, city_identifier")
    .eq("api_id", id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "Could not verify the match's city" };
  if (!data) return liveMatchInScope(scopeCity, id, env);
  if (String(data.city_identifier ?? "") !== scopeCity) {
    return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  }
  return { ok: true };
}

/* ONLY REACHED WHEN THE MIRROR HAS NO ROW. The guarded client is imported here, inside the call, so
 * this module stays importable by the offline gate suites, which load it without the server-only
 * condition. */
async function liveMatchInScope(
  scopeCity: string,
  id: number,
  env: string | undefined,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const target = env === undefined ? "production" : env === "staging" || env === "production" ? env : null;
  const want = cityNameFor(scopeCity);
  if (!target || !want) return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  try {
    const { apiGet } = await import("./matchdayStageApi");
    const match = await apiGet<Record<string, unknown>>(target, `/admin/matches/${id}`);
    const city = ((match.field as Record<string, unknown> | undefined)?.city as Record<string, unknown> | undefined)?.name;
    return city === want ? { ok: true } : { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  } catch {
    return { ok: false, status: 403, error: CONFINED_CITY_ERROR };
  }
}
