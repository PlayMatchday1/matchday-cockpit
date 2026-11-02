// POST|GET /api/sync/job/after-matches: daily at 11:20 UTC (vercel.json), after the matches job at 11:10.
// Out of /api/sync/cron since Nov 2, 2026 (lib/syncJob.ts). firstmatch-ledger (reads the match
// players) and manager-pay-recompute, which still refuses to run on stale data: it needs a clean
// mdapi-matches completion in the last 3 hours, else it logs why it skipped. CRON_SECRET only.

import { cronClient, syncJob } from "@/lib/syncJob";
import { syncFirstmatchLedger } from "@/lib/firstmatchLedgerSync";
import { recomputeManagerPayIntoFinExpenses } from "@/lib/managerPayCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  const job = syncJob(c.supabase, "cron", maxDuration * 1000);
  const ledger = await job.step("firstmatch-ledger", (sb) => syncFirstmatchLedger(sb, "sync"), (r) => ({ rows_imported: r.inserted }));
  const pay = await job.step("manager-pay-recompute", async (sb) => {
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const m = await sb.from("fin_sync_log").select("id").eq("source", "mdapi-matches").not("completed_at", "is", null)
      .is("error_message", null).gte("completed_at", since).limit(1);
    if (m.error) throw new Error(`Skipped: could not read the matches sync log (${m.error.message})`);
    if (!m.data?.length) throw new Error("Skipped: no clean mdapi-matches run in the last 3 hours; recompute would use stale data");
    return recomputeManagerPayIntoFinExpenses(sb);
  }, (r) => ({ rows_imported: r.rowsWritten }));
  const ok = ledger.ok && pay.ok;
  return Response.json({ ok, ms: job.elapsedMs(), notRun: job.notRun, results: { ledger, pay } }, { status: ok ? 200 : 500 });
}

// Vercel cron issues a GET; POST is the entry point, GET its alias (scripts/cron-verb-test.ts).
export const GET = POST;
