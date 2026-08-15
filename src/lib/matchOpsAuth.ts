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

export type MatchOpsAuthResult =
  | { ok: true; supabase: SupabaseClient; appUserId: string; email: string; isAdmin: boolean; canEditMatches: boolean; canManagePlayers: boolean; canManagePromos: boolean }
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
  return {
    ok: true,
    supabase: r.supabase,
    appUserId: r.row.id as string,
    email: r.email,
    isAdmin: r.row.is_admin === true,
    ...deriveMatchOpsFlags(r.row),
  };
}
