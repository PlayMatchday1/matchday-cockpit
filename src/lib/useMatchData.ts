"use client";

// Match data hook. Reads from mdapi_matches + mdapi_match_players via
// the shared mdapiMatchesRead lib. Replaces the older path that read
// from match_registrations populated by CSV upload via data_uploads.
//
// The CSV upload path still writes match_registrations (Phase 5d will
// remove the uploader) but those writes are no longer read.
//
// MatchRow shape is preserved exactly for backward-compat with the
// 13 components / 5 lib files that consume it. The shared lib
// produces JoinedMatchPlayerRow which is a structural superset of
// MatchRow — TypeScript covariance lets us assign directly.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import {
  fetchJoinedMatchPlayers,
  type JoinedMatchPlayerRow,
} from "./mdapiMatchesRead";

// Re-export MatchRow for any consumer that imports it from here.
export type { MatchRow } from "./mdapiMatchesRead";

export type DataMeta = {
  filename: string;
  uploadedAt: Date;
  rowCount: number;
  earliestMatch: Date;
  latestMatch: Date;
} | null;

type State = {
  rows: JoinedMatchPlayerRow[];
  meta: DataMeta;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { rows: [], meta: null, loading: true, error: null };

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

async function load(): Promise<void> {
  publish({ rows: [], meta: null, loading: true, error: null });

  let rows: JoinedMatchPlayerRow[];
  let lastSyncCompletedAt: string | null = null;
  try {
    const [rowsResult, lastSyncResult] = await Promise.all([
      fetchJoinedMatchPlayers(supabase),
      // Latest mdapi-matches sync completion — drives meta.uploadedAt.
      // Will be populated by the cron orchestrator in Phase 5c. Until
      // then, the manual backfill/incremental scripts also write to
      // fin_sync_log (or will, once they're wired through runWithLog).
      // Falls back to "now" if no row yet (first-run startup window).
      supabase
        .from("fin_sync_log")
        .select("completed_at")
        .eq("source", "mdapi-matches")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ completed_at: string }>(),
    ]);
    rows = rowsResult;
    lastSyncCompletedAt = lastSyncResult.data?.completed_at ?? null;
  } catch (e) {
    publish({
      rows: [],
      meta: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load match data.",
    });
    return;
  }

  // Rows are pre-sorted by matchStart asc inside the shared lib, so
  // first/last give the date range.
  const earliestMatch = rows[0]?.matchStart ?? new Date();
  const latestMatch = rows[rows.length - 1]?.matchStart ?? new Date();

  publish({
    rows,
    meta: {
      filename: "MatchDay API",
      uploadedAt: lastSyncCompletedAt
        ? new Date(lastSyncCompletedAt)
        : new Date(),
      rowCount: rows.length,
      earliestMatch,
      latestMatch,
    },
    loading: false,
    error: null,
  });
}

export function useMatchData(): State {
  const [s, setS] = useState<State>(cached ?? INITIAL);

  useEffect(() => {
    subscribers.add(setS);
    if (cached) {
      setS(cached);
    } else if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    return () => {
      subscribers.delete(setS);
    };
  }, []);

  return s;
}

export async function refetchMatchData(): Promise<void> {
  await load();
}
