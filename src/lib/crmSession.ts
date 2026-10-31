"use client";

// THE SESSION BEHIND EVERY CHATS REQUEST. Each one read the token from getSession() and sent it, so a
// token past its expiry (a laptop waking up, a throttled background tab) reached the API as a 401
// "Invalid session" and the inbox had nothing to show for it.
//
// freshAccessToken refreshes a token inside its last minute before it is sent. recoverSession is for
// the 401 that gets through anyway; only reads retry after it. A send never retries: a duplicate
// message is visible to a player.

import { supabase } from "@/lib/supabase";

const NEAR_EXPIRY_MS = 60_000;
const RELOAD_GUARD_KEY = "crm-session-reload-at";
const RELOAD_GUARD_MS = 60_000;
export const SESSION_EXPIRED_TEXT = "Session expired, reloading";
export const SESSION_LOST_TEXT = "Session expired. Please sign in again.";

export async function freshAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const s = data.session;
  if (!s) return null;
  if (s.expires_at != null && s.expires_at * 1000 - Date.now() < NEAR_EXPIRY_MS) {
    const r = await supabase.auth.refreshSession();
    return r.data.session?.access_token ?? null;
  }
  return s.access_token;
}

/** After a 401: a new token, or null when the session can't be refreshed. */
export async function recoverSession(): Promise<string | null> {
  const r = await supabase.auth.refreshSession().catch(() => null);
  return r?.data.session?.access_token ?? null;
}

/** Reload to pick up the login redirect, at most once a minute so a bad session can't loop. Returns the text to show. */
export function reloadForExpiredSession(): string {
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0); } catch { /* storage blocked */ }
  if (Date.now() - last < RELOAD_GUARD_MS) return SESSION_LOST_TEXT;
  try { sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now())); } catch { return SESSION_LOST_TEXT; }
  setTimeout(() => window.location.reload(), 1200);
  return SESSION_EXPIRED_TEXT;
}
