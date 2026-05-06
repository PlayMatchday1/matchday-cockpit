// POST /api/sync/cron — orchestrator that runs four daily steps:
// Stripe charges, mdapi_reviews, mdapi_subscriptions, and a
// membership snapshot refresh — sequentially, with per-source error
// isolation.
//
// The snapshot refresh consumes mdapi_subscriptions, so it only
// runs if that sync succeeded. If subs fail, the snapshot step is
// skipped (a fin_sync_log row is still written for visibility, with
// error_message explaining the skip).
//
// Each step gets its own fin_sync_log row. A throw in one wrapper
// does NOT prevent the others from running. HTTP status: 200 if all
// four succeed, 500 if any failed (Vercel cron monitoring surfaces
// non-2xx as a failed cron — operator gets visibility on partial
// failures even when 3/4 succeed).
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
import { refreshMembershipSnapshots } from "@/lib/membershipSnapshots";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// Stripe ~60s + mdapi_reviews ~10s + mdapi_subscriptions ~60s +
// snapshot refresh ~2s. 300s gives ~2× headroom; if we ever hit
// it, the right answer is async-trigger pattern, not just bumping
// the cap further.
export const maxDuration = 300;
export const runtime = "nodejs";

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

  // Snapshot refresh consumes mdapi_subscriptions data, so it only
  // runs if that sync succeeded. The throw-on-skip pattern lets
  // runWithLog handle the log row uniformly — error_message records
  // why the snapshot was skipped so it shows up in Recent Syncs.
  const snapshotResult = await runWithLog(
    "membership-snapshots",
    triggeredBy,
    supabase,
    async (sb) => {
      if (!subscriptionsResult.ok) {
        throw new Error(
          "Skipped: mdapi_subscriptions sync failed; snapshot needs fresh data",
        );
      }
      await refreshMembershipSnapshots({ client: sb, sourceFileName: "cron" });
    },
    // refreshMembershipSnapshots has no row counts to surface here —
    // it upserts members_monthly_snapshots in-place. The success
    // signal is the absence of an error_message on the log row.
    () => ({}),
  );

  const anyFailed =
    !stripeResult.ok ||
    !reviewsResult.ok ||
    !subscriptionsResult.ok ||
    !snapshotResult.ok;

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      results: {
        stripe: stripeResult,
        mdapi_reviews: reviewsResult,
        mdapi_subscriptions: subscriptionsResult,
        membership_snapshots: snapshotResult,
      },
    },
    { status: anyFailed ? 500 : 200 },
  );
}
