"use client";

// useCrmUnreadCount — total unread customer-chat threads for the
// current viewer, used by the "Chats" nav badge.
//
// Returns the same count the iOS PWA home-screen badge writes
// (computeUnreadCountsForUsers in src/lib/crmPushNotify.ts): SMS +
// WhatsApp, 50-thread cap, assignment-aware. Nav circle and PWA
// badge agree by construction.
//
// Realtime: subscribes to the same three sources CrmClient uses:
//   - crm_messages INSERT          → new inbound may flip a thread to unread
//   - crm_threads UPDATE           → covers reads_updated_at touch from the
//                                    0035 trigger (cross-admin convergence)
//   - crm_thread_reads user_id=eq  → same-user multi-device reads
// Any event → refetch. Also refetches on visibilitychange so a
// count that went stale while the tab was backgrounded snaps back
// on focus.
//
// Returns 0 for non-admins and unauthenticated callers — safe to
// mount unconditionally; the consumer hides the badge at count 0.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/useAuth";

export function useCrmUnreadCount(): number {
  const { appUser } = useAuth();
  const userId = appUser?.id ?? null;
  const isAdmin = !!appUser?.is_admin;
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    if (!isAdmin || !userId) {
      setCount(0);
      return;
    }
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    try {
      const res = await fetch("/api/crm/threads/unread-count", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return;
      const json = (await res.json()) as { count?: number };
      if (typeof json.count === "number") {
        setCount(json.count);
      }
    } catch {
      // Silent — the next realtime event or visibility flip reconciles.
    }
  }, [isAdmin, userId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  useEffect(() => {
    if (!isAdmin || !userId) return;
    const channel = supabase
      .channel(`crm-unread-badge-${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crm_messages" },
        () => {
          void refetch();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "crm_threads" },
        () => {
          void refetch();
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "crm_thread_reads",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void refetch();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [isAdmin, userId, refetch]);

  return count;
}
