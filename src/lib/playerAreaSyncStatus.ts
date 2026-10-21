// Sync now — the state the button reads, and the gate the manual trigger enforces. Server-only.
// Reads player_area_sync_runs (Supabase); never MatchDay.
//
// SYNC NOW RUNS AN INCREMENTAL RUN since 2026-10-21 (Ryan: never a full pull during the day; the full
// pass is the 3 AM Central cron only). THE COOLDOWN IS ENFORCED HERE, ON THE SERVER: a manual run is
// refused while any run is in progress and for 10 minutes after the last run STARTED (cron or
// manual). An incremental run is one request on a normal hour, so the evening block does not apply
// to it; it still applies to the full pass (playerAreaSync.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import { isLive, type RunKind, type StopReason } from "./playerAreaSync";

export const MANUAL_COOLDOWN_MS = 10 * 60 * 1000;

/* A kill switch. null = running normally. When set, the route refuses cron and manual alike and the
 * button shows the reason. */
export const SYNC_PAUSED: string | null = null;

type RunRow = {
  id: number; started_at: string; finished_at: string | null; ok: boolean | null; triggered_by: string;
  error: string | null; rows_inserted: number | null; rows_updated: number | null;
  next_page: number | null; pages_total: number | null; heartbeat_at: string | null; stop_reason: StopReason | null;
  legs: number | null; api_calls: number | null; page_size: number | null; kind: RunKind; since: string | null;
};

/** One pass, for the sync history. pagesRead is null for passes from before 0218 (one call per page
 *  then, so api_calls stands in). */
export type RecentPass = {
  runId: number; startedAt: string; finishedAt: string | null; triggeredBy: string; ok: boolean | null;
  stopReason: StopReason | null; error: string | null; pagesRead: number | null; pagesTotal: number | null;
  pageSize: number | null; rowsInserted: number; rowsUpdated: number; live: boolean;
  kind: RunKind; since: string | null; apiCalls: number | null;
};

export type SyncStatus = {
  now: string;
  running: { runId: number; startedAt: string; triggeredBy: string; pagesDone: number; pagesTotal: number | null; legs: number; kind: RunKind } | null;
  last: { runId: number; startedAt: string; finishedAt: string; ok: boolean; triggeredBy: string;
    error: string | null; rowsInserted: number; rowsUpdated: number; stopReason: StopReason | null } | null;
  /** When a manual pass may start again; null = now. */
  availableAt: string | null;
  /** Why no pass may start right now (the evening block); null = it may. */
  blocked: string | null;
  /** Why no pass may start at all (the kill switch); null = not paused. */
  paused: string | null;
  /** The last 10 passes, newest first. */
  recent: RecentPass[];
};

export async function readSyncStatus(sb: SupabaseClient, now = new Date()): Promise<SyncStatus> {
  const { data, error } = await sb.from("player_area_sync_runs")
    .select("id,started_at,finished_at,ok,triggered_by,error,rows_inserted,rows_updated,next_page,pages_total,heartbeat_at,stop_reason,legs,api_calls,page_size,kind,since")
    .order("id", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as RunRow[];
  const t = now.getTime();

  const live = rows.find((r) => isLive(r, t)) ?? null;
  const done = rows.find((r) => r.finished_at != null) ?? null;
  const latestStart = rows[0] ? Date.parse(rows[0].started_at) : null;
  const until = latestStart != null ? latestStart + MANUAL_COOLDOWN_MS : null;

  return {
    now: now.toISOString(),
    running: live ? {
      runId: live.id, startedAt: live.started_at, triggeredBy: live.triggered_by,
      pagesDone: Math.max(0, (live.next_page ?? 1) - 1), pagesTotal: live.pages_total, legs: live.legs ?? 0, kind: live.kind,
    } : null,
    last: done ? {
      runId: done.id, startedAt: done.started_at, finishedAt: done.finished_at!, ok: done.ok === true,
      triggeredBy: done.triggered_by, error: done.error, stopReason: done.stop_reason,
      rowsInserted: done.rows_inserted ?? 0, rowsUpdated: done.rows_updated ?? 0,
    } : null,
    availableAt: live ? null : until != null && until > t ? new Date(until).toISOString() : null,
    blocked: null,
    paused: SYNC_PAUSED,
    recent: rows.map((r) => ({
      runId: r.id, startedAt: r.started_at, finishedAt: r.finished_at, triggeredBy: r.triggered_by, ok: r.ok,
      stopReason: r.stop_reason, error: r.error,
      pagesRead: r.page_size != null ? Math.max(0, (r.next_page ?? 1) - 1) : r.api_calls,
      pagesTotal: r.pages_total, pageSize: r.page_size,
      rowsInserted: r.rows_inserted ?? 0, rowsUpdated: r.rows_updated ?? 0, live: isLive(r, t),
      kind: r.kind, since: r.since, apiCalls: r.api_calls,
    })),
  };
}
