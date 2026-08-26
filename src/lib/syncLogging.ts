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
  | "mdapi-promocodes"
  | "mdapi-matches"
  | "mdapi-users"
  // The DAILY FULL re-sync, distinct from the incremental walk above. Separate because it touches
  // ~30,700 rows to the walk's ~150 and exists to catch EDITS the walk cannot see. Added to the DB
  // CHECK by migration 0149 — runWithLog will not run the sync at all until that is applied.
  | "mdapi-users-full"
  | "mdapi-users-lens-snapshot"
  // Meta ad spend, daily. Added to the DB CHECK by migration 0151 — runWithLog will not run the
  // sync at all until that is applied, and the route 503s saying so rather than reporting success.
  | "meta-ad-spend"
  // playmatchday.com form submissions. Added to the DB CHECK by migration 0153 — runWithLog will
  // not run the sync at all until that is applied, and the route 503s saying so.
  | "wp-submissions"
  | "membership-snapshots"
  | "membership-prices"
  | "manager-pay-recompute"
  | "firstmatch-ledger"
  | "telnyx-sms"
  | "play-installs"
  | "app-store-installs"
  | "google-calendar";

// fin_sync_log columns the orchestrator/manual routes write on
// success. Stripe-specific columns (charges_*) stay null for mdapi
// syncs.
//
// error_message is included here (not just on the throw path) so a step
// that SUCCEEDS but ran in a degraded/less-complete mode can surface a
// visible advisory in Recent Syncs without failing the run. The cron's
// anyFailed gate keys off ok (the throw/catch), never error_message, so
// an advisory on a completed row does not flip the HTTP status.
export type LogPatch = Partial<{
  rows_imported: number;
  rows_replaced: number;
  rows_soft_deleted: number;
  charges_fetched: number;
  charges_succeeded: number;
  charges_skipped: number;
  error_message: string;
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

  // THE COMPLETION STAMP IS IN A `finally`. Previously it lived on both the happy path and the
  // catch, which is the same thing only while every exit goes through one of those two — a future
  // early `return` inside the try would have left a started-but-never-completed row that reads
  // identically to a crash. A row that never completes is indistinguishable from a step that ran
  // clean, and that ambiguity is what let a frozen sync sit unnoticed for eight days.
  let outcome: "ok" | "failed" = "failed";
  let patch: LogPatch = {};
  let out: RunResult<T>;
  try {
    const result = await fn(supabase);
    patch = toLogPatch(result);
    outcome = "ok";
    out = { ok: true, result };
  } catch (e) {
    // The error CLASS as well as the message — "TypeError: x is not a function" tells you where to
    // look; the message alone often does not. NEVER a token or credential: the message is whatever
    // the sync lib threw, and those libs throw sanitized text by contract (see calendarSync).
    const cls = e instanceof Error ? e.constructor.name : typeof e;
    const msg = e instanceof Error ? e.message : String(e);
    patch = { error_message: `${cls}: ${msg}`.slice(0, 500) };
    out = { ok: false, error: `${cls}: ${msg}` };
  } finally {
    const { error: updateErr } = await supabase
      .from("fin_sync_log")
      .update({ completed_at: new Date().toISOString(), ...patch })
      .eq("id", logId);
    if (updateErr) {
      // Non-fatal either way: the sync's own outcome is not changed by a logging failure.
      console.warn(`fin_sync_log ${outcome}-update failed for ${source}/${logId}:`, updateErr.message);
    }
  }
  return out!;
}
