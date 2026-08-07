"use client";

// The Match Ops "Partner Dashboards" rail badge. It counts things that NEED
// ACTION across every partner combined — periods awaiting payment, disputed
// periods, and paid periods whose figures diverged after payment — NOT how many
// partner dashboards exist. A number badge means "N things need your attention";
// a head-count lit it permanently and trained the eye to ignore it. The count
// comes from /api/partner-dashboards/actionable, the SAME derivation the panel
// uses, so badge and panel agree. Consumer hides the badge at 0 (a false zero is
// worse than no badge; a true zero should show nothing at all).
//
// Polling contract mirrors useManagerPayAttnCount: refetch on a 60s timer + tab
// focus, every failure path keeps the last value and never throws.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { canAccess, useAuth } from "@/lib/useAuth";

const POLL_MS = 60_000;

export function usePartnerDashboardsCount(): number {
  const { appUser } = useAuth();
  const enabled = !!appUser?.is_admin || canAccess(appUser ?? null, "tech");
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    if (!enabled) { setCount(0); return; }
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/partner-dashboards/actionable", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { count?: number };
      if (typeof json.count === "number" && Number.isFinite(json.count)) setCount(Math.max(0, json.count));
    } catch {
      // keep last value silently
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setCount(0); return; }
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
