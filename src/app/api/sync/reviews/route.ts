// POST /api/sync/reviews — manual trigger for the mdapi_reviews sync.
// Backs the SyncCard "Sync now" button on /data → Reviews section.
//
// Auth: same dual-mode pattern as /api/sync/stripe and /api/sync/cron.
//   Manual: Bearer <user-session-token> from the browser. Session
//           client used for the upsert — RLS allows authenticated
//           INSERT/UPDATE on mdapi_reviews (migration 0014).
//   Cron:   Bearer ${CRON_SECRET}. Service-role client bypasses RLS.
//           Cron path isn't actually used today (the cron orchestrator
//           hits /api/sync/cron, not this per-source endpoint), but
//           dual-mode is kept for parity + future flexibility.
//
// On success: returns 200 with { ok: true, result: { upserted, ... } }.
// On failure: returns 500 with { ok: false, error: "..." }.
// Either way, a fin_sync_log row is created with source='mdapi-reviews'.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { syncMdapiReviews } from "@/lib/mdapiReviewsSync";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// mdapi_reviews sync runs ~10s typical. 60s gives 6× headroom.
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

  // --- Run with logging ---
  const result = await runWithLog(
    "mdapi-reviews",
    triggeredBy,
    supabase,
    syncMdapiReviews,
    (r) => ({ rows_imported: r.upserted }),
  );

  return Response.json(
    {
      triggeredBy,
      durationMs: Date.now() - startedAt,
      ...result,
    },
    { status: result.ok ? 200 : 500 },
  );
}

// Deliberately POST-only. The hourly freshness trigger
// (.github/workflows/hourly-sync.yml) POSTs with the CRON_SECRET
// bearer, so there's no reason to expose a GET that performs a write —
// prefetchers and crawlers make that a footgun. If this ever moves to
// a Vercel cron (which triggers via GET, and needs a paid plan for
// sub-daily schedules), add `export const GET = POST` back here.
