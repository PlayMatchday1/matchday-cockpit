/* POST /api/sync/stripe-people/sub-ends: the NIGHTLY addition to mdapi_subscription_stripe_end (0261).
 * Memberships that became CANCELED since the last run, plus any whose Stripe status was not final a day
 * ago, up to 300 a night at one Stripe GET every 250 ms (lib/stripeSubEnds). Its own file with a forced
 * budget, the stripe-people/recent pattern. */
import { runStripePeopleSync } from "../route";
export const maxDuration = 300;
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runStripePeopleSync(req, { subEnds: { limit: 300 } });
}
// Vercel Cron sends GET.
export const GET = POST;
