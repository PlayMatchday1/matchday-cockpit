// POST|GET /api/sync/job/promocodes: daily at 10:50 UTC (vercel.json), out of /api/sync/cron since Nov 2,
// 2026 (lib/syncJob.ts). CRON_SECRET only; the Data page keeps POST /api/sync/promocodes.

import { cronClient, syncJob } from "@/lib/syncJob";
import { syncMdapiPromocodes } from "@/lib/mdapiPromocodesSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  const job = syncJob(c.supabase, "cron", maxDuration * 1000);
  const promocodes = await job.step("mdapi-promocodes", syncMdapiPromocodes, (r) => ({ rows_imported: r.upserted, api_calls: r.apiCalls }));
  return Response.json({ ok: promocodes.ok, ms: job.elapsedMs(), notRun: job.notRun, results: { promocodes } }, { status: promocodes.ok ? 200 : 500 });
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
