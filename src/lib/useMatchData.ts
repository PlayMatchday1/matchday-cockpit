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

// =====================================================================
// Windowed variant — sibling of useMatchData, used by /cities to avoid
// pulling all ~38k mdapi_match_players rows on hydration.
//
// fetchJoinedMatchPlayers applies fromDate as a Postgres `start_date >=`
// predicate, so the row reduction happens server-side, not after a 15s
// download. 12 weeks ≈ ~6k matches, ~12k players — one paginated round
// trip on the matches side, ~3 IN-chunks on the players side.
//
// Each window size has its own singleton cache so two components calling
// useMatchWindowData(12) share one fetch. Anchored at "now" — currently
// stable enough across hydration that we don't need to revalidate when
// the date crosses midnight.
// =====================================================================

const windowedCache = new Map<number, State>();
const windowedPending = new Map<number, Promise<void>>();
const windowedSubs = new Map<number, Set<(s: State) => void>>();

function publishWindow(weeks: number, s: State) {
  windowedCache.set(weeks, s);
  windowedSubs.get(weeks)?.forEach((fn) => fn(s));
}

async function loadWindow(weeks: number): Promise<void> {
  publishWindow(weeks, { rows: [], meta: null, loading: true, error: null });

  // Pad the window edge by 14 days so MTD calcs (current-month
  // cancellation rate, in-progress weeks) never miss matches that
  // landed just before the strict 12-week cutoff.
  const fromMs = Date.now() - (weeks * 7 + 14) * 86400 * 1000;
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);

  let rows: JoinedMatchPlayerRow[];
  let lastSyncCompletedAt: string | null = null;
  try {
    const [rowsResult, lastSyncResult] = await Promise.all([
      fetchJoinedMatchPlayers(supabase, { fromDate }),
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
    publishWindow(weeks, {
      rows: [],
      meta: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load match data.",
    });
    return;
  }

  const earliestMatch = rows[0]?.matchStart ?? new Date();
  const latestMatch = rows[rows.length - 1]?.matchStart ?? new Date();

  publishWindow(weeks, {
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

export function useMatchWindowData(weeks: number): State {
  const [s, setS] = useState<State>(windowedCache.get(weeks) ?? INITIAL);

  useEffect(() => {
    let subs = windowedSubs.get(weeks);
    if (!subs) {
      subs = new Set();
      windowedSubs.set(weeks, subs);
    }
    subs.add(setS);

    const cached = windowedCache.get(weeks);
    if (cached) {
      setS(cached);
    } else if (!windowedPending.has(weeks)) {
      const p = loadWindow(weeks).finally(() => {
        windowedPending.delete(weeks);
      });
      windowedPending.set(weeks, p);
    }

    return () => {
      subs?.delete(setS);
    };
  }, [weeks]);

  return s;
}
