/* POST /api/sync/stripe-people/recent: the hourly pass, customers and membership invoices over the
 * last 3 Central days. Its own file with a forced window, the fin-txn/recent pattern. New fin_txn rows
 * get their customer from the fin-txn sync itself, so the charges job is back-fill only. */
import { runStripePeopleSync } from "../route";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runStripePeopleSync(req, { jobs: ["customers", "invoices"], days: 3 });
}
// Vercel Cron sends GET (see fin-txn/recent).
export const GET = POST;
