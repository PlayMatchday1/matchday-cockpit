// POST /api/sync/meta-ad-spend — daily Meta ad spend into the Expenses ledger.
//
// READ-ONLY AGAINST META. Every Graph request is a GET; there is no POST or DELETE path to Meta in
// this integration at all. The token travels in an Authorization header, never a query parameter,
// and every error passes through redactMetaError before it is thrown or logged.
//
// WHAT IT DOES. Pulls a trailing 28-day window at day granularity, broken down by
// `comscore_market` — the parameter Meta actually accepts; `dma` returns a hard 400 telling you so.
// Upserts the daily series into fin_meta_ad_spend_daily, then rewrites the monthly ledger rows it
// owns in fin_expenses.
//
// THE TRAILING RE-PULL IS DELIBERATE. Meta revises recent days, so pulling only yesterday would
// freeze the first (wrong) figure. Re-pulling 28 days and upserting on the primary key costs
// nothing and self-heals.
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
import { syncMetaAdSpend, type MetaSyncResult } from "@/lib/metaAdSpendSync";
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
      error_message: r.varianceTotalCents === 0
        ? undefined
        : `VARIANCE (sync OK): ${r.varianceByDay.length} day(s) whose market rows did not sum to the account total. Net ${(r.varianceTotalCents / 100).toFixed(2)} USD; ${(r.unallocatedCents / 100).toFixed(2)} USD carried as unallocated. A NEGATIVE day carries nothing — market rows exceeding the account total would need a negative expense row, which would corrupt the total the other way.`,
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
