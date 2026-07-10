"use client";

import { useEffect, useState } from "react";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { supabase } from "./supabase";

export type AppUser = {
  id: string;
  email: string;
  full_name: string | null;
  is_admin: boolean;
  can_access_chats: boolean;
  can_access_clubhouse: boolean;
  can_access_cities: boolean;
  can_access_data: boolean;
  can_access_docs: boolean;
  can_access_finance: boolean;
  created_at: string;
  last_login_at: string | null;
};

export type PageName =
  | "chats"
  | "clubhouse"
  | "cities"
  | "data"
  | "docs"
  | "finance";

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

export function canAccess(
  appUser: AppUser | null,
  page: PageName,
): boolean {
  if (!appUser) return false;
  if (appUser.is_admin) return true;
  switch (page) {
    case "chats":
      return appUser.can_access_chats;
    case "clubhouse":
      return appUser.can_access_clubhouse;
    case "cities":
      return appUser.can_access_cities;
    case "data":
      return appUser.can_access_data;
    case "docs":
      return appUser.can_access_docs;
    case "finance":
      return appUser.can_access_finance;
  }
}

export function hasAnyAccess(appUser: AppUser | null): boolean {
  if (!appUser) return false;
  return (
    appUser.is_admin ||
    appUser.can_access_chats ||
    appUser.can_access_clubhouse ||
    appUser.can_access_cities ||
    appUser.can_access_data ||
    appUser.can_access_docs ||
    appUser.can_access_finance
  );
}

export function firstAllowedPath(appUser: AppUser | null): string {
  if (!appUser) return "/login";
  if (appUser.is_admin || appUser.can_access_clubhouse) return "/clubhouse";
  if (appUser.can_access_cities) return "/cities";
  if (appUser.can_access_data) return "/data";
  if (appUser.can_access_docs) return "/docs";
  if (appUser.can_access_finance) return "/admin/finance";
  if (appUser.can_access_chats) return "/chats";
  return "/no-access";
}

export function displayName(appUser: AppUser | null): string {
  if (!appUser) return "";
  const trimmed = appUser.full_name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : appUser.email;
}
