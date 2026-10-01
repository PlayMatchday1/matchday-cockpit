/* POST /api/sync/fin-txn/recent — the HOURLY window, 3 Central days.
 *
 * Its own route file, not `?days=3` on the parent: no cron in this project carries a query string
 * and cron-verb-test resolves every scheduled path to a file on disk. The window is FORCED here so
 * the schedule cannot be widened by editing a URL. */
import { runFinTxnSync } from "../route";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runFinTxnSync(req, { days: 3 });
}

/* ── VERCEL CRON SENDS GET ──────────────────────────────────────────────────────────────────────
 * A route that only exports POST answers 405 to its own schedule, every run, and nothing says so —
 * users-recent shipped that way and failed silently at :05 past every hour until someone looked.
 * cron-verb-test exists because of it and refuses any scheduled path without a GET. */
export const GET = POST;
