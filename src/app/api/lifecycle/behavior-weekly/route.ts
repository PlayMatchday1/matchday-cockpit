/* GET /api/lifecycle/behavior-weekly?start=2026-03&end=2026-08 — Player Behavior's four metrics,
 * per WEEK, over the window the page's PERIOD PICKER selected. READ ONLY.
 *
 * ── THE WINDOW COMES FROM THE CALLER ──────────────────────────────────────────────────────────
 * `start` and `end` are month keys, the same pair the monthly view uses, and the axis is every
 * week whose MONDAY falls inside them (see weeksInMonthRange). `?weeks=N` remains as a fallback
 * for a caller with no period in hand — it means "the last N weeks ending today".
 *
 * ── IT READS THE SAME ROWS AS THE MONTHLY GRAIN (0208, 2026-10-05) ───────────────────────────
 * Registrations come from growth_registration (it now carries completed_sign_up_at), play from
 * growth_participation, first-time players from growth_player_profile. Those three apply the ONE
 * definition of who counts — staff, @matchday.com and fake accounts out, re-registrations as one
 * person — so nothing here re-checks a flag. Only mdapi_matches is read raw, for the match's day,
 * city and field, with the same live/not-cancelled filter the participation view applies.
 *
 * ── THE TWO CLOCKS, AND THEY ARE HANDLED DIFFERENTLY ON PURPOSE ───────────────────────────────
 *   completed_sign_up_at               TRUE UTC INSTANT → converted to its America/Chicago day.
 *   mdapi_matches.start_date           LOCAL WALL CLOCK carrying a Z it does not mean → SLICED.
 *   first_match_date                   ALREADY a wall-clock DAY (the view slices start_date) → as-is.
 * Swapping those two produces plausible numbers and wrong ones. See weekBuckets.ts.
 *
 * ── THIS WILL NOT SUM TO THE MONTHLY VIEW, FOR TWO REASONS, BOTH STRUCTURAL ───────────────────
 *   1. (RESOLVED BY MIGRATION 0157, 2026-09-01.) The monthly buckets used to be UTC while weekly
 *      was Chicago — 218 of 27,064 users (0.81%) fell in a different month under the two zones.
 *      growth_registration is now America/Chicago too, so this reason no longer applies.
 *   2. WEEKS DO NOT ALIGN TO MONTHS. This one is permanent. A week running Aug 31 – Sep 6 belongs wholly to neither
 *      August nor September, so "the weekly buckets summed over a month" is not a defined
 *      quantity unless that month happens to start on a Monday and end on a Sunday. This one is
 *      unavoidable and has nothing to do with timezones.
 * The survivor is reported to the caller in `reconcile` rather than left to be discovered.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { behaviorWeeklyResponse } from "@/lib/behaviorWeeklyCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticateCapability(req, "lifecycle");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return behaviorWeeklyResponse(auth.supabase, new URL(req.url).searchParams);
}
