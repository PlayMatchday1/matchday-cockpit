// Phase 27 — EDIT CREDITS, its own gate. The Phase 17 pattern, with one deliberate difference.
//
// EVERY OTHER WRITE GRANT REQUIRES MATCH OPS. This one does not, in either direction: it is not
// implied by can_access_matchops and is not cascaded off by it (see migration 0122). Editing a
// match, banning a player and creating a promo are all things you do inside Match Ops. Moving
// money is not, and nobody should acquire the ability to put $500 into a real account as a side
// effect of being granted a read permission.
//
// Read FRESH FROM THE DATABASE on every request. Nothing is cached in the JWT — a revoke has to
// take effect on the next request, not whenever a token happens to expire. Deny by default: a
// missing row, a missing column or a false value is a refusal.

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUser, type AppUserRow } from "./adminAuth";

export type CreditsAuthResult =
  | { ok: true; supabase: SupabaseClient; appUserId: string; email: string; canEditCredits: true }
  | { ok: false; status: number; error: string };

// PURE decision — testable offline, and the same function the census walks.
export function creditsGate(row: AppUserRow | null): { ok: true } | { ok: false; status: number; error: string } {
  if (!row) return { ok: false, status: 403, error: "Not a cockpit user" };
  // A service account can never move money. The database guard (0122) refuses to even STORE the
  // grant on a service-account row; this is the second lock, in case a row is ever seeded around it.
  if (row.is_service_account === true) {
    return { ok: false, status: 403, error: "Service accounts cannot edit credits" };
  }
  if (row.can_edit_credits !== true) {
    return { ok: false, status: 403, error: "EDIT CREDITS is required to change a player's balance. This is not part of Match Ops and is granted separately." };
  }
  return { ok: true };
}

export async function authenticateCredits(req: Request): Promise<CreditsAuthResult> {
  const r = await resolveSessionUser(req);
  if (!r.ok) return r;
  const gate = creditsGate(r.row);
  if (!gate.ok) return gate;
  return {
    ok: true,
    supabase: r.supabase,
    appUserId: String(r.row.id ?? ""),
    email: r.email,
    canEditCredits: true,
  };
}
