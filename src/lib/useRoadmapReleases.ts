"use client";

// Releases for one roadmap board (kanban_releases, migration 0225). Same pattern as useKanbanBoard:
// straight to Supabase from the client, gated by the 0225 RLS policy (the same predicate as the
// cards), reload on mount and on window focus. An update sends only the fields that changed.

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { RoadmapBoard } from "@/lib/kanban";
import type { Release } from "@/lib/roadmapReleases";

export type ReleaseInput = Pick<Release, "version" | "name" | "starts_on" | "out_by">;

export function useRoadmapReleases(board: RoadmapBoard) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await supabase.from("kanban_releases").select("*").eq("board", board);
    if (res.error) setError(res.error.message);
    else { setError(null); setReleases((res.data ?? []) as Release[]); }
    setLoading(false);
  }, [board]);

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    void reload();
    const onFocus = () => void reloadRef.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  /** Resolves to an error message, or null when the row landed. */
  const createRelease = useCallback(async (input: ReleaseInput): Promise<string | null> => {
    const ins = await supabase.from("kanban_releases").insert({ board, ...input }).select("*").single();
    if (ins.error || !ins.data) return friendly(ins.error?.message ?? "Could not create the release");
    setReleases((prev) => [...prev, ins.data as Release]);
    return null;
  }, [board]);

  const updateRelease = useCallback(async (id: string, patch: Partial<ReleaseInput>): Promise<string | null> => {
    if (Object.keys(patch).length === 0) return null;
    const upd = await supabase.from("kanban_releases").update(patch).eq("id", id).select("*").single();
    if (upd.error || !upd.data) { void reload(); return friendly(upd.error?.message ?? "Could not save the release"); }
    setReleases((prev) => prev.map((r) => (r.id === id ? (upd.data as Release) : r)));
    return null;
  }, [reload]);

  return { releases, loading, error, reload, createRelease, updateRelease };
}

// The two constraint failures a person can cause, in words they can act on.
function friendly(msg: string): string {
  if (/kanban_releases_board_version_key/.test(msg)) return "That version is already used on this roadmap.";
  if (/kanban_releases_dates/.test(msg)) return "The out by date has to be on or after the start.";
  return msg;
}
