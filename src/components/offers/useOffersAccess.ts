"use client";

// May the signed-in user see Growth › Offers? Asked of the server (GET /api/offers/access, the same
// gate as every /api/offers/* route); the allowlist itself never reaches the browser.
// useOffersAccessState: null while asking, then "yes", "no" (a 404 off the list, a 403 not an admin, a
// 503 local mode off, a network error) or "signin" (a 401: the session has ended; see
// offersAccessState). useOffersAccess is the rail's yes or no. One request per signed-in user,
// shared by the rail and the page; "signin" is not kept, so signing in again asks afresh.

import { useEffect, useState } from "react";
import { offersAccessState, type OffersAccessState } from "@/lib/offersAccess";
import { useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";

const cache = new Map<string, Promise<OffersAccessState>>();
function ask(userKey: string): Promise<OffersAccessState> {
  let p = cache.get(userKey);
  if (!p) {
    p = (async (): Promise<OffersAccessState> => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return "signin";
      const res = await fetch("/api/offers/access", { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      return offersAccessState(res.status, await res.json().catch(() => null));
    })().catch((): OffersAccessState => "no");
    cache.set(userKey, p);
    p.then((state) => { if (state === "signin") cache.delete(userKey); });
  }
  return p;
}

export function useOffersAccessState(): OffersAccessState | null {
  const { appUser, isLoading } = useAuth();
  // Not an admin: no, without asking (the server would refuse them anyway).
  const key = appUser?.id && appUser.is_admin ? String(appUser.id) : null;
  const [answer, setAnswer] = useState<{ key: string; state: OffersAccessState } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    ask(key).then((state) => { if (!cancelled) setAnswer({ key, state }); });
    return () => { cancelled = true; };
  }, [key]);
  if (isLoading) return null;
  if (!key) return "no";
  return answer && answer.key === key ? answer.state : null;
}

export function useOffersAccess(): boolean | null {
  const state = useOffersAccessState();
  return state === null ? null : state === "yes";
}
