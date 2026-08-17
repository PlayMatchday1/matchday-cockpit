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
import { cityToAbbr } from "./cityMap";
import {
  fetchJoinedMatchPlayers,
  type JoinedMatchPlayerRow,
  type ScheduledMatch,
} from "./mdapiMatchesRead";

// Re-export MatchRow + ScheduledMatch for consumers that import from here.
export type { MatchRow, ScheduledMatch } from "./mdapiMatchesRead";

export type DataMeta = {
  filename: string;
  uploadedAt: Date;
  rowCount: number;
  earliestMatch: Date;
  latestMatch: Date;
} | null;

type State = {
  rows: JoinedMatchPlayerRow[];
  // Per-distinct-match view, complete inside the query window
  // (includes matches with zero player rows). Use this — not `rows` —
  // for any "matches scheduled in week X" / run-rate / cancel-rate
  // denominator so empty/unbooked matches don't silently drop out.
  scheduledMatches: ScheduledMatch[];
  meta: DataMeta;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = {
  rows: [],
  scheduledMatches: [],
  meta: null,
  loading: true,
  error: null,
};

// Forward bound for all match-data fetches. Open-ended forward queries
// scale with the schedule's expanding tail (matches scheduled months
// ahead) instead of the user's window of interest. Cap at "now + 14
// days" so the payload stays predictable AND we still cover the rest
// of the current ISO week + the entire next ISO week (which the user
// might be planning against). Updated lazily per call — fine because
// the hooks read this at fetch time, not at module load.
const FORWARD_BOUND_DAYS = 14;
function forwardBoundIso(now: Date = new Date()): string {
  const d = new Date(now.getTime() + FORWARD_BOUND_DAYS * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

let cached: State | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

async function load(): Promise<void> {
  publish({
    rows: [],
    scheduledMatches: [],
    meta: null,
    loading: true,
    error: null,
  });

  let rows: JoinedMatchPlayerRow[];
  let scheduledMatches: ScheduledMatch[];
  let lastSyncCompletedAt: string | null = null;
  try {
    const [rowsResult, lastSyncResult] = await Promise.all([
      fetchJoinedMatchPlayers(supabase, { toDate: forwardBoundIso() }),
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
    rows = rowsResult.rows;
    scheduledMatches = rowsResult.scheduledMatches;
    lastSyncCompletedAt = lastSyncResult.data?.completed_at ?? null;
  } catch (e) {
    publish({
      rows: [],
      scheduledMatches: [],
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
    scheduledMatches,
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

// Cache key shape: `${weeks}|${cityOrAll}` — e.g. "12|" for the
// network-wide /cities page, "12|ATX" for /cities/austin. Per-city
// entries live alongside the network-wide one; no cross-pollution
// because the keys differ. Navigating /cities → /cities/austin →
// /cities triggers (at most) one network-wide fetch and one ATX
// fetch, both then cached independently.
function windowKey(weeks: number, city: string | null | undefined): string {
  return `${weeks}|${city ?? ""}`;
}

// RANGE KEY. An explicit from/to pair is the real cache identity; the weeks variant resolves to
// one of these. Two components asking for the same range share one fetch.
function rangeKey(fromDate: string, toDate: string, city: string | null | undefined): string {
  return `r|${fromDate}|${toDate}|${city ?? ""}`;
}

const windowedCache = new Map<string, State>();
const windowedPending = new Map<string, Promise<void>>();
const windowedSubs = new Map<string, Set<(s: State) => void>>();

function publishWindow(key: string, s: State) {
  windowedCache.set(key, s);
  windowedSubs.get(key)?.forEach((fn) => fn(s));
}

async function loadRange(
  key: string,
  fromDate: string,
  toDate: string,
  city: string | null,
): Promise<void> {
  publishWindow(key, {
    rows: [],
    scheduledMatches: [],
    meta: null,
    loading: true,
    error: null,
  });

  let rows: JoinedMatchPlayerRow[];
  let scheduledMatches: ScheduledMatch[];
  let lastSyncCompletedAt: string | null = null;
  try {
    const [rowsResult, lastSyncResult] = await Promise.all([
      fetchJoinedMatchPlayers(supabase, {
        fromDate,
        toDate,
        cityIdentifier: city ?? undefined,
      }),
      supabase
        .from("fin_sync_log")
        .select("completed_at")
        .eq("source", "mdapi-matches")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ completed_at: string }>(),
    ]);
    rows = rowsResult.rows;
    scheduledMatches = rowsResult.scheduledMatches;
    lastSyncCompletedAt = lastSyncResult.data?.completed_at ?? null;
  } catch (e) {
    publishWindow(key, {
      rows: [],
      scheduledMatches: [],
      meta: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load match data.",
    });
    return;
  }

  const earliestMatch = rows[0]?.matchStart ?? new Date();
  const latestMatch = rows[rows.length - 1]?.matchStart ?? new Date();

  publishWindow(key, {
    rows,
    scheduledMatches,
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

// Network-wide variant: useMatchWindowData(12). Per-city variant:
// useMatchWindowData(12, "ATX"). The two share cache entries by key
// (weeks + cityIdentifier), so /cities and /cities/[city] never
// step on each other.
export function useMatchWindowData(
  weeks: number,
  city: string | null = null,
): State {
  // Pad the window edge by 14 days so MTD calcs (current-month cancellation rate, in-progress
  // weeks) never miss matches that landed just before the strict cutoff.
  const fromDate = new Date(Date.now() - (weeks * 7 + 14) * 86400_000).toISOString().slice(0, 10);
  return useMatchRangeData(fromDate, forwardBoundIso(), city);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE RANGE HOOK — the one every windowed consumer should use.
//
// WHY IT EXISTS. useMatchData() fetches mdapi_match_players UNFILTERED. That table is ~203,000
// rows and selectAll pages it at 1,000, so a single view of Finance › Cities cost 280 REST
// round-trips re-materialising the whole table. Growth and Match Ops cost 3, because they read
// server-side aggregates. That difference was the database load, not the instance size.
//
// WHY A RANGE AND NOT A WEEK COUNT. useMatchWindowData(12) hardcodes a constant whose comment says
// "12 weeks ≈ ~12k rows" — written when the table held 38k. It holds 203k now, and a constant like
// that goes stale silently. A range is bounded by an operator's choice instead: Finance passes the
// period control's own window.
//
// EACH CALLER DECLARES ITS OWN WIDENING. Several components legitimately need more than the
// selected period — Period Compare spans five months, Field Ranking reconciles lump billing across
// a quarter. Those widenings are properties of the component and are stated at each call site, NOT
// collapsed into a shared constant, because a shared constant is how one component's need silently
// becomes another's ceiling.
//
// A NARROWED WINDOW IS A CORRECTNESS CHANGE, not just a speed one: rows outside it are absent, not
// slow. That is why nothing here picks a default — omitting the range is not an option the type
// allows.
export function useMatchRangeData(
  fromDate: string,
  toDate: string,
  city: string | null = null,
): State {
  const cityIdentifier = cityToAbbr(city);
  const key = rangeKey(fromDate, toDate, cityIdentifier);
  const [s, setS] = useState<State>(windowedCache.get(key) ?? INITIAL);

  useEffect(() => {
    let subs = windowedSubs.get(key);
    if (!subs) {
      subs = new Set();
      windowedSubs.set(key, subs);
    }
    subs.add(setS);

    const cached = windowedCache.get(key);
    if (cached) {
      setS(cached);
    } else if (!windowedPending.has(key)) {
      const p = loadRange(key, fromDate, toDate, cityIdentifier).finally(() => {
        windowedPending.delete(key);
      });
      windowedPending.set(key, p);
    }

    return () => {
      subs?.delete(setS);
    };
  }, [key, fromDate, toDate, cityIdentifier]);

  return s;
}
