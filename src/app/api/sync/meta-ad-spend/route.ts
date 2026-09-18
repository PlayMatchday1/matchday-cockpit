// POST /api/sync/meta-ad-spend — daily Meta ad spend into the Expenses ledger.
//
// READ-ONLY AGAINST META. Every Graph request is a GET; there is no POST or DELETE path to Meta in
// this integration at all. The token travels in an Authorization header, never a query parameter,
// and every error passes through redactMetaError before it is thrown or logged.
//
// WHAT IT DOES. Pulls a trailing 28-day window at day granularity, broken down by
// `comscore_market` — the parameter Meta actually accepts; `dma` returns a hard 400 telling you so.
// Upserts the daily series into fin_meta_ad_spend_daily, then rewrites the monthly ledger rows it
// owns in fin_expenses FROM THAT STORE — not from the window it just pulled. The daily table is
// the evidence; fin_expenses is a projection of it. Building the ledger from the window while
// deleting the whole owned range is how a closed month gets restated down to whatever the last
// 28 days happened to touch.
//
// THE TRAILING RE-PULL IS DELIBERATE. Meta revises recent days, so pulling only yesterday would
// freeze the first (wrong) figure. Re-pulling 28 days and upserting on the primary key costs
// nothing and self-heals. MEASURED 2026-09-18: of 179 market rows stored on 2026-08-26, 171 came
// back identical and all 7 changes were on 2026-08-25 — the day still accruing when that run
// happened. Restatement is real, confined to the tail, and 28 days is generous.
//
// THE OWNERSHIP PREDICATE — vendor='Meta' AND manual_entry=false AND date >= 2026-08-01 — is the
// whole safety story. April through July are reconciled by hand and carry manual entries; the
// delete carries all three clauses on the statement itself, so it is structurally incapable of
// reaching them. The floor is enforced in code AND as a CHECK constraint (0151).
//
// Same dual-mode auth as the other sync routes: CRON_SECRET for the scheduled call, a valid
// session for a manual one. Writes use the service role.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { syncMetaAdSpend, coverageVerdict, type MetaSyncResult } from "@/lib/metaAdSpendSync";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

/* A 28-day window at day granularity with one geo breakdown is a handful of paged GETs plus two
 * small writes. 120s is generous; the number to watch is completed_at - started_at in fin_sync_log
 * for source 'meta-ad-spend', because a widening window is the thing that would grow it. */
export const maxDuration = 120;
export const runtime = "nodejs";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export async function POST(req: Request) {
  const startedAt = Date.now();

  // --- Auth: bearer, dual-mode ---
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
    // Manual mode needs the service role too — RLS allows SELECT only
    // on mdapi_users for authenticated, no INSERT/UPDATE policy.
    // Verify the session token is valid before swapping in service.
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
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
  }

  /* --- Run with logging ---
   * runWithLog INSERTS THE LOG ROW BEFORE RUNNING THE SYNC and returns ok:false without running it
   * if that insert is rejected. So until migration 0149 adds 'mdapi-users-full' to the source CHECK
   * this route does nothing at all — and says so, rather than reporting a success it did not have.
   * That is the loud direction: a re-sync that quietly skipped would leave scrubbed accounts
   * readable while Recent Syncs showed nothing wrong. */
  const todayYmd = new Date().toISOString().slice(0, 10);
  const result = await runWithLog(
    "meta-ad-spend",
    triggeredBy,
    supabase,
    (sb) => syncMetaAdSpend(sb, todayYmd),
    (r: MetaSyncResult) => ({
      rows_imported: r.marketRows + r.unallocatedRows,
      rows_replaced: r.expenseRowsWritten,
      /* THE DAILY VARIANCE IS IN THE VERDICT, not only in a return value nobody reads. A growing
       * gap between the account total and the sum of its market rows means Meta is withholding
       * more breakdown detail over time, and the ledger is quietly carrying more unallocated
       * spend. That is visible in Recent Syncs or it is invisible. */
      /* TWO ADVISORIES, ONE FIELD, AND NEITHER MAY SWALLOW THE OTHER. fin_sync_log carries one
       * error_message, so they are JOINED rather than chained through `??` — a variance and a
       * coverage gap are independent facts and a run can carry both.
       *
       * THE "ADVISORY" PREFIX IS LOAD-BEARING AND WAS MISSING. isSyncAdvisory (syncAdvisory.ts)
       * matches /^\s*advisory\b/ and NOTHING ELSE; the SyncCard and Recent Syncs colour a row
       * amber on that match and RED otherwise. "VARIANCE (sync OK): …" has never matched, so a
       * successful run carrying a two-cent variance has always rendered as a FAILURE. That was
       * survivable while the message was rare. It is not survivable now: the coverage line is
       * true on every run until the store is complete, so the fix would have painted this sync
       * permanently red and taught everyone to ignore it. One prefix, both messages, ONCE. */
      error_message: (() => {
        const parts = [
          r.varianceTotalCents === 0
            ? ""
            : `VARIANCE: ${r.varianceByDay.length} day(s) whose market rows did not sum to the account total. Net ${(r.varianceTotalCents / 100).toFixed(2)} USD; ${(r.unallocatedCents / 100).toFixed(2)} USD carried as unallocated. A NEGATIVE day carries nothing — market rows exceeding the account total would need a negative expense row, which would corrupt the total the other way.`,
          coverageVerdict(r.coverage),
        ].filter(Boolean);
        // 500 chars is what the catch path truncates to; the patch path does not, so it is done
        // here rather than discovered as a rejected update on a run nobody was watching.
        return parts.length ? `ADVISORY (sync OK). ${parts.join(" · ")}`.slice(0, 500) : undefined;
      })(),
    }),
  );

  if (!result.ok && /fin_sync_log_source_check|violates check constraint/i.test(result.error ?? "")) {
    return Response.json({
      error: "Migration 0151 (fin_sync_log source 'meta-ad-spend') is not applied yet. NOTHING WAS SYNCED.",
      detail: result.error,
    }, { status: 503 });
  }

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      ...result,
    },
    { status: result.ok ? 200 : 500 },
  );
}

/* ── VERCEL CRON SENDS GET, AND THESE ROUTES ONLY EXPORTED POST ────────────────────────────────
 * So the scheduled call has been returning 405 every night since the day it was scheduled. The
 * cron was firing perfectly; nothing was answering it. Read from the production invocation logs
 * on 2026-09-18 rather than inferred:
 *
 *   /api/sync/meta-ad-spend    10:00:39Z  GET -> 405   (and 09-17, 09-16)
 *   /api/sync/users-full       09:00:35Z  GET -> 405   (and 09-17, 09-16)
 *   /api/sync/wp-submissions   12:00:42Z  GET -> 405   (and 09-17, 09-16)
 *   /api/sync/cron             11:00:03Z  GET -> 200   (and 09-17, 09-16)
 *
 * /api/sync/cron is the only scheduled route that carried this line, and it is the only one that
 * has ever run. fin_sync_log agrees: every source inside it has 30 rows in 30 days, and
 * meta-ad-spend has ONE row in its entire life, triggered_by='manual'.
 *
 * SAME HANDLER, SAME AUTH. The bearer is read from headers and the cron path consumes no body, so
 * the verb is the only difference between the two entry points. This is the line /api/sync/cron
 * has carried since it was written, with the Vercel doc reference on it:
 * https://vercel.com/docs/cron-jobs#how-cron-jobs-work */
export const GET = POST;
