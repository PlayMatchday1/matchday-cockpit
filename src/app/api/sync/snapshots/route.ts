// POST /api/sync/snapshots — manual trigger for the membership
// snapshot refresh. Backs the SyncCard "Sync now" button on /data →
// Membership Snapshots section.
//
// Recomputes members_monthly_snapshots from the current
// mdapi_subscriptions + mdapi_match_players state. Useful when you
// need fresh snapshots without waiting for the next cron run (e.g.,
// after a spot-fix to the underlying data, or to re-run after a
// data quality investigation).
//
// Auth: same dual-mode pattern as /api/sync/reviews and /api/sync/cron.
//   Manual: Bearer <user-session-token>. Session client; the
//           members_monthly_snapshots table allows authenticated
//           INSERT/UPDATE.
//   Cron:   Bearer ${CRON_SECRET}. Service-role client. Cron path
//           isn't used today (orchestrator hits /api/sync/cron).

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { refreshMembershipSnapshots } from "@/lib/membershipSnapshots";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// Snapshot refresh is fast (~5s) — reads ~38k mdapi_subscriptions
// rows + the joined match data, computes monthly buckets, upserts
// 1-2 rows. 60s is plenty.
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

  const result = await runWithLog(
    "membership-snapshots",
    triggeredBy,
    supabase,
    async (sb) => {
      await refreshMembershipSnapshots({ client: sb, sourceFileName: "manual" });
    },
    // refreshMembershipSnapshots returns void — no row count to surface.
    () => ({}),
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
