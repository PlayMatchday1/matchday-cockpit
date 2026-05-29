"use client";

// useCrmUnreadCount — total unread customer-chat threads for the current
// viewer, for the "Chats" nav badge.
//
// POLLING ONLY — no Supabase realtime. A prior attempt mounted realtime
// channels in the global nav (TopNav + MobileBottomNav) with a duplicate
// channel name and no error isolation; it took down every page. This hook
// deliberately uses NO supabase.channel() — it refetches on a 30s timer
// and on tab focus. Every failure path returns 0 / keeps the last value
// and never throws, so the badge can fail without affecting the page.
// Returns 0 for non-admins (the consumer hides the badge at 0).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";

const POLL_MS = 30_000;

export function useCrmUnreadCount(): number {
  const { appUser } = useAuth();
  const isAdmin = !!appUser?.is_admin;
  const userId = appUser?.id ?? null;
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    if (!isAdmin || !userId) {
      setCount(0);
      return;
    }
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/crm/threads/unread-count", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      // Non-OK (including a forced 500) → leave the count as-is. No throw,
      // no badge crash; the next poll reconciles.
      if (!res.ok) return;
      const json = (await res.json()) as { count?: number };
      if (typeof json.count === "number" && Number.isFinite(json.count)) {
        setCount(Math.max(0, json.count));
      }
    } catch {
      // Network / parse / anything else — keep the current count silently.
    }
  }, [isAdmin, userId]);

  // Initial fetch + 30s polling. Cleared on unmount / identity change.
  useEffect(() => {
    if (!isAdmin || !userId) {
      setCount(0);
      return;
    }
    void refetch();
    const timer = setInterval(() => void refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [isAdmin, userId, refetch]);

  // Snap back when a backgrounded tab regains focus.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  return count;
}
