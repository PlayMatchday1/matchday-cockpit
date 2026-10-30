"use client";

// May the signed-in user see Growth › Offers? Asked of the server (GET /api/offers/access, the same
// gate as every /api/offers/* route); the allowlist itself never reaches the browser. null while
// asking, then true or false. ANYTHING BUT A 200 { allowed: true } IS NO: a 404 (off the list), a 403
// (not an admin), a 503 (local mode off) and a network error all hide the rail item and the page.
// One request per signed-in user, shared by the rail and the page.

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/useAuth";
import { supabase } from "@/lib/supabase";

const cache = new Map<string, Promise<boolean>>();
function ask(userKey: string): Promise<boolean> {
  let p = cache.get(userKey);
  if (!p) {
    p = (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return false;
      const res = await fetch("/api/offers/access", { cache: "no-store", headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return false;
      const j = await res.json().catch(() => null);
      return j?.allowed === true;
    })().catch(() => false);
    cache.set(userKey, p);
  }
  return p;
}

export function useOffersAccess(): boolean | null {
  const { appUser, isLoading } = useAuth();
  // Not an admin: no, without asking (the server would refuse them anyway).
  const key = appUser?.id && appUser.is_admin ? String(appUser.id) : null;
  const [allowed, setAllowed] = useState<{ key: string; ok: boolean } | null>(null);
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    ask(key).then((ok) => { if (!cancelled) setAllowed({ key, ok }); });
    return () => { cancelled = true; };
  }, [key]);
  if (isLoading) return null;
  if (!key) return false;
  return allowed && allowed.key === key ? allowed.ok : null;
}
