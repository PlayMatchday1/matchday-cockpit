// POST|GET /api/sync/cron: the daily 11:00 UTC job, since Nov 2, 2026 four short steps:
// stripe-api, google-calendar, mdapi-users, telnyx-sms (about 20s of its 300s). The slow steps run on
// their own schedules; the list and the reason are at the top of POST's body. Each step gets its own
// fin_sync_log row through lib/syncJob.ts. HTTP 200 if stripe, users and telnyx succeed, else 500.
//
// Auth: dual mode, as /api/sync/stripe.
//   Cron mode:   Bearer ${CRON_SECRET} (constant-time compare), service-role supabase client.
//   Manual mode: Bearer <user-session-token>, session-scoped client.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { commitStripe } from "@/lib/financeImport";
import { syncStripeCharges } from "@/lib/stripeSync";
import { syncMdapiUsers, mdapiUsersLogPatch } from "@/lib/mdapiUsersSync";
import { ingestTelnyxSms } from "@/lib/telnyxSmsIngest";
import { syncAllCalendars, CalendarConfigError } from "@/lib/calendarSync";
import { type TriggeredBy } from "@/lib/syncLogging";
import { syncJob } from "@/lib/syncJob";
import { refreshGrowthViews } from "@/lib/growthViews";
import { cronOnlyGet, refuseUnlessAdmin } from "@/lib/adminSession";

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

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
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
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
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
    const adminRefusal = await refuseUnlessAdmin(userData.user.email);
    if (adminRefusal) return adminRefusal;
  }

  // ── FOUR SHORT STEPS, ABOUT 20s (Ryan, 2026-11-02) ─────────────────────────────────────────────
  // This job used to run fifteen steps in its 300s and from Oct 22 the platform killed it mid-step.
  // The slow steps now run on their own schedules (vercel.json, lib/syncJob.ts):
  //   10:40  /api/sync/job/subscriptions   mdapi-subscriptions, membership-snapshots, membership-prices
  //   10:50  /api/sync/job/promocodes      mdapi-promocodes
  //   11:10  /api/sync/job/matches         mdapi-matches (and mdapi-reviews from its rosters)
  //   11:20  /api/sync/job/after-matches   firstmatch-ledger, manager-pay-recompute
  //   12:10  /api/sync/play-installs, 12:20 /api/sync/app-store-installs
  // What stays is quick and independent. Every step goes through the job runner, so one reached with
  // the budget spent, or cut off, writes a fin_sync_log row saying so.
  const job = syncJob(supabase, triggeredBy, maxDuration * 1000);

  const stripeResult = await job.step("stripe-api", runStripeSync, (r) => ({
    rows_imported: r.rows.length,
    rows_replaced: r.rowsReplaced,
    charges_fetched: r.totalCharges,
    charges_succeeded: r.paidRows,
    charges_skipped: r.skippedNonPaid + r.skippedNonUsd,
  }));

  // Google Calendar: isolated, kept out of anyFailed (a not yet propagated Workspace grant must not
  // fail the job). The SA key never reaches the log: CalendarConfigError is normalized here.
  let googleCalendarResult: { ok: boolean; rows?: number; note?: string };
  if (triggeredBy !== "cron") {
    googleCalendarResult = { ok: true, rows: 0, note: "manual mode: skipped (needs service role + runtime SA key)" };
  } else {
    const run = await job.step("google-calendar", async () => {
      try {
        return { rows: (await syncAllCalendars(supabase, new Date())).eventsStored };
      } catch (e) {
        if (e instanceof CalendarConfigError) throw new Error(`Calendar sync config: ${e.message}`);
        throw e;
      }
    }, (r) => ({ rows_imported: r.rows }));
    googleCalendarResult = run.ok ? { ok: true, rows: run.result.rows } : { ok: false, note: run.error };
    if (!run.ok) console.error("[cron] google-calendar step failed (isolated, non-fatal):", run.error);
  }

  // Users: the incremental /admin/players walk (one or two pages a day).
  const usersResult = await job.step("mdapi-users", syncMdapiUsers, mdapiUsersLogPatch);

  // Telnyx SMS log: a 2 day lookback, upserted. The ingest needs the service role, so a manual run
  // is a successful no-op with an advisory (POST /api/sms-log/ingest does a manual ingest).
  const telnyxSmsResult = await job.step("telnyx-sms", async (sb) => {
    if (triggeredBy !== "cron") {
      return { skipped: "manual mode: ingest needs the service role; use POST /api/sms-log/ingest", rowsUpserted: 0 };
    }
    const r = await ingestTelnyxSms(sb, { sinceISO: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
    return { skipped: null as string | null, rowsUpserted: r.rowsUpserted };
  }, (r) => (r.skipped ? { rows_imported: 0, error_message: r.skipped } : { rows_imported: r.rowsUpserted }));

  const anyFailed = !stripeResult.ok || !usersResult.ok || !telnyxSmsResult.ok;

  // Refresh the growth_* materialized views nightly after the mirror syncs.
  await refreshGrowthViews(supabase);

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      notRun: job.notRun,
      results: {
        stripe: stripeResult,
        mdapi_users: usersResult,
        telnyx_sms: telnyxSmsResult,
        // Informational only: excluded from anyFailed.
        google_calendar: googleCalendarResult,
      },
    },
    { status: anyFailed ? 500 : 200 },
  );
}

// Vercel cron triggers send HTTP GET
// (https://vercel.com/docs/cron-jobs#how-cron-jobs-work). Same handler,
// same auth — the bearer token is read from headers, no body is consumed.
export const GET = cronOnlyGet(POST);
