"use client";

// The Match Ops "Disputes" rail badge: Stripe disputes needing a response. Admins only (the route is
// authenticateAdmin). Served from the server's cached dispute list, so most polls are not a Stripe read.
// Same polling contract as usePartnerDashboardsCount: 60 s timer + tab focus, a failure keeps the last
// value and never throws; the rail hides the badge at zero.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { sharedFetch } from "@/lib/sharedBadgeFetch";
import { useAuth } from "@/lib/useAuth";

const POLL_MS = 60_000;

export function useDisputesCount(): number {
  const { appUser } = useAuth();
  const enabled = !!appUser?.is_admin;
  const [count, setCount] = useState(0);

  const refetch = useCallback(async (force = false) => {
    if (!enabled) { setCount(0); return; }
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const json = await sharedFetch("disputes:count", async () => {
        const res = await fetch("/api/disputes/count", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { count?: number };
      }, force);
      if (typeof json.count === "number" && Number.isFinite(json.count)) setCount(Math.max(0, json.count));
    } catch {
      // keep last value silently
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    void refetch();
    const timer = setInterval(() => void refetch(), POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void refetch(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, refetch]);

  return count;
}
