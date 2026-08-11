"use client";

// Phase 19 Step 3a — useDockSubject: a Match Ops screen declares WHO it is currently about, so the
// docked player-chat can warn (Banner B) when you are talking to someone other than the person on
// screen. It is deliberately INERT: it only records the subject in the CRM provider and clears it
// on unmount/change. It never opens, moves, or closes the dock — a screen that has no dock open is
// completely unaffected. Screens that are not about one player simply don't call it.
//
//   useDockSubject(playerId, "Marco R.")   // Player Lookup, a match roster row, etc.
//
// playerId is loose (rosters store a number; some callers hold a string) — the dock compares by
// string. Pass null when the screen has no single player subject (the call becomes a no-op).

import { useEffect } from "react";
import { useCrmConversation } from "@/lib/crmConversation";

export function useDockSubject(
  playerId: string | number | null | undefined,
  label?: string | null,
): void {
  const { setDockSubject } = useCrmConversation();
  const pid = playerId ?? null;
  const lbl = label ?? null;
  useEffect(() => {
    setDockSubject({ playerId: pid, label: lbl });
    return () => setDockSubject(null);
  }, [pid, lbl, setDockSubject]);
}
