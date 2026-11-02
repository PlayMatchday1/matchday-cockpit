// ONE SCHEDULED SYNC JOB: a few steps run in order inside one function, each through runWithLog
// (start, rows, completion time so duration, error), under a time budget (Ryan, 2026-11-02).
//
// The daily /api/sync/cron ran every step in one 300s function, and when it slowed the platform
// killed it mid-step: the step that was running never completed and every step after it never
// started, so neither left a word in fin_sync_log. Here nothing goes unsaid:
//
//   SKIPPED   a step reached with the budget spent, or after an earlier step was cut off, writes a
//             completed row "Skipped: <why>" and does not run.
//   CUT OFF   a step still running when the budget runs out is left behind, and the job writes a row
//             "Cut off: <source> still running after Ns" before it answers, inside the limit.
//   KILLED    should the platform end the function anyway, the step's own row stays without a
//             completion; the hourly watchdog (lib/syncWatchdog.ts) marks such rows "Cut off".
//
// Jobs are sized to use about half their limit (vercel.json schedules them apart).

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { runWithLog, syncLogWritable, type LogPatch, type RunResult, type SourceName, type TriggeredBy } from "./syncLogging";

export type SyncJob = {
  supabase: SupabaseClient;
  triggeredBy: TriggeredBy;
  elapsedMs: () => number;
  /** Runs one step through runWithLog unless the job has to stop; see the header. */
  step: <T>(source: SourceName, fn: (sb: SupabaseClient) => Promise<T>, toPatch: (r: T) => LogPatch) => Promise<RunResult<T>>;
  /** Steps that did not run or did not finish, and why. */
  notRun: { source: SourceName; why: string }[];
};

const same = (a: string, b: string) => { const ab = Buffer.from(a), bb = Buffer.from(b); return ab.length === bb.length && timingSafeEqual(ab, bb); };

/** CRON_SECRET only (the scheduled call). Service role client. A Response when refused. */
export function cronClient(req: Request): { supabase: SupabaseClient } | Response {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const secret = process.env.CRON_SECRET;
  if (!(token && secret && same(token, secret))) return Response.json({ error: "Not allowed." }, { status: 401 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  return { supabase: createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) };
}

/** A completed fin_sync_log row that only says something (a skip or a cut off). */
export async function logLine(sb: SupabaseClient, source: SourceName, triggeredBy: TriggeredBy, message: string): Promise<void> {
  console.warn(`[sync-job] ${source}: ${message}`);
  if (!syncLogWritable()) return;
  const now = new Date().toISOString();
  const { error } = await sb.from("fin_sync_log").insert({ source, triggered_by: triggeredBy, started_at: now, completed_at: now, error_message: message.slice(0, 500) });
  if (error) console.warn(`[sync-job] log line for ${source} failed: ${error.message}`);
}

/**
 * limitMs is the route's maxDuration; safetyMs is kept back to write the last rows and answer.
 */
export function syncJob(supabase: SupabaseClient, triggeredBy: TriggeredBy, limitMs: number, safetyMs = 25_000): SyncJob {
  const startedAt = Date.now();
  const elapsedMs = () => Date.now() - startedAt;
  const leftMs = () => limitMs - safetyMs - elapsedMs();
  const notRun: SyncJob["notRun"] = [];
  let stopped: string | null = null;

  async function step<T>(source: SourceName, fn: (sb: SupabaseClient) => Promise<T>, toPatch: (r: T) => LogPatch): Promise<RunResult<T>> {
    if (!stopped && leftMs() <= 0) stopped = `job budget exhausted (${Math.round(elapsedMs() / 1000)}s of ${limitMs / 1000}s used before this step)`;
    if (stopped) {
      const why = `Skipped: ${stopped}`;
      notRun.push({ source, why });
      await logLine(supabase, source, triggeredBy, why);
      return { ok: false, error: why };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"cut">((res) => { timer = setTimeout(() => res("cut"), Math.max(0, leftMs())); });
    const r = await Promise.race([runWithLog(source, triggeredBy, supabase, fn, toPatch), deadline]);
    clearTimeout(timer);
    if (r === "cut") {
      const why = `Cut off: ${source} still running after ${Math.round(elapsedMs() / 1000)}s; the job stopped before its ${limitMs / 1000}s limit`;
      stopped = `${source} was cut off before this step`;
      notRun.push({ source, why });
      await logLine(supabase, source, triggeredBy, why);
      return { ok: false, error: why };
    }
    return r;
  }

  return { supabase, triggeredBy, elapsedMs, step, notRun };
}
