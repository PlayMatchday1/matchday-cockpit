"use client";

// Card counts per roadmap board, for the Tech sidebar badges. There is now ONE
// rail (the section sidebar) that both navigates and shows how many cards are in
// each board — so the count lives here, read by the layout. Counts change only
// on create/delete (a move changes stage, not board), which is rare, so a fetch
// on mount + window focus is enough; no polling.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { canAccess, useAuth } from "@/lib/useAuth";

export type RoadmapBoardCounts = { app: number; clubhouse: number };

export function useRoadmapBoardCounts(): RoadmapBoardCounts {
  const { appUser } = useAuth();
  const enabled = canAccess(appUser ?? null, "tech");
  const [counts, setCounts] = useState<RoadmapBoardCounts>({ app: 0, clubhouse: 0 });

  const refetch = useCallback(async () => {
    if (!enabled) return;
    try {
      const { data, error } = await supabase
        .from("kanban_cards")
        .select("board")
        .eq("board_type", "tech_roadmap");
      if (error || !data) return;
      const c = { app: 0, clubhouse: 0 };
      for (const r of data as { board: string | null }[]) {
        if (r.board === "clubhouse") c.clubhouse++;
        else c.app++; // null/'app' → App (the default board)
      }
      setCounts(c);
    } catch {
      // keep last value silently
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refetch();
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, refetch]);

  return counts;
}
