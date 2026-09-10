// POST /api/sync/users-recent — the HOURLY incremental walk of mdapi_users, and nothing else.
//
// WHY THIS EXISTS. The Warsaw operator reported players missing from Player Finder. The player they
// named (90527) was not missing for any of the reasons anybody guessed: his row was correct,
// city "Warsaw", normalized "WAW", phone +48. He had registered 34 MINUTES AFTER the day's only
// automatic sync, and mdapi_users refreshed once a day. Measured 2026-09-10: every automatic
// source in fin_sync_log runs in one 11:00-11:01 UTC pass, 24 hours apart. He would have been
// invisible for 23h26m had somebody not run a manual sync at 14:25.
//
// 11:01 UTC IS 13:01 IN WARSAW. Every Warsaw player who signs up after 1pm local was invisible
// until 1pm the next day — most of their afternoon and evening. That is the reported bug.
//
// ── WHAT THIS ROUTE DOES NOT DO, WHICH IS THE POINT ──────────────────────────────────────────
//   NOT /api/sync/cron. That is an eleven-step orchestrator — matches, ledger, users, the lens
//     snapshot, subscriptions, reviews, promocodes, prices, manager pay, calendar, SMS — on a 300s
//     budget. Pointing a second cron line at it to refresh one table would run all eleven, hourly.
//   NOT a full re-sync. A full walk is 123 pages, 30,718 rows, 112.7 SECONDS (measured, and it once
//     blew the orchestrator's budget from the inside and killed the four steps after it). This
//     route REFUSES to bootstrap: with an empty mirror there is no watermark, syncMdapiUsers would
//     fall back to the full path, and hourly that would be catastrophic. It skips and says so.
//   NOT the scrub sweep. A player deleting their account is an edit to a row older than the
//     watermark and the incremental walk cannot see it — that is exactly why /api/sync/users-full
//     exists and it stays on its daily schedule, untouched.
//   NOT the users lens snapshot, NOT any other source, NOT a matview refresh. Player Finder rebuilds
//     player_finder_mv on demand when it reads stale; the matview was never the lag.
//
// It logs as "mdapi-users" deliberately: it IS that sync, and the freshness stamp Player Finder
// reads keys off that source. A new source value would need a fin_sync_log CHECK migration and
// would split one table's freshness across two names.
//
// Same dual-mode auth as /api/sync/users: CRON_SECRET for the schedule, a valid session for a
// manual call. Writes use the service role — RLS allows authenticated SELECT only on mdapi_users.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { syncMdapiUsers, mdapiUsersLogPatch } from "@/lib/mdapiUsersSync";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

/* AN INCREMENTAL RUN IS A COUPLE OF PAGES. 60s is ~20x the observed incremental cost and is
 * deliberately BELOW the 120s that /api/sync/users allows itself, because that headroom exists
 * there for the bootstrap path this route refuses to take. If this ever times out, something has
 * changed about the walk and the right answer is to look, not to raise the ceiling. */
export const maxDuration = 60;
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

  /* THE BOOTSTRAP GUARD. syncMdapiUsers picks its own mode: no watermark means a FULL walk, and
   * this route must never take that path. An empty mirror is the only way to reach it, so the
   * check is a head count and it costs nothing. Bootstrapping is /api/sync/users-full's job. */
  const probe = await supabase.from("mdapi_users").select("id", { count: "exact", head: true });
  if (probe.error) {
    return Response.json({ error: `mirror probe failed: ${probe.error.message}` }, { status: 500 });
  }
  if (!probe.count) {
    return Response.json({
      triggeredBy, skipped: true, durationMs: Date.now() - startedAt,
      reason: "mdapi_users is empty, so there is no watermark and this would become a full 112s "
        + "walk. Bootstrapping belongs to /api/sync/users-full, which runs daily.",
    }, { status: 200 });
  }

  // --- Run with logging ---
  const result = await runWithLog(
    "mdapi-users",
    triggeredBy,
    supabase,
    syncMdapiUsers,
    mdapiUsersLogPatch,
  );

  /* SAY SO IF IT WENT FULL ANYWAY. The guard above makes it unreachable with a populated mirror,
   * but a mode of "full" here would mean the walk lost its watermark for some other reason, and an
   * hourly 112s run is worth a loud line in the response rather than a slow cron nobody reads. */
  const mode = (result as { mode?: string }).mode;
  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      ...(mode === "full" ? { warning: "this run went FULL despite the bootstrap guard — investigate" } : {}),
      ...result,
    },
    { status: result.ok ? 200 : 500 },
  );
}
