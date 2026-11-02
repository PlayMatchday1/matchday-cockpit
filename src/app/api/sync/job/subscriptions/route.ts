// POST|GET /api/sync/job/subscriptions: daily at 10:40 UTC (vercel.json), out of /api/sync/cron since
// Nov 2, 2026, when that job's 300s ran out (lib/syncJob.ts). mdapi-subscriptions (about 100s), then
// the two snapshots that read it, each skipped with its reason when the subscriptions sync failed.
// CRON_SECRET only; the Data page keeps POST /api/sync/subscriptions for a manual run.

import { cronClient, syncJob } from "@/lib/syncJob";
import { syncMdapiSubscriptions } from "@/lib/mdapiSubscriptionsSync";
import { refreshMembershipSnapshots } from "@/lib/membershipSnapshots";
import { refreshMembershipPriceSnapshots } from "@/lib/membershipPriceSnapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  const job = syncJob(c.supabase, "cron", maxDuration * 1000);
  const subs = await job.step("mdapi-subscriptions", syncMdapiSubscriptions, (r) => ({ rows_imported: r.upserted, api_calls: r.apiCalls }));
  const snapshots = await job.step("membership-snapshots", async (sb) => {
    if (!subs.ok) throw new Error("Skipped: mdapi_subscriptions sync failed; snapshot needs fresh data");
    return refreshMembershipSnapshots({ client: sb, sourceFileName: "cron" });
  }, (r) => ({ rows_imported: r.writtenMonths.length, rows_replaced: r.guardedMonths.length }));
  const prices = await job.step("membership-prices", async (sb) => {
    if (!subs.ok) throw new Error("Skipped: mdapi_subscriptions sync failed; price snapshot needs fresh data");
    return refreshMembershipPriceSnapshots(sb);
  }, (r) => ({ rows_imported: r.changesInserted }));
  const ok = subs.ok && snapshots.ok && prices.ok;
  return Response.json({ ok, ms: job.elapsedMs(), notRun: job.notRun, results: { subs, snapshots, prices } }, { status: ok ? 200 : 500 });
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
