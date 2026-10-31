"use client";

// May the signed-in user see Match Ops › Offers? Asked of the server (GET /api/offers/access, the same
// gate as every /api/offers/* route). canUseOffers is the courtesy for the chrome; the server decides.
// useOffersAccessState: null while asking, then "yes", "no" (a 404 without Match Ops access, a 503
// config unset or wrong, a network error) or "signin" (a 401: the session has ended; see
// offersAccessState). One request per signed-in user; "signin" is not kept, so signing in again
// asks afresh.

import { useEffect, useState } from "react";
import { offersAccessState, type OffersAccessState } from "@/lib/offersAccess";
import { canUseOffers } from "@/lib/offersCanUse";
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
  // Without Match Ops: no, without asking (the server would refuse them anyway).
  const key = appUser?.id && canUseOffers(appUser) ? String(appUser.id) : null;
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
