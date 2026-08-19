"use client";

import { useEffect, useState } from "react";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type AppUser = {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
  can_access_home: boolean;
  can_access_finance: boolean;
  can_access_growth: boolean;
  can_access_membership: boolean;
  can_access_matchops: boolean;
  can_access_chats: boolean;
  can_access_tech: boolean;
  can_edit_matches?: boolean;      // Phase 17 — the WRITE permission for matches
  can_manage_players?: boolean;    // Phase 18 — the account-level WRITE permission (ban)
  // Phase 25 — the THIRD tier. Deliberately NOT can_access_matchops: that flag opens twelve routes
  // and would be inherited silently by anything added to it later.
  is_city_manager?: boolean;
  city_identifier?: string | null;
  can_manage_promos?: boolean;     // Phase 18b — the promo-code WRITE permission (create/edit/delete)
  can_edit_credits?: boolean;      // Phase 27 — adjust a player's credit balance. MOVES MONEY; not tied to Match Ops
  can_send_messages?: boolean;     // Phase 19 — the chat SEND permission (read is can_access_chats)
  is_service_account?: boolean;    // the Clubhouse E2E account (never holds a write permission)
  created_at: string;
  last_login_at: string | null;
};

export type PageName =
  | "home"
  | "finance"
  | "growth"
  | "membership"
  | "matchops"
  | "chats"
  | "tech";

export type AuthState = {
  user: SupabaseUser | null;
  appUser: AppUser | null;
  isLoading: boolean;
};

const INITIAL: AuthState = { user: null, appUser: null, isLoading: true };

let cached: AuthState = INITIAL;
let initialized = false;
const subscribers = new Set<(s: AuthState) => void>();

function publish(s: AuthState) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

async function applyUser(user: SupabaseUser | null) {
  if (!user || !user.email) {
    publish({ user: null, appUser: null, isLoading: false });
    return;
  }
  const email = user.email.toLowerCase();
  const { data } = await supabase
    .from("app_users")
    .select("*")
    .eq("email", email)
    .maybeSingle();
  publish({
    user,
    appUser: (data as AppUser | null) ?? null,
    isLoading: false,
  });
}

