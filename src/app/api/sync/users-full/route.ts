// POST /api/sync/users-full — the DAILY FULL re-sync of mdapi_users.
//
// WHY THIS EXISTS, when /api/sync/users already syncs the same table.
//
// A PLAYER DELETING THEIR ACCOUNT IS AN EDIT, NOT A DISAPPEARANCE. MatchDay scrubs the row in place
// and keeps serving it from /admin/players: name "Deleted Account", phone null, email replaced by
// an opaque 44-character token. Measured on prod: 1,669 such rows already in the mirror.
//
// The incremental walk cannot see it. It sorts newest-first and stops at the watermark, so a row
// older than the watermark is never re-fetched however it changes. It PREFERS updatedAt for exactly
// this reason — but six consecutive prod runs all came back `incremental:createdAt`, every one
// carrying the advisory that /admin/players exposes no updatedAt. So edits are caught by nothing,
// and prod id 88053 sat in Clubhouse with a name, an email and a phone that MatchDay had scrubbed.
//
// THE FULL RE-SYNC IS THE WHOLE FIX. Because the scrub is in place, re-fetching overwrites the
// name, nulls the phone, tombstones the email and rewrites `raw` wholesale — so the second copy of
// the PII in the jsonb goes with it. No id-set diff, no soft-delete column, no separate PII pass.
//
// DAILY, NOT WEEKLY: ~95 pages at 250/page, ~19s network + ~10s upserts ≈ 30s against a
// maxDuration of 120. Weekly would buy nothing and leave a scrubbed account readable here for up to
// seven days.
//
// SEPARATE FROM THE 11:00 ORCHESTRATOR, deliberately. This step is what once blew that chain's 300s
// budget from the inside and killed the four steps after it. On its own schedule it cannot.
//
// Same dual-mode auth as /api/sync/users: CRON_SECRET for the scheduled call, a valid session for a
// manual one. Writes use the service role — RLS allows authenticated SELECT only on mdapi_users.


import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { syncMdapiUsers, mdapiUsersLogPatch } from "@/lib/mdapiUsersSync";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// ALWAYS the full path — ~95 paginated GETs at 250/page, ~19s network + ~10s upserts ≈ 30s.
// 120s leaves ~4x headroom. This is the same ceiling /api/sync/users carries for its first-run
// case; the difference is that here every run takes it.
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
  const result = await runWithLog(
    "mdapi-users-full",
    triggeredBy,
    supabase,
    (sb) => syncMdapiUsers(sb, { forceFull: true }),
    mdapiUsersLogPatch,
  );

  if (!result.ok && /fin_sync_log_source_check|violates check constraint/i.test(result.error ?? "")) {
    return Response.json({
      error: "Migration 0149 (fin_sync_log source 'mdapi-users-full') is not applied yet. NOTHING WAS SYNCED.",
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
