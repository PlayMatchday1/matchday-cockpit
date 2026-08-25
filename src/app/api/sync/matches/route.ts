// POST /api/sync/matches — manual trigger for the mdapi_matches
// incremental refresh. Backs the SyncCard "Sync now" button on
// /data → Matches section.
//
// Runs the SAME window the cron uses (defaultIncrementalWindow:
// now-14d → now+60d). Backfill is CLI-only via
// scripts/sync-mdapi-matches-backfill.ts.
//
// Auth: same dual-mode pattern as /api/sync/reviews and /api/sync/cron.
//   Manual: Bearer <user-session-token>. Session client; RLS allows
//           authenticated INSERT/UPDATE on mdapi_matches +
//           mdapi_match_players (migration 0016).
//   Cron:   Bearer ${CRON_SECRET}. Service-role client. Cron path
//           isn't used today (orchestrator hits /api/sync/cron).

import { timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  syncMdapiMatches,
  defaultIncrementalWindow,
} from "@/lib/mdapiMatchesSync";
import { runWithLog, type TriggeredBy } from "@/lib/syncLogging";
import { refreshGrowthViews, refreshPlayerFinderViews } from "@/lib/growthViews";

// Incremental sync runs ~15-20s typical, measured off fin_sync_log
// (the older ~150s note predated the window narrowing). 300s is far
// more headroom than needed but stays aligned with the cron
// orchestrator, which runs the same code path.
export const maxDuration = 300;
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
  }

  // Read-only dry-run: fetch matches + rosters and return coverage diagnostics
  // with NO DB write (no fin_sync_log row either). Body flag or ?dryRun=1; the
  // cron/normal path never sets it, so its behaviour is byte-identical.
  const body = (await req.json().catch(() => ({}))) as {
    dryRun?: boolean;
    matchesOnly?: boolean;
    fromDate?: string;
    toDate?: string;
    cityLaunch?: Record<string, string>;
  };
  const dryRun = body?.dryRun === true || new URL(req.url).searchParams.get("dryRun") === "1";
  if (dryRun) {
    const opts: {
      dryRun: true;
      matchesOnly?: boolean;
      fromDate?: string;
      toDate?: string;
    } = { dryRun: true };
    if (body?.matchesOnly === true) opts.matchesOnly = true;
    if (body?.fromDate) opts.fromDate = body.fromDate;
    if (body?.toDate) opts.toDate = body.toDate;
    const r = await syncMdapiMatches(supabase, opts);
    return Response.json({ triggeredBy, ...r, dryRun: true, durationMs: Date.now() - startedAt }, { status: 200 });
  }

  // Manual backfill: a bounded [fromDate,toDate] window (both required) writes
  // just that slice, optionally guarded by a per-city launch map. Cron always
  // uses the incremental window, so its path is byte-identical. The bounded
  // window keeps the tombstone pass scoped to the same slice (see the sync).
  const window =
    triggeredBy === "manual" && body?.fromDate && body?.toDate
      ? {
          fromDate: body.fromDate,
          toDate: body.toDate,
          ...(body?.cityLaunch ? { cityLaunch: body.cityLaunch } : {}),
        }
      : defaultIncrementalWindow();

  const result = await runWithLog(
    "mdapi-matches",
    triggeredBy,
    supabase,
    (sb) => syncMdapiMatches(sb, window),
    (r) => ({
      rows_imported: r.matchesUpserted + r.playersUpserted,
      rows_soft_deleted: r.rowsSoftDeleted,
    }),
  );

  // Refresh the growth_* materialized views so the Growth tab reflects the new
  // matches, and the player-finder set so the finder does too. Both best-effort;
  // a refresh failure never fails the sync, and the finder page reports its own
  // staleness rather than pretending the set is current.
  if (result.ok) {
    await refreshGrowthViews(supabase);
    await refreshPlayerFinderViews(supabase);
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

// Deliberately POST-only. The hourly freshness trigger
// (.github/workflows/hourly-sync.yml) POSTs with the CRON_SECRET
// bearer, so there's no reason to expose a GET that performs a write —
// prefetchers and crawlers make that a footgun. If this ever moves to
// a Vercel cron (which triggers via GET, and needs a paid plan for
// sub-daily schedules), add `export const GET = POST` back here.
