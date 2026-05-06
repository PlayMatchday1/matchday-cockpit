// Shared "run a sync function with start/end fin_sync_log rows"
// helper. Used by /api/sync/cron (all three sources) and by the
// per-source manual endpoints (/api/sync/reviews, /api/sync/subscriptions).
//
// /api/sync/stripe keeps its own inline logging code — same pattern,
// just not extracted yet. Don't-touch-what-works applies.
//
// The helper inserts a fin_sync_log row at start (so a crash mid-sync
// still leaves a "started but never completed" trace), runs the sync
// function, and stamps the row with results or error_message.
// Returns a discriminated union so callers can build a typed response
// without re-throwing.

import type { SupabaseClient } from "@supabase/supabase-js";

export type TriggeredBy = "manual" | "cron";

export type SourceName =
  | "stripe-api"
  | "mdapi-reviews"
  | "mdapi-subscriptions"
  | "membership-snapshots";

// fin_sync_log columns the orchestrator/manual routes write on
// success. Stripe-specific columns (charges_*) stay null for mdapi
// syncs.
export type LogPatch = Partial<{
  rows_imported: number;
  rows_replaced: number;
  charges_fetched: number;
  charges_succeeded: number;
  charges_skipped: number;
}>;

export type RunResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

export async function runWithLog<T>(
  source: SourceName,
  triggeredBy: TriggeredBy,
  supabase: SupabaseClient,
  fn: (sb: SupabaseClient) => Promise<T>,
  toLogPatch: (result: T) => LogPatch,
): Promise<RunResult<T>> {
  // Insert log row at start so a crash mid-sync still leaves a trace
  // (started_at set, completed_at + error_message stay null).
  const { data: logInsert, error: logErr } = await supabase
    .from("fin_sync_log")
    .insert({
      source,
      triggered_by: triggeredBy,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (logErr || !logInsert) {
    return {
      ok: false,
      error: `Failed to create sync log row for ${source}: ${logErr?.message ?? "unknown"}`,
    };
  }
  const logId = logInsert.id as string;

  try {
    const result = await fn(supabase);
    const patch = toLogPatch(result);
    const { error: updateErr } = await supabase
      .from("fin_sync_log")
      .update({ completed_at: new Date().toISOString(), ...patch })
      .eq("id", logId);
    if (updateErr) {
      // Log-update failure is non-fatal — the sync itself succeeded.
      console.warn(
        `fin_sync_log update failed for ${source}/${logId}:`,
        updateErr.message,
      );
    }
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { error: updateErr } = await supabase
      .from("fin_sync_log")
      .update({
        completed_at: new Date().toISOString(),
        error_message: msg,
      })
      .eq("id", logId);
    if (updateErr) {
      console.warn(
        `fin_sync_log error-update failed for ${source}/${logId}:`,
        updateErr.message,
      );
    }
    return { ok: false, error: msg };
  }
}
