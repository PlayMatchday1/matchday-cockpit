/* POST /api/veo/resync?week=YYYY-MM-DD — re-pull ONE WEEK of matches from MatchDay into the mirror.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────────────
 * Master Schedule's Refresh re-read the mdapi_matches MIRROR. Re-reading a mirror cannot make it
 * newer, so the button caught only what had already reached the mirror — another operator's edit
 * that wrote through, or the daily cron. Anything changed in MatchDay itself (Retool, the app, the
 * backend) stayed invisible for up to 24 hours while the button said "Updated 1:04 PM".
 *
 * This makes Refresh do what its label implies: fetch the source of truth for the week on screen,
 * upsert it, and only then re-read.
 *
 * ── IT REUSES THE ONE SYNC, SCOPED ────────────────────────────────────────────────────────────
 * syncMdapiMatches already takes fromDate/toDate and already owns every rule about how a match row
 * is shaped. A second fetch-and-upsert here would be a second place for those rules to drift, so
 * this passes a seven-day window and nothing else. THE /data SYNC IS UNTOUCHED — same function,
 * different arguments.
 *
 * matchesOnly SKIPS THE ROSTER CRAWL, which is the whole reason this is fast enough for a button.
 * The crawl is one /players call PER MATCH — about 100 for a week — and Master Schedule renders
 * name, city, field, start_date and is_cancelled. It reads no roster at all. Confirmed at
 * mdapiMatchesSync.ts:437: matchesOnly gates ONLY the roster loop; the match upsert itself is
 * gated on dryRun, which this never sets.
 *
 * ── PRODUCTION ONLY ───────────────────────────────────────────────────────────────────────────
 * mdapi_matches holds PRODUCTION api_ids and staging ids occupy the same number space. The sync
 * client is the production one; there is no env parameter here on purpose, so this route cannot be
 * pointed at staging and overwrite a production row that happens to share a number.
 */

import { authenticateCapability } from "@/lib/capabilityAuth";
import { createClient } from "@supabase/supabase-js";
import { syncMdapiMatches } from "@/lib/mdapiMatchesSync";
import { mondayOf, addDays } from "@/lib/managerPayCompute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  /* THE SAME CAPABILITY THE PAGE NEEDS. This writes the mirror, not MatchDay — no match is
   * changed, nothing leaves for the API except GETs — so it is gated as a Match Ops action rather
   * than as a match write. */
  const auth = await authenticateCapability(req, "matchops");
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const week = new URL(req.url).searchParams.get("week") ?? "";
  if (week && !ISO.test(week)) return Response.json({ error: "week must be YYYY-MM-DD" }, { status: 400 });

  /* THE WINDOW IS THE WEEK ON SCREEN, AS TEXT. mondayOf normalises any day of the week to its
   * Monday — the same helper Manager Pay uses — so a caller passing Wednesday gets that week and
   * not a rolling seven days starting Wednesday. Dates stay YYYY-MM-DD strings throughout: these
   * are calendar bounds for a query, and a Date would re-shift them by the server's offset. */
  const base = week || new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const monday = mondayOf(base);
  if (!monday) return Response.json({ error: `could not resolve a Monday for ${base}` }, { status: 400 });
  const sunday = addDays(monday, 6);

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  try {
    const result = await syncMdapiMatches(sb, { fromDate: monday, toDate: sunday, matchesOnly: true });
    /* THE COUNT IS REPORTED so the caller can tell a real re-pull from a no-op. The Updated stamp
     * on the page moves only when this says matches were actually fetched. */
    return Response.json(
      { ok: true, week: monday, fromDate: monday, toDate: sunday, matches: result.matchesUpserted, fetched: result.matchesFetched },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    /* LOUD. A failed re-pull must not be reported as a successful refresh — that is the exact
     * shape of lie this route exists to remove. */
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
