// POST /api/sync/cron — orchestrator that runs all three daily syncs
// (Stripe charges, mdapi_reviews, mdapi_subscriptions) sequentially
// with per-source error isolation.
//
// Each sync gets its own fin_sync_log row. A throw in one wrapper
// does NOT prevent the others from running. HTTP status: 200 if all
// three succeed, 500 if any failed (Vercel cron monitoring surfaces
// non-2xx as a failed cron — operator gets visibility on partial
// failures even when 2/3 succeed).
//
// Auth: same dual-mode pattern as /api/sync/stripe.
//   Cron mode:   Bearer ${CRON_SECRET} (constant-time compare),
//                service-role supabase client.
//   Manual mode: Bearer <user-session-token>, session-scoped client.
// Manual mode lets operators curl this endpoint to verify end-to-end
// before relying on the scheduled trigger.
//
// Why direct lib calls instead of HTTP fan-out to per-source
// endpoints? Same process, no extra latency, single timeout budget.
// Vercel Hobby tier has 1 cron slot/day; this is the only daily
// run. Per-source manual sync endpoints land in Phase 2.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { commitStripe } from "@/lib/financeImport";
import { syncStripeCharges } from "@/lib/stripeSync";
import { syncMdapiReviews } from "@/lib/mdapiReviewsSync";
import { syncMdapiSubscriptions } from "@/lib/mdapiSubscriptionsSync";

// Stripe ~60s + mdapi_reviews ~10s + mdapi_subscriptions ~60s typical.
// 300s gives ~2× headroom; if we ever hit it, the right answer is
// async-trigger pattern, not just bumping the cap further.
export const maxDuration = 300;
export const runtime = "nodejs";

type TriggeredBy = "manual" | "cron";
type SourceName = "stripe-api" | "mdapi-reviews" | "mdapi-subscriptions";

// fin_sync_log columns the orchestrator writes on success. Stripe-
// specific columns (charges_*) stay null for mdapi syncs.
type LogPatch = Partial<{
  rows_imported: number;
  rows_replaced: number;
  charges_fetched: number;
  charges_succeeded: number;
  charges_skipped: number;
}>;

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Default Stripe-sync window start. Mirrors /api/sync/stripe's
// implementation; intentionally duplicated rather than extracted, so
// the orchestrator's defaults can drift independently from the
// manual route if we ever want them to.
async function defaultStripeSince(supabase: SupabaseClient): Promise<Date> {
  const { data } = await supabase
    .from("fin_revenue")
    .select("date")
    .eq("source", "Stripe")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle<{ date: string }>();
  if (!data?.date) {
    const fallback = new Date();
    fallback.setUTCDate(fallback.getUTCDate() - 30);
    return fallback;
  }
  return new Date(`${data.date}T00:00:00Z`);
}

// Stripe's full pipeline (sync + commit). Returns enough info to
// populate the Stripe-specific log columns.
async function runStripeSync(supabase: SupabaseClient) {
  const since = await defaultStripeSince(supabase);
  const sync = await syncStripeCharges(supabase, { since, until: new Date() });
  let rowsReplaced = 0;
  if (sync.rows.length > 0 && sync.earliestDate && sync.latestDate) {
    const result = await commitStripe(
      {
        rows: sync.rows,
        earliestDate: sync.earliestDate,
        latestDate: sync.latestDate,
      },
      supabase,
    );
    rowsReplaced = result.rowsReplaced ?? 0;
  }
  return { ...sync, rowsReplaced };
}

type RunResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

async function runWithLog<T>(
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

export async function POST(req: Request) {
  const startedAt = Date.now();

  // --- Auth: bearer, dual-mode (matches /api/sync/stripe) ---
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return Response.json(
      { error: "Missing Authorization header" },
      { status: 401 },
    );
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    return Response.json({ error: "Empty bearer token" }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  let supabase: SupabaseClient;

  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return Response.json(
        { error: "SUPABASE_SERVICE_ROLE_KEY is not set" },
        { status: 500 },
      );
    }
    supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } else {
    triggeredBy = "manual";
    supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }

  // --- Run all three syncs sequentially with per-source isolation ---
  const stripeResult = await runWithLog(
    "stripe-api",
    triggeredBy,
    supabase,
    runStripeSync,
    (r) => ({
      rows_imported: r.rows.length,
      rows_replaced: r.rowsReplaced,
      charges_fetched: r.totalCharges,
      charges_succeeded: r.paidRows,
      charges_skipped: r.skippedNonPaid + r.skippedNonUsd,
    }),
  );

  const reviewsResult = await runWithLog(
    "mdapi-reviews",
    triggeredBy,
    supabase,
    syncMdapiReviews,
    (r) => ({ rows_imported: r.upserted }),
  );

  const subscriptionsResult = await runWithLog(
    "mdapi-subscriptions",
    triggeredBy,
    supabase,
    syncMdapiSubscriptions,
    (r) => ({ rows_imported: r.upserted }),
  );

  const anyFailed =
    !stripeResult.ok || !reviewsResult.ok || !subscriptionsResult.ok;

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      results: {
        stripe: stripeResult,
        mdapi_reviews: reviewsResult,
        mdapi_subscriptions: subscriptionsResult,
      },
    },
    { status: anyFailed ? 500 : 200 },
  );
}
