/* POST /api/sync/fin-txn/catchup/1 — piece 1 of 4 of the DAILY late-arrivals window, 60 Central days.
 *
 * Disputes and refunds land weeks after the charge: September carried four whose original charge
 * was in July or August, and a 3-day window would never have seen them. 60 days is the span that
 * covers every reversal observed in the September export with room over.
 *
 * IN FOUR PIECES, ten minutes apart (vercel.json). As one call the 60 days took 236-252 s before
 * the membership email lookups were added, against a 300 s ceiling; a piece is ~15 days. The pieces
 * are cut at Central midnights by windowPart and together cover exactly the 60 days. A piece that
 * finds the previous one still running gets 409 and is skipped, so the spacing leaves ample room.
 *
 * SAFE TO OVERLAP THE HOURLY RUN'S WINDOW because the write is an upsert on balance_txn_id. */
import { runFinTxnSync } from "../../route";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runFinTxnSync(req, { days: 60, part: 1, parts: 4 });
}

/* ── VERCEL CRON SENDS GET ──────────────────────────────────────────────────────────────────────
 * A route that only exports POST answers 405 to its own schedule, every run, and nothing says so.
 * cron-verb-test refuses any scheduled path without a GET. */
export const GET = POST;