function init() {
  if (initialized) return;
  initialized = true;

  supabase.auth.getSession().then(({ data }) => {
    applyUser(data.session?.user ?? null);
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    applyUser(session?.user ?? null);
  });
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(cached);

  useEffect(() => {
    init();
    subscribers.add(setState);
    setState(cached);
    return () => {
      subscribers.delete(setState);
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return { ...state, signOut };
}

// The WRITE permission for matches (Phase 17). Deliberately NOT short-circuited by
// is_admin — EDIT MATCHES defaults off for everyone and must be granted explicitly — and
// it requires MATCH OPS (read). The UI reads this to grey out write affordances; it is a
// courtesy. The server check in the shared write path (apiWrite) is what actually holds.
export function canEditMatches(appUser: AppUser | null | undefined): boolean {
  return can(appUser as CapRow | null, "editMatches", appUser?.email);
}

// MANAGE PLAYERS (Phase 18) — INDEPENDENT of EDIT MATCHES. Courtesy gate for the ban
// affordances; the server enforces it regardless.
export function canManagePlayers(appUser: AppUser | null | undefined): boolean {
  return can(appUser as CapRow | null, "managePlayers", appUser?.email);
}

// EDIT CREDITS (Phase 27) — the only grant that MOVES MONEY, and the only one that does NOT also
// require Match Ops. Every other write permission is a power you exercise inside Match Ops;
// adjusting someone's balance is not, so it must not arrive as a side effect of a read grant.
// Courtesy gate only — the route re-checks against a fresh database read on every request.
export function canEditCredits(appUser: AppUser | null | undefined): boolean {
  return can(appUser as CapRow | null, "editCredits", appUser?.email);
}

// MANAGE PROMOS (Phase 18b) — INDEPENDENT of EDIT MATCHES and MANAGE PLAYERS. This is the WRITE
// permission: create, edit, delete, and sight of who redeemed a code (that view carries player
// contact details). It gates AFFORDANCES, never the promo screen itself — see canReadPromos.
//
// NOT WIDENED, DELIBERATELY. It does not include is_admin: five of six admins do not hold this
// flag, and reading the codes is not a power any of them should have to be granted twice.
export function canManagePromos(appUser: AppUser | null | undefined): boolean {
  return can(appUser as CapRow | null, "managePromos", appUser?.email);
}

// READ PROMO CODES — re-exported so components keep importing their predicates from one place.
// The decision itself lives in promoAccess.ts with no imports, because useAuth cannot be loaded
// outside a browser and an untestable gate is how the last one drifted. See that file for why.
export { canReadPromos } from "./promoAccess";

// THE PANELS CALL THE SAME PREDICATE THE ROUTES DO. These wrappers exist only so the hundreds of
// existing call sites keep their names; every one of them now resolves through capabilities.ts,
// which is the module capabilityAuth.ts asks on the server. There is no second implementation to
// drift, and no equivalence test standing in for one.
import { can, type CapRow } from "./capabilities";

export function canAccess(
  appUser: AppUser | null,
  page: PageName,
): boolean {
  if (!appUser) return false;
  if (appUser.is_admin) return true;
  switch (page) {
    case "home":
      return appUser.can_access_home;
    case "finance":
      return appUser.can_access_finance;
    case "growth":
      return appUser.can_access_growth;
    case "membership":
      return appUser.can_access_membership;
    case "matchops":
      return appUser.can_access_matchops;
    case "chats":
      return appUser.can_access_chats;
    case "tech":
      return appUser.can_access_tech;
  }
}

export function hasAnyAccess(appUser: AppUser | null): boolean {
  if (!appUser) return false;
  // THE CITY-MANAGER TIER IS ACCESS IN ITS OWN RIGHT (Phase 29b). It was not, and that was half
  // of the leak: the tier held no access of its own, so it rode on a borrowed can_access_matchops
  // — which is precisely the flag that opened the whole Match Ops estate. Revoking that flag
  // closed the leak and simultaneously bounced both city managers to /no-access, because this
  // function did not know the tier existed. firstAllowedPath already routed them to
  // /city/manager-pay; AuthGate never got that far.
  //
  // Counting the tier here is what makes it a first-class grant instead of a passenger on someone
  // else's flag.
  if (isCityManager(appUser)) return true;
  return (
    appUser.is_admin ||
    appUser.can_access_home ||
    appUser.can_access_growth ||
    appUser.can_access_membership ||
    appUser.can_access_matchops ||
    appUser.can_access_tech ||
    appUser.can_access_chats ||
    appUser.can_access_finance
  );
}

// The city-manager tier: the flag AND a scope. A tier with no city is not partially valid — the
// server refuses it, so the client must not route to a page that will 403.
export function isCityManager(appUser: AppUser | null | undefined): boolean {
  return !!appUser && appUser.is_city_manager === true && !!(appUser.city_identifier ?? "").trim();
}

export function firstAllowedPath(appUser: AppUser | null): string {
  if (!appUser) return "/login";
  // Checked BEFORE the operator paths: a city manager holds none of those flags, and without this
  // they would land on /no-access.
  if (isCityManager(appUser) && !appUser.is_admin) return "/city/manager-pay";
  if (appUser.is_admin || appUser.can_access_home) return "/home";
  if (appUser.can_access_growth) return "/growth";
  if (appUser.can_access_membership) return "/membership";
  if (appUser.can_access_matchops) return "/match-ops";
  if (appUser.can_access_finance) return "/admin/finance";
  if (appUser.can_access_tech) return "/tech";
  if (appUser.can_access_chats) return "/match-ops/player-chats";
  return "/no-access";
}

export function displayName(appUser: AppUser | null): string {
  if (!appUser) return "";
  const trimmed = appUser.full_name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : appUser.email;
}
