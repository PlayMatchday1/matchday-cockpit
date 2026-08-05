"use client";

// Count of partner dashboards, for the Match Ops rail badge. This badge means
// "how many partners are in here" — a count, not an alert — so it is rendered in
// the neutral (grey) badge style, never a status colour. A light head-count
// query (no player data); refetches on mount + window focus.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { canAccess, useAuth } from "@/lib/useAuth";

export function usePartnerDashboardsCount(): number {
  const { appUser } = useAuth();
  const enabled = canAccess(appUser ?? null, "tech");
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    if (!enabled) { setCount(0); return; }
    try {
      const { count: c, error } = await supabase
        .from("partner_dashboards")
        .select("id", { count: "exact", head: true });
      if (!error && typeof c === "number") setCount(Math.max(0, c));
    } catch {
      // keep last value silently
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) { setCount(0); return; }
    void refetch();
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refetch]);

  return count;
}
