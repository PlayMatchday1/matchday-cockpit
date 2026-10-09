// Sync now — the state the Locations page's button reads, and the gate the manual trigger enforces.
// Server-only. Reads player_area_sync_runs (Supabase); never MatchDay.
//
// THE COOLDOWN IS ENFORCED HERE, ON THE SERVER (Ryan, 2026-10-08): a manual run is refused while
// any run is in progress, and for 30 minutes after the last run STARTED — cron or manual. The
// cron path itself is exempt (its schedule is fixed at every 6 hours); the run lock in
// playerAreaSync.ts still stops a cron run and a manual one from overlapping.

import type { SupabaseClient } from "@supabase/supabase-js";
import { LOCK_WINDOW_MS, PAGE_LIMIT } from "./playerAreaSync";

export const MANUAL_COOLDOWN_MS = 30 * 60 * 1000;

/* PAUSED (Ryan, 2026-10-08, after the 00:40 UTC run hit a 503 on page 113 — the third MatchDay outage
 * of the day during a full walk). Nothing runs, cron or manual, until the gentler resumable walk
 * ships (50 per page, 2s apart, health checks, no evening runs). The cron is also out of vercel.json.
 * Set to null to lift. */
export const SYNC_PAUSED: string | null =
  "Paused while the location sync is rebuilt to go easier on the MatchDay API. It will restart on a gentler schedule.";

type RunRow = {
  id: number; started_at: string; finished_at: string | null; ok: boolean | null; triggered_by: string;
  error: string | null; rows_inserted: number | null; rows_updated: number | null;
  api_calls: number | null; players_total: number | null;
};

export type SyncStatus = {
  now: string;
  running: { runId: number; startedAt: string; triggeredBy: string; pagesDone: number; pagesTotal: number | null } | null;
  last: { runId: number; startedAt: string; finishedAt: string; ok: boolean; triggeredBy: string;
    error: string | null; rowsInserted: number; rowsUpdated: number } | null;
  /** When a manual run may start again; null = now. */
  availableAt: string | null;
  /** Why no run may start at all; null = not paused. */
  paused: string | null;
};

export async function readSyncStatus(sb: SupabaseClient, now = new Date()): Promise<SyncStatus> {
  const { data, error } = await sb.from("player_area_sync_runs")
    .select("id,started_at,finished_at,ok,triggered_by,error,rows_inserted,rows_updated,api_calls,players_total")
    .order("id", { ascending: false }).limit(10);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as RunRow[];
  const t = now.getTime();

  // Unfinished and inside the lock window = in progress. Older unfinished = a killed run.
  const live = rows.find((r) => r.finished_at == null && t - Date.parse(r.started_at) < LOCK_WINDOW_MS) ?? null;
  const done = rows.find((r) => r.finished_at != null) ?? null;
  const latestStart = rows[0] ? Date.parse(rows[0].started_at) : null;
  const until = latestStart != null ? latestStart + MANUAL_COOLDOWN_MS : null;

  return {
    now: now.toISOString(),
    running: live ? {
      runId: live.id, startedAt: live.started_at, triggeredBy: live.triggered_by,
      pagesDone: live.api_calls ?? 0,
      pagesTotal: live.players_total ? Math.ceil(live.players_total / PAGE_LIMIT) : null,
    } : null,
    last: done ? {
      runId: done.id, startedAt: done.started_at, finishedAt: done.finished_at!, ok: done.ok === true,
      triggeredBy: done.triggered_by, error: done.error,
      rowsInserted: done.rows_inserted ?? 0, rowsUpdated: done.rows_updated ?? 0,
    } : null,
    availableAt: live ? null : until != null && until > t ? new Date(until).toISOString() : null,
    paused: SYNC_PAUSED,
  };
}
