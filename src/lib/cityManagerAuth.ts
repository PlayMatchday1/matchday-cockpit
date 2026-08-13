// Phase 25 Part A — the CITY MANAGER gate. The THIRD tier, and separate from matchOpsAuth ON PURPOSE.
//
// WHY NOT can_access_matchops: that flag opens twelve routes today (gameday, player lookup, player
// payments, the promo reads, change log, roster reads). Anything moved onto the Match Ops read gate
// later would be inherited by city managers SILENTLY — no migration, no review, no way to notice. A
// city manager is a narrower account than an operator, so it gets its own flag, its own gate, and
// its own opt-in list.
//
// DENY BY DEFAULT, and doubly so here: this gate requires is_city_manager AND a city scope, and a
// route that nobody explicitly opened stays closed. Being an admin does NOT satisfy this gate —
// unlike matchOpsAuth where is_admin is sufficient for a read. That asymmetry is deliberate: this
// gate does not answer "may you read this?", it answers "are you a scoped city account, and which
// city?" An admin has no city, so there is no scope to hand back, and any route that admins should
// also reach must check for that separately rather than pretending an admin is a city manager.
//
// THE SCOPE IS THE POINT. Every caller gets `cityIdentifier` back and MUST push it into the query
// (`.eq("city_identifier", auth.cityIdentifier)`), never filter after fetching. Hiding other cities
// in the UI is not scoping — a city manager who edits a match id or a ?city= param has to be
// REFUSED by the server, which is what assertCityScope below is for.

import { type SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUser, type AppUserRow } from "./adminAuth";

export type CityManagerAuthResult =
  | { ok: true; supabase: SupabaseClient; appUserId: string; email: string; cityIdentifier: string }
  | { ok: false; status: number; error: string };

// The E2E service account is blocked here EXPLICITLY, keyed on EMAIL (not full_name), belt-and-
// suspenders atop the DB is_service_account trigger that 0120 extended.
export const E2E_SERVICE_EMAIL = "clubhouse-e2e@playmatchday.com";

// PURE decision — testable offline for every row shape. Returns the SCOPE on success, because a
// city manager without a city is not a partially-valid account, it is a refusal.
export function cityManagerGate(
  row: AppUserRow | null,
  email: string,
): { ok: true; cityIdentifier: string } | { ok: false; status: number; error: string } {
  if (!row) return { ok: false, status: 403, error: "Not a cockpit user" };
  if (email.toLowerCase() === E2E_SERVICE_EMAIL || row.is_service_account === true) {
    return { ok: false, status: 403, error: "Service accounts cannot access city manager pages" };
  }
  if (row.is_city_manager !== true) {
    return { ok: false, status: 403, error: "City manager access required." };
  }
  // 0120's CHECK constraint makes this unreachable from a valid row, but a gate that trusts a
  // constraint it cannot see is a gate with a hole. No scope => no access, never "all cities".
  const city = typeof row.city_identifier === "string" ? row.city_identifier.trim() : "";
  if (!city) {
    return { ok: false, status: 403, error: "Your account has no city assigned. Ask an admin to set one." };
  }
  return { ok: true, cityIdentifier: city };
}

export async function authenticateCityManager(req: Request): Promise<CityManagerAuthResult> {
  const r = await resolveSessionUser(req);
  if (!r.ok) return r;
  const gate = cityManagerGate(r.row, r.email);
  if (!gate.ok) return gate;
  return {
    ok: true,
    supabase: r.supabase,
    appUserId: r.row.id as string,
    email: r.email,
    cityIdentifier: gate.cityIdentifier,
  };
}

// THE REFUSAL. Call this with the city of the resource the request names (a match's
// city_identifier, a ?city= param) before doing anything with it. Editing a match id in the URL
// must produce a 403, not a silently-empty page.
export function assertCityScope(
  scope: string,
  requested: string | null | undefined,
): { ok: true } | { ok: false; status: number; error: string } {
  // No city named => the caller's own scope applies; nothing to refuse.
  if (requested === null || requested === undefined || requested === "") return { ok: true };
  if (requested.trim().toUpperCase() !== scope.trim().toUpperCase()) {
    return { ok: false, status: 403, error: "That match is not in your city." };
  }
  return { ok: true };
}
