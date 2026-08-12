"use client";

// Phase 19 Step 3a/3b — useDockSubject: a Match Ops screen declares WHO it is currently about (and,
// in 3b, WHAT canned lines are worth saying while looking at it), so the docked player-chat can warn
// (Banner B) when you're talking to someone other than the person on screen and offer per-screen
// snippets. It is deliberately INERT: it only records the subject in the CRM provider and clears it
// on unmount/change. It never opens, moves, or closes the dock — a screen with no dock open is
// completely unaffected. Screens that are not about one player simply don't call it.
//
//   useDockSubject(playerId, "Marco R.", ["Can you confirm your player ID?", ...])
//
// playerId is loose (rosters store a number; some callers hold a string) — the dock compares by
// string. Pass null when the screen has no single player subject (the call becomes a no-op).

import { useEffect } from "react";
import { useCrmConversation } from "@/lib/crmConversation";

export function useDockSubject(
  playerId: string | number | null | undefined,
  label?: string | null,
  snippets?: string[],
): void {
  const { setDockSubject } = useCrmConversation();
  const pid = playerId ?? null;
  const lbl = label ?? null;
  // Key the effect on a stable string (and reconstruct from it) so a fresh array literal each render
  // doesn't re-fire, and multi-word lines survive intact.
  const snipKey = snippets && snippets.length ? JSON.stringify(snippets) : "";
  useEffect(() => {
    setDockSubject({
      playerId: pid,
      label: lbl,
      snippets: snipKey ? (JSON.parse(snipKey) as string[]) : undefined,
    });
    return () => setDockSubject(null);
  }, [pid, lbl, snipKey, setDockSubject]);
}
