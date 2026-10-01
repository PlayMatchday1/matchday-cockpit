/* POST /api/sync/fin-txn/catchup — the DAILY late-arrivals window, 60 Central days.
 *
 * Disputes and refunds land weeks after the charge: September carried four whose original charge
 * was in July or August, and a 3-day window would never have seen them. 60 days is the span that
 * covers every reversal observed in the September export with room over.
 *
 * SAFE TO OVERLAP THE HOURLY RUN'S WINDOW because the write is an upsert on balance_txn_id — the
 * same rows written twice are the same rows. */
import { runFinTxnSync } from "../route";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runFinTxnSync(req, { days: 60 });
}

/* ── VERCEL CRON SENDS GET ──────────────────────────────────────────────────────────────────────
 * A route that only exports POST answers 405 to its own schedule, every run, and nothing says so —
 * users-recent shipped that way and failed silently at :05 past every hour until someone looked.
 * cron-verb-test exists because of it and refuses any scheduled path without a GET. */
export const GET = POST;
