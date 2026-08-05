"use client";

// useManagerPayAttnCount — the "needs a look" count for the default (last
// completed) week, for the Manager Pay rail badge. It is the SAME number the
// page's fourth tile shows: both read payload.attention.count, which the pay
// compute derives once, server-side. The badge and the tile can't disagree.
//
// Polling contract mirrors useCrmAwaitingCount: refetch on a 30s timer + tab
// focus, every failure path keeps the last value and never throws. Enabled for
// anyone who can open the Manager Pay section (cities access, or admin).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { canAccess, useAuth } from "@/lib/useAuth";
import { defaultManagerPayWeek } from "@/lib/managerPayView";

const POLL_MS = 60_000;

export function useManagerPayAttnCount(): number {
  const { appUser } = useAuth();
  const enabled = !!appUser?.is_admin || canAccess(appUser ?? null, "matchops");
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    if (!enabled) {
      setCount(0);
      return;
    }
    try {
      const week = defaultManagerPayWeek(new Date().toISOString().slice(0, 10));
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`/api/manager-pay/week?week=${encodeURIComponent(week)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { attention?: { count?: number } };
      const n = json.attention?.count;
      if (typeof n === "number" && Number.isFinite(n)) setCount(Math.max(0, n));
    } catch {
      // keep last value silently
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    void refetch();
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, refetch]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  return count;
}
