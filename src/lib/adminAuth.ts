// Admin-only auth for server routes that mutate locked-down tables via
// the service_role key. Mirrors crmAuth's session-verification, but gates
// strictly on app_users.is_admin and returns a SERVICE-ROLE client (RLS
// bypass) only AFTER the admin check passes.
//
// Phase 23 Step 2 Part D — the session-resolution + flag-derivation are now factored out
// (resolveSessionUser / deriveMatchOpsFlags) and the is_admin decision is a PURE function (adminGate),
// so the match-ops READ gate (matchOpsAuth.ts) can reuse the plumbing without loosening this one.
//
// THE FACT THIS SPLIT EXISTS TO FIX: authenticateAdmin requires is_admin BEFORE it computes
// canEditMatches / canManagePlayers / canManagePromos. So those flags have never GRANTED access to
// anyone — they have only ever RESTRICTED admins. A non-admin with can_access_matchops was locked out
// of every authenticateAdmin route. The read gate lives in matchOpsAuth.ts; this file is unchanged in
// behaviour (still is_admin) and stays that way until each route is moved deliberately.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isConfined, CONFINED_ERROR } from "./cityConfinement";

export type AdminAuthResult =
  | { ok: true; supabase: SupabaseClient; appUserId: string; email: string; canEditMatches: boolean; canManagePlayers: boolean; canManagePromos: boolean }
  | { ok: false; status: number; error: string };

export type AppUserRow = Record<string, unknown>;

// The WRITE permissions (Phase 17/18): EDIT MATCHES / MANAGE PLAYERS / MANAGE PROMOS. Each is an
// explicit grant (off by default), independent of is_admin and of each other, and each REQUIRES
// MATCH OPS (read). Derived identically wherever a route needs them, so the admin gate and the
// match-ops read gate can never disagree about what a row is allowed to write.
// ── THE CITY-MANAGER CONFINEMENT (Phase 29b — a production leak) ─────────────
//
// WHAT WENT WRONG. The city-manager tier was ADDITIVE: the grant set is_city_manager +
// city_identifier, but the account ALSO carried the ordinary can_access_matchops, and
// authenticateMatchOpsRead requires exactly that flag and knows nothing about the tier. A DFW
// city manager could therefore open the entire Match Ops estate — Master Schedule, Slate Review,
// Field Ops, Inventory, Change Log, and Player Lookup, which is player PII for EVERY city.
// Observed live on rgmstrategicventures@gmail.com.
//
// The flags were revoked by hand to close it. THIS is what stops it coming back: the tier is now
// RESTRICTIVE, not additive. A row with is_city_manager === true is refused by the admin gate and
// by the Match Ops read gate NO MATTER WHICH can_* FLAGS IT CARRIES — so re-adding Match Ops in
// the user grid cannot reopen the leak. Their access is exactly the /city/* pages, which gate on
// cityManagerGate (is_city_manager + a city scope) and never on these flags.
//
// is_admin WINS if somehow both are set — an admin must never be locked out of their own tool.
// The two are already mutually exclusive at the grant; this is belt and braces, stated rather
// than assumed.
export function isCityManagerConfined(row: AppUserRow): boolean {
  return row.is_city_manager === true && row.is_admin !== true;
}

export const CITY_MANAGER_CONFINED_ERROR =
  "City manager accounts are scoped to their own city. Use Manager Pay, Reviews or Gameday Ops under /city.";

export function deriveMatchOpsFlags(row: AppUserRow): { canEditMatches: boolean; canManagePlayers: boolean; canManagePromos: boolean } {
  const matchops = row.can_access_matchops === true;
  return {
    canEditMatches: row.can_edit_matches === true && matchops,
    canManagePlayers: row.can_manage_players === true && matchops,
    canManagePromos: row.can_manage_promos === true && matchops,
  };
}

// PURE is_admin decision — testable offline. Deny by default: a missing/false flag or a missing row
// is a refusal.
export function adminGate(row: AppUserRow | null): { ok: true } | { ok: false; status: number; error: string } {
  if (!row) return { ok: false, status: 403, error: "Not a cockpit user" };
  if (row.is_admin !== true) return { ok: false, status: 403, error: "Admin access required" };
  return { ok: true };
}

// Verify the bearer session and load the app_users row with the SERVICE role. Shared by
// authenticateAdmin and authenticateMatchOpsRead — the gate each applies afterward is what differs.
export async function resolveSessionUser(req: Request):
  Promise<{ ok: true; supabase: SupabaseClient; row: AppUserRow; email: string } | { ok: false; status: number; error: string }> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return { ok: false, status: 401, error: "Missing Authorization header" };
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return { ok: false, status: 401, error: "Empty bearer token" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anonKey || !serviceKey) return { ok: false, status: 500, error: "Supabase env not configured" };

  // Verify the session token belongs to a real user.
  const sessionClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  if (error || !data?.user?.email) return { ok: false, status: 401, error: "Invalid session" };
  const email = data.user.email.toLowerCase();

  // Look up the cockpit user with the service role. select("*") (NOT an explicit column list) so a
  // newly-added grant column that hasn't been migrated yet can't error the whole query — a missing
  // column then reads as undefined → the derived permission is false until the migration lands.
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const appUser = await sb.from("app_users").select("*").ilike("email", email).maybeSingle();
  if (appUser.error || !appUser.data) return { ok: false, status: 403, error: "Not a cockpit user" };
  return { ok: true, supabase: sb, row: appUser.data as AppUserRow, email };
}

export async function authenticateAdmin(req: Request): Promise<AdminAuthResult> {
  const r = await resolveSessionUser(req);
  if (!r.ok) return r;
  // The tier is confined BEFORE the admin gate: a city manager holding a stray flag must not be
  // admitted by it. (is_admin wins inside isCityManagerConfined, so a real admin is unaffected.)
  if (isCityManagerConfined(r.row)) return { ok: false, status: 403, error: CITY_MANAGER_CONFINED_ERROR };
  // THE BOUNDARY IS CHECKED HERE TOO, and before the admin gate for the same reason: an admin flag
  // inside a boundary must not widen it. Every /api/admin/* route is outside the six by
  // definition, so a confined account is refused all of them at the server — not merely denied a
  // nav item. See cityConfinement.ts for why this disagrees with the line above it.
  if (isConfined(r.row)) return { ok: false, status: 403, error: CONFINED_ERROR };
  const gate = adminGate(r.row);
  if (!gate.ok) return gate;
  return { ok: true, supabase: r.supabase, appUserId: r.row.id as string, email: r.email, ...deriveMatchOpsFlags(r.row) };
}
