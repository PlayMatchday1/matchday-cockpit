// GET|POST /api/sync/reviews — what the GitHub hourly job (and the Data page) call for reviews.
//
// IT MAKES NO MATCHDAY REQUEST since 2026-10-21 (Ryan, after the R15 outage). It used to walk every
// review, ~287 pages back to back, about seven times a day. New reviews now arrive with the hourly
// matches run, read off the rosters it refreshes (reviewFromRoster, mdapiMatchesSync.ts — same id,
// same values, proven on the mirror), and the full walk of /admin/matches/reviews is the night pass's
// (/api/sync/reviews/full/{1,2}, lib/nightPass.ts).
//
// It answers 200 so the GitHub job's next steps (the matches run, then the Master Schedule
// reconcile) run. The workflow file still calls it: this token cannot push a workflow change.

export const runtime = "nodejs";

export async function POST() {
  return Response.json({
    ok: true,
    skipped: "Reviews arrive with the hourly matches run (/api/sync/matches); the full reviews walk runs nightly at about 3:47 AM Central.",
  });
}
export const GET = POST;
