"use client";

// useVeoReviewCount — the number of Veo items in the review queue, for the
// "Automated messaging" button badge on Match Chats. Reads the SAME endpoint the
// Veo section reads (/api/veo → queue.length); it is not hardcoded or
// approximated. Fails safe to 0 (non-admins get 403 → no badge). Refetches on
// mount and on tab focus.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export function useVeoReviewCount(): number {
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/veo", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) return; // 403 for non-admins etc. → keep 0
      const json = (await res.json()) as { queue?: unknown[] };
      if (Array.isArray(json.queue)) setCount(json.queue.length);
    } catch {
      // keep last value
    }
  }, []);

  useEffect(() => {
    void refetch();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refetch]);

  return count;
}
