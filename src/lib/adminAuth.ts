// Admin-only auth for server routes that mutate locked-down tables via
// the service_role key. Mirrors crmAuth's session-verification, but gates
// strictly on app_users.is_admin and returns a SERVICE-ROLE client (RLS
// bypass) only AFTER the admin check passes.
//
// Used by the Equipment Inventory edit/delete routes: inventory_submissions
// has no authenticated UPDATE/DELETE policy (anon fully locked out, only an
// authenticated SELECT), so admin mutations must go through a guarded
// service-role route rather than a broad RLS policy.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type AdminAuthResult =
  | { ok: true; supabase: SupabaseClient; appUserId: string; email: string; canEditMatches: boolean; canManagePlayers: boolean; canManagePromos: boolean }
  | { ok: false; status: number; error: string };

export async function authenticateAdmin(req: Request): Promise<AdminAuthResult> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Authorization header" };
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return { ok: false, status: 401, error: "Empty bearer token" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !anonKey || !serviceKey) {
    return { ok: false, status: 500, error: "Supabase env not configured" };
  }

  // Verify the session token belongs to a real user.
  const sessionClient = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sessionClient.auth.getUser(token);
  if (error || !data?.user?.email) {
    return { ok: false, status: 401, error: "Invalid session" };
  }
  const email = data.user.email.toLowerCase();

  // Look up the cockpit user with the service role, require is_admin.
  const sb = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const appUser = await sb
    .from("app_users")
    // select * (not an explicit column list) so a newly-added grant column that hasn't been
    // migrated yet can't error the whole query — a missing column then reads as undefined →
    // the derived permission is false until the migration lands. (can_manage_promos, 0117.)
    .select("*")
    .ilike("email", email)
    .maybeSingle();
  if (appUser.error || !appUser.data) {
    return { ok: false, status: 403, error: "Not a cockpit user" };
  }
  if (appUser.data.is_admin !== true) {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  // EDIT MATCHES is the WRITE permission (Phase 17). It is NOT implied by is_admin —
  // it defaults off for everyone and must be granted explicitly — and it requires
  // MATCH OPS (read). Routes pass this into the guarded write client.
  const canEditMatches = appUser.data.can_edit_matches === true && appUser.data.can_access_matchops === true;

  // MANAGE PLAYERS is the account-level WRITE permission (Phase 18) — suspend / expel /
  // lift. Same rules as EDIT MATCHES and INDEPENDENT of it: not implied by is_admin, off
  // by default, requires MATCH OPS. Holding one never implies the other.
  const canManagePlayers = appUser.data.can_manage_players === true && appUser.data.can_access_matchops === true;

  // MANAGE PROMOS is the promo-code WRITE permission (Phase 18b) — create / (later) edit,
  // delete. Same rules as the other two and INDEPENDENT of both: not implied by is_admin, off
  // by default, requires MATCH OPS. Read fresh here on every request (no JWT caching).
  const canManagePromos = appUser.data.can_manage_promos === true && appUser.data.can_access_matchops === true;

  return {
    ok: true,
    supabase: sb, // service-role client — bypasses RLS after the admin gate
    appUserId: appUser.data.id as string,
    email,
    canEditMatches,
    canManagePlayers,
    canManagePromos,
  };
}
