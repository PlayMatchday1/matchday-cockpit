// The night pass's full match and review refreshes — the handlers behind the literal cron routes
// /api/sync/matches/full/{1..4} and /api/sync/reviews/full/{1,2} (literal folders, not [slice], so
// every scheduled path resolves to a file: scripts/cron-verb-test.ts). Schedule: lib/nightPass.ts.

// MATCHES — /api/sync/matches/full/{1..4} — the night pass's FULL match refresh, one quarter of the
// window per call: the match list AND every roster in it (lib/nightPass.ts has the schedule).
//
// WHY QUARTERS. ~560 rosters at one request a second is ~10 minutes; a function gets 300 s. A quarter
// is ~140 requests, ~3 minutes. The quarters overlap by one day (windowSlice).
//
// Each quarter is its own mdapi-matches run with run_mode 'full-<n>', so its tombstone guards compare it
// only with the same quarter's previous night (mdapiMatchesSync.ts, tombstoneMissing). Rosters are
// tombstoned here and only here: the hourly run reads too few to say a registration has gone.
//
// CRON ONLY. Stands down — logged as a failed run, loudly — if the night's player pass is still
// reading: two full reads at once is what the schedule exists to prevent. No retry: a failed quarter
// waits for the next night, and the hourly run keeps its matches and recent rosters current meanwhile.

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { defaultIncrementalWindow, logReviewsFromRosters, matchesLogPatch, syncMdapiMatches } from "@/lib/mdapiMatchesSync";
import { syncMdapiReviews } from "@/lib/mdapiReviewsSync";
import { runWithLog } from "@/lib/syncLogging";
import { MATCH_SLICES, windowSlice } from "@/lib/nightPass";
import { isLive, type RunRow } from "@/lib/playerAreaSync";
import { refreshGrowthViews, refreshPlayerFinderViews } from "@/lib/growthViews";

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function matchesFullSlice(req: Request, slice: number): Promise<Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  if (!(token && cronSecret && constantTimeMatch(token, cronSecret))) return Response.json({ error: "Not allowed." }, { status: 401 });
  if (!Number.isInteger(slice) || slice < 1 || slice > MATCH_SLICES) return Response.json({ error: `slice must be 1..${MATCH_SLICES}` }, { status: 404 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const window = windowSlice(defaultIncrementalWindow(), slice);
  const mode = `full-${slice}`;
  const runStart = new Date().toISOString();
  const result = await runWithLog("mdapi-matches", "cron", sb, async (s) => {
    const open = await s.from("player_area_sync_runs").select("finished_at,heartbeat_at,started_at").is("finished_at", null).eq("kind", "full");
    if (open.error) throw new Error(`player pass check failed: ${open.error.message}`);
    if (((open.data ?? []) as Pick<RunRow, "finished_at" | "heartbeat_at" | "started_at">[]).some((r) => isLive(r, Date.now()))) {
      throw new Error(`Stood down: the night's full player pass is still running. Quarter ${slice} (${window.fromDate}..${window.toDate}) waits for the next night.`);
    }
    return syncMdapiMatches(s, { ...window, rosters: "all", mode });
  }, matchesLogPatch);
  if (result.ok) {
    await logReviewsFromRosters(sb, "cron", runStart, result.result);
    if (slice === MATCH_SLICES) { await refreshGrowthViews(sb); await refreshPlayerFinderViews(sb); }
  }
  return Response.json({ slice, window, mode, ...result }, { status: result.ok ? 200 : 500 });
}

// REVIEWS — /api/sync/reviews/full/{1,2} — the night pass's full walk of /admin/matches/reviews, in two
// halves by page range (lib/nightPass.ts): ~287 pages at one request a second is longer than one
// function run. Half 1 reads pages 1–HALF_PAGES, half 2 the rest.
//
// This walk is what puts the endpoint's own values back on every review — current player and manager
// names, a deleted account's scrub — over the rows the hourly matches run derived from rosters.
//
// CRON ONLY. Paced, no retries, the first error stops the half (mdapiReviewsSync.ts). Stands down if
// the night's player pass is still reading. Logs as 'mdapi-reviews' with run_mode 'full-1' / 'full-2'.

/** 145 pages of 100 ≈ 170 s paced; half 2 is the remainder (~142 pages on 2026-10-21). */
const HALF_PAGES = 145;

export async function reviewsFullHalf(req: Request, half: number): Promise<Response> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/, "").trim();
  const cronSecret = process.env.CRON_SECRET;
  if (!(token && cronSecret && constantTimeMatch(token, cronSecret))) return Response.json({ error: "Not allowed." }, { status: 401 });
  if (half !== 1 && half !== 2) return Response.json({ error: "half must be 1 or 2" }, { status: 404 });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim(), key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return Response.json({ error: "Supabase env not configured" }, { status: 500 });
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const range = half === 1 ? { fromPage: 1, toPage: HALF_PAGES } : { fromPage: HALF_PAGES + 1 };
  const mode = `full-${half}`;
  const result = await runWithLog("mdapi-reviews", "cron", sb, async (s) => {
    const open = await s.from("player_area_sync_runs").select("finished_at,heartbeat_at,started_at").is("finished_at", null).eq("kind", "full");
    if (open.error) throw new Error(`player pass check failed: ${open.error.message}`);
    if (((open.data ?? []) as Pick<RunRow, "finished_at" | "heartbeat_at" | "started_at">[]).some((r) => isLive(r, Date.now()))) {
      throw new Error(`Stood down: the night's full player pass is still running. Reviews half ${half} waits for the next night.`);
    }
    return syncMdapiReviews(s, range);
  }, (r) => ({ rows_imported: r.upserted, api_calls: r.apiCalls, run_mode: mode }));
  return Response.json({ half, ...range, ...result }, { status: result.ok ? 200 : 500 });
}
