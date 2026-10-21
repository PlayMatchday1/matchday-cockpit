// /api/sync/users-full — RETIRED 2026-10-21 (Ryan, after the R15 outage at 2:05 PM Central).
//
// This was the daily full re-sync of mdapi_users: ~147 back-to-back /admin/players pages at 200 ms,
// with retries, at 09:00 UTC — the walk the facts doc records taking the API dyno to ~850 MB every
// morning. The night pass's full player walk (/api/sync/player-areas, 08:00 UTC, lib/nightPass.ts)
// now reads every player once, paced, and upserts mdapi_users from the same pages (mapRow), which is
// what blanks a deleted account here. It logs under this route's source, 'mdapi-users-full'.
//
// Kept as a route so a stale bookmark or cron gets an answer instead of a 404.

export const runtime = "nodejs";

export async function POST() {
  return Response.json({
    error: "Retired: mdapi_users' daily full refresh is the 3 AM Central player pass (/api/sync/player-areas). Nothing was synced.",
  }, { status: 410 });
}
export const GET = POST;
