// POST|GET /api/sync/job/subscriptions-current: every 15 minutes (vercel.json), the current-members
// pass of the subscriptions sync (Ryan, 2026-11-16). ACTIVE only, one request every 2 seconds, about 12
// requests a run; ended and past-due memberships move at the 10:40 UTC full walk
// (lib/mdapiSubscriptionsSync.ts, "THE CURRENT-MEMBERS PASS"). Logs as mdapi-subscriptions-current
// (migration 0273) so its clean runs never hide a failing nightly. No snapshots: those stay nightly.
// CRON_SECRET only.

import { cronClient, syncJob } from "@/lib/syncJob";
import { syncMdapiSubscriptions } from "@/lib/mdapiSubscriptionsSync";
import { inNightPassHour, NIGHT_PASS_SKIP } from "@/lib/nightPass";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  /* THE NIGHT PASS (2026-11-18): its 08:02/08:17/08:32/08:47 UTC runs would share the one bulk slot
   * (mdapiGate.ts) with the full pass. Members move again at 09:02. */
  if (inNightPassHour()) return Response.json({ ok: true, skipped: true, reason: NIGHT_PASS_SKIP });
  const job = syncJob(c.supabase, "cron", maxDuration * 1000);
  const subs = await job.step("mdapi-subscriptions-current", (sb) => syncMdapiSubscriptions(sb, { mode: "current" }),
    (r) => ({ rows_imported: r.upserted, api_calls: r.apiCalls, run_mode: "current" }));
  return Response.json({ ok: subs.ok, ms: job.elapsedMs(), results: { subs } }, { status: subs.ok ? 200 : 500 });
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
