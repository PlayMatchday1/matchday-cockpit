/* POST /api/sync/stripe-people/unpaid: the hourly pass for unpaid membership invoices (0262), in its OWN
 * function so it has its own 300 s. Open invoices created in the last 45 days (Stripe's retries run well
 * inside that), uncollectible and void ones in the last 3. It ran inside stripe-people/recent for three
 * hours on 2026-11-07 and timed that route out every hour, listing every open invoice in the account. */
import { runStripePeopleSync } from "../route";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runStripePeopleSync(req, { jobs: ["unpaid"], days: 3, openDays: 45 });
}
// Vercel Cron sends GET.
export const GET = POST;
