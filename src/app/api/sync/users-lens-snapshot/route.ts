// POST /api/sync/users-lens-snapshot — manual trigger for the
// /cities → Users lens pre-aggregation snapshot.
//
// Same dual-mode auth as /api/sync/users. RLS allows authenticated
// SELECT on mdapi_users_lens_snapshot (and aggregate); writes use the
// service role.

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { refreshUsersLensSnapshot } from "@/lib/usersLensSnapshot";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";

// Refresh runs ~6s typical (4.6s fetchAll + ~1s aggregate × 6 + small
// writes). 60s is generous headroom.
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
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey || !serviceKey) {
    return Response.json(
      { error: "Supabase env not configured" },
      { status: 500 },
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  let triggeredBy: TriggeredBy;
  if (cronSecret && constantTimeMatch(token, cronSecret)) {
    triggeredBy = "cron";
  } else {
    triggeredBy = "manual";
    const sessionClient = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } =
      await sessionClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }
  }
  const supabase: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await runWithLog(
    "mdapi-users-lens-snapshot",
    triggeredBy,
    supabase,
    refreshUsersLensSnapshot,
    (r) => ({ rows_imported: r.perCityRowsWritten + r.aggregateRowsWritten }),
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
