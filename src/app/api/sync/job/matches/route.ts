// POST|GET /api/sync/job/matches: daily at 11:10 UTC (vercel.json), out of /api/sync/cron since Nov 2,
// 2026 (lib/syncJob.ts). The same incremental matches step the daily job ran (rosters for recent,
// new or changed matches), and the reviews those rosters carry (mdapi-reviews 'from-rosters'). The
// hourly GitHub Actions run of /api/sync/matches still skips 11:00 UTC. CRON_SECRET only.

import { cronClient, syncJob } from "@/lib/syncJob";
import { defaultIncrementalWindow, logReviewsFromRosters, matchesLogPatch, syncMdapiMatches } from "@/lib/mdapiMatchesSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  const job = syncJob(c.supabase, "cron", maxDuration * 1000);
  const start = new Date().toISOString();
  const matches = await job.step("mdapi-matches",
    (sb) => syncMdapiMatches(sb, { ...defaultIncrementalWindow(), rosters: "changed", mode: "incremental" }), matchesLogPatch);
  if (matches.ok) await logReviewsFromRosters(c.supabase, "cron", start, matches.result);
  return Response.json({ ok: matches.ok, ms: job.elapsedMs(), notRun: job.notRun, results: { matches: matches.ok ? { ok: true } : matches } }, { status: matches.ok ? 200 : 500 });
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
