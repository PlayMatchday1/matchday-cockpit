"use client";

// useCrmAwaitingCount — GLOBAL count of open player-chat conversations waiting
// on a human reply, for the chat rail badge. Same number the Player Chats
// metrics-strip "N waiting on a reply" pill shows (both derive from the shared
// isAwaitingReply rule), so the badge and the pill can never disagree.
//
// Polling only (no realtime), same resilience contract as useCrmUnreadCount:
// refetch on a 30s timer + tab focus, every failure path keeps the last value
// and never throws, returns 0 for non-admins. The consumer hides the badge at
// 0 (a false zero is worse than no badge).

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { sharedFetch } from "@/lib/sharedBadgeFetch";
import { useAuth } from "@/lib/useAuth";

const POLL_MS = 30_000;

export function useCrmAwaitingCount(): number {
  const { appUser } = useAuth();
  const isAdmin = !!appUser?.is_admin;
  const canChats = !!appUser?.can_access_chats;
  const enabled = isAdmin || canChats;
  const [count, setCount] = useState(0);

  const refetch = useCallback(async (force = false) => {
    if (!enabled) {
      setCount(0);
      return;
    }
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      /* SHARED. ChatsRail, MatchOpsSectionSheet, TopNav and MobileBottomNav all mount badges that
       * ask for this same number, and each used to fetch it for itself — four requests for one
       * answer on every page. sharedFetch collapses them into one. */
      const json = await sharedFetch("crm:awaiting", async () => {
        const res = await fetch("/api/crm/threads/awaiting-count", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { count?: number };
      }, force);
      if (typeof json.count === "number" && Number.isFinite(json.count)) {
        setCount(Math.max(0, json.count));
      }
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
