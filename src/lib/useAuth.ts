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
  return !!appUser && appUser.can_edit_matches === true && appUser.can_access_matchops === true;
}

// MANAGE PLAYERS (Phase 18) — INDEPENDENT of EDIT MATCHES. Courtesy gate for the ban
// affordances; the server enforces it regardless.
export function canManagePlayers(appUser: AppUser | null | undefined): boolean {
  return !!appUser && appUser.can_manage_players === true && appUser.can_access_matchops === true;
}

// MANAGE PROMOS (Phase 18b) — INDEPENDENT of EDIT MATCHES and MANAGE PLAYERS. Courtesy gate
// for the Promo Codes screen + its create affordance; the server enforces it regardless.
export function canManagePromos(appUser: AppUser | null | undefined): boolean {
  return !!appUser && appUser.can_manage_promos === true && appUser.can_access_matchops === true;
}

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
