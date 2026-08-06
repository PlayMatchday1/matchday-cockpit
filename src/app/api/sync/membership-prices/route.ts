// POST /api/sync/membership-prices — manual trigger for the per-city
// max-active-membership-price snapshot. Backs the SyncCard "Sync now"
// button on /data → Finance / Membership prices section.
//
// Auth: same dual-mode pattern as /api/sync/reviews.
//   Manual: Bearer <user-session-token> from the browser. Session is
//           validated via getUser and REJECTED if invalid (401) — but
//           membership_price_snapshots is a service-role-only table, so
//           the actual insert runs with the SERVICE ROLE, not the caller's
//           RLS client. The session is an AUTHZ gate only.
//   Cron:   Bearer ${CRON_SECRET} (constant-time). Service-role client.
// Either way the work runs through runWithLog("membership-prices") so the
// fin_sync_log row stays consistent with the cron path.
//
// On success: 200 with { ok: true, result: { changesInserted, ... } }.
// On failure: 500 with { ok: false, error: "..." }.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { refreshMembershipPriceSnapshots } from "@/lib/membershipPriceSnapshots";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// Reads ACTIVE mdapi_subscriptions, groups by city, inserts only on a
// price change. Sub-second in practice; 60s is generous.
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
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!supabaseUrl || !publishableKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }
  if (!serviceKey) {
    return Response.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not set" },
      { status: 500 },
    );
  }

  // Authorize: CRON_SECRET → cron; otherwise a valid user session → manual.
  // membership_price_snapshots is service-role-only, so the work uses the
  // service role in BOTH modes — the session is validated for authz only.
  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
  } else {
    const sessionClient = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
    triggeredBy = "manual";
  }

  const supabase: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // --- Run with logging ---
  const result = await runWithLog(
    "membership-prices",
    triggeredBy,
    supabase,
    refreshMembershipPriceSnapshots,
    (r) => ({ rows_imported: r.changesInserted }),
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
