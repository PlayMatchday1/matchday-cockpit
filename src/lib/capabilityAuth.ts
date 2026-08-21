// THE SERVER SIDE OF capabilities.ts — resolve the session, then ask the SAME `can()` the panel asks.
//
// This replaces authenticateAdmin on every route that is not the User access screen. The difference
// is the whole point of the change: authenticateAdmin refused a non-admin BEFORE it looked at any
// flag, so a ticked box could never grant anything. Here the capability decides, and is_admin is
// just another way to hold a page.
//
// WHAT IT STILL RETURNS: the service-role client, because these routes write tables that RLS locks.
// The gate in front of it is what changed, not the client behind it.

import { type SupabaseClient } from "@supabase/supabase-js";
import { resolveSessionUser, type AppUserRow } from "./adminAuth";
import { can, denial, type Capability } from "./capabilities";
import { confinedCity, assertConfinedRoute } from "./cityConfinement";

export type CapAuthResult =
  | {
      ok: true; supabase: SupabaseClient; appUserId: string; email: string; row: AppUserRow;
      isAdmin: boolean;
      // null = unconfined. Non-null means the route MUST verify the resource's city before acting.
      confinedCity: string | null;
      // The write grants, derived from the same predicate the panels use.
      canEditMatches: boolean; canManagePlayers: boolean; canManagePromos: boolean;
      canEditCredits: boolean; canSendMessages: boolean;
    }
  | { ok: false; status: number; error: string };

export async function authenticateCapability(req: Request, cap: Capability): Promise<CapAuthResult> {
  const r = await resolveSessionUser(req);
  if (!r.ok) return r;
  if (!can(r.row, cap, r.email)) {
    return { ok: false, status: 403, error: denial(r.row, cap, r.email) ?? "Not permitted." };
  }
  // THE SAME ALLOWLIST. "matchops" and "chats" gate seventeen routes outside the six pages —
  // /community/*, /manager-pay/* (the ledger this account must never touch), /partner-dashboards/*,
  // /veo/codes/*, /inventory/*, /match-promotion. The capability opens them; this closes them.
  const route = assertConfinedRoute(r.row, req.url);
  if (!route.ok) return route;
  return {
    ok: true,
    supabase: r.supabase,
    appUserId: r.row.id as string,
    email: r.email,
    row: r.row,
    // THE CITY SCOPE, carried on the WRITE gate too. Every route that acts on a match id must be
    // able to re-check the city before acting, whichever gate admitted it — a boundary that holds
    // on reads and not on writes is not a boundary.
    confinedCity: confinedCity(r.row),
    isAdmin: r.row.is_admin === true,
    canEditMatches: can(r.row, "editMatches", r.email),
    canManagePlayers: can(r.row, "managePlayers", r.email),
    canManagePromos: can(r.row, "managePromos", r.email),
    canEditCredits: can(r.row, "editCredits", r.email),
    canSendMessages: can(r.row, "sendMessages", r.email),
  };
}
