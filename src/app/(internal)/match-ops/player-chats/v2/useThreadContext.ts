"use client";

// ONE CONTEXT REQUEST PER THREAD SWITCH, shared by the player strip (the fact chips) and the
// details panel — the rule ContextPane set: you switch threads quickly, and two round trips per
// switch would show. Same route, GET /api/crm/threads/{id}/context (it assembles the Player Lookup
// profile, the mirror row and the Stripe payments, and applies the city check).

import { useCallback, useEffect, useState } from "react";
import { THREAD_LINKED_EVENT } from "@/lib/crmLinkClient";
import { authFetch, type ContextResponse } from "../components/ContextPane";

export type ThreadContext = {
  data: ContextResponse | null;
  error: string | null;
  /** The balance after a credit landed here, so the chip and the panel move without a refetch. */
  credits: number | null;
  setLiveCredits: (cents: number) => void;
};

export function useThreadContext(threadId: string | null): ThreadContext {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Linked from the draft card or the Account tab: the account changed, so read again.
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<{ threadId: string }>).detail?.threadId === threadId) setReloadKey((k) => k + 1); };
    window.addEventListener(THREAD_LINKED_EVENT, on);
    return () => window.removeEventListener(THREAD_LINKED_EVENT, on);
  }, [threadId]);

  useEffect(() => {
    let off = false;
    setData(null); setError(null); setLive(null);
    if (!threadId) return;
    void (async () => {
      try {
        const res = await authFetch(`/api/crm/threads/${threadId}/context`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (!off) setData((await res.json()) as ContextResponse);
      } catch (e) {
        if (!off) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { off = true; };
  }, [threadId, reloadKey]);

  const setLiveCredits = useCallback((c: number) => setLive(c), []);
  return { data, error, credits: live ?? data?.profile?.player.credits ?? null, setLiveCredits };
}
