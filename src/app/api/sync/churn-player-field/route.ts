/* GET|POST /api/sync/churn-player-field — rebuilds churn_player_field (0264/0265), the Churn page's per player ×
 * venue totals: played matches (own spot, managed excluded), managed matches, and Finance net of booking and
 * membership charges up to the last played day. One database call, refresh_churn_player_field, with salesTax.ts's
 * rates (RATES_FOR_SQL, the same arguments refresh_fin_txn_daily takes), so the tax rule is Finance's.
 *
 * DATABASE ONLY: no MatchDay API call. Nightly at 13:20 UTC (vercel.json), after the matches job (11:10) and the last
 * fin-txn catch-up (13:00). CRON_SECRET only; logged to fin_sync_log as 'churn-player-field'. */
import { cronClient, syncJob } from "@/lib/syncJob";
import { RATES_FOR_SQL } from "@/lib/revenueTxn";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const c = cronClient(req);
  if (c instanceof Response) return c;
  const job = syncJob(c.supabase, "cron", maxDuration * 1000);
  const r = await job.step("churn-player-field",
    async (sb) => {
      const { data, error } = await sb.rpc("refresh_churn_player_field", RATES_FOR_SQL);
      if (error) throw new Error(`refresh_churn_player_field: ${error.message}`);
      return Number(data ?? 0);
    },
    (rows) => ({ rows_imported: rows }));
  return Response.json({ ok: r.ok, ...(r.ok ? { rows: r.result } : { error: r.error }), notRun: job.notRun }, { status: r.ok ? 200 : 500 });
}

// Vercel Cron sends GET.
export const GET = POST;
