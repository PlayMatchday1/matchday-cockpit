/* POST /api/veo/live-counts?from=YYYY-MM-DD&to=YYYY-MM-DD: keep the Month view's UPCOMING player
 * counts live (Ryan, 2026-10-28).
 *
 * ── WHAT IT DOES ──────────────────────────────────────────────────────────────────────────────
 * The Month view reads player counts from the mdapi_matches MIRROR (/api/veo/range). This route
 * re-pulls the upcoming part of the visible span from MatchDay into that mirror, but ONLY when the
 * mirror is more than FRESH_MS old for those days. The page calls it on open and every 5 minutes
 * while Month is on screen, then re-reads /api/veo/range if anything was pulled.
 *
 * PAST DAYS ARE NEVER RE-PULLED. A finished match does not change; the window starts at today
 * (America/Chicago calendar date, compared against start_date's wall-clock date part).
 *
 * ── WHY THE COUNTS EQUAL GAMEDAY OPS ──────────────────────────────────────────────────────────
 * Gameday Ops reads GET /admin/matches live and takes `_count.players` / `_count.fakePlayers` off
 * each row (gamedayModel.realCount). This re-pull reads the SAME list endpoint through the one
 * sync (syncMdapiMatches, matchesOnly: no roster crawl), which stores those two numbers verbatim as
 * player_count / fake_player_count (mdapiMatchesSync.ts:950), and monthGrid.realCount applies the
 * same players minus fakes rule. Same source, same two numbers, same subtraction.
 *
 * ── THE PRODUCTION API RULE ───────────────────────────────────────────────────────────────────
 * One list call per 100 matches, no per-match calls, 2 seconds between calls (paced client), no
 * retries, stop at the first error. Shared across viewers two ways: the mirror's own age (any
 * viewer's pull makes the rows fresh for everyone), and an in-process gate so concurrent requests
 * on the same instance join one pull instead of starting their own.
 *
 * ── CONFINED ACCOUNTS ─────────────────────────────────────────────────────────────────────────
 * Allowed (exact route, cityConfinement.ts). The pull is fleet-wide because the API has no city
 * filter, but a caller chooses only the window, the window is upcoming days only and capped, and
 * the 5-minute gate means calling it again changes nothing. It writes only what the nightly sync
 * writes. The response carries timestamps only, never a match.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authenticateCrm } from "@/lib/crmAuth";
import { syncMdapiMatches } from "@/lib/mdapiMatchesSync";
import { getPacedClient } from "@/lib/matchdayApi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** Older than this and the upcoming counts are re-pulled. */
const FRESH_MS = 5 * 60_000;
/** The padded month grid is at most six weeks; anything wider is not this page asking. */
const MAX_DAYS = 45;
/** Production API rule: at most one request every 2 seconds. */
const PACE_MS = 2000;

const todayChicago = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/* THE IN-PROCESS GATE. One pull per window at a time on this instance, and none again within
 * FRESH_MS of the last one even if a row the API no longer lists keeps the mirror's minimum old. */
const inflight = new Map<string, Promise<void>>();
const lastPull = new Map<string, number>();

/** The OLDEST synced_at among the window's live rows: how old the stalest count on screen is. */
async function oldestSync(sb: SupabaseClient, from: string, to: string): Promise<string | null> {
  const { data, error } = await sb.from("mdapi_matches").select("synced_at")
    .is("deleted_at", null).gte("start_date", from).lte("start_date", `${to}T23:59:59`)
    .order("synced_at", { ascending: true }).limit(1);
  if (error) throw new Error(`live counts: ${error.message}`);
  return (data?.[0] as { synced_at?: string | null } | undefined)?.synced_at ?? null;
}

export async function POST(req: Request) {
  const auth = await authenticateCrm(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!ISO.test(from) || !ISO.test(to)) return Response.json({ error: "from and to are required as YYYY-MM-DD" }, { status: 400 });
  if (to < from) return Response.json({ error: "to is before from" }, { status: 400 });

  const today = todayChicago();
  const upFrom = from > today ? from : today;
  // Nothing upcoming on screen: past days keep reading the mirror and there is nothing to do.
  if (to < upFrom) return Response.json({ upcoming: false, pulled: false, asOf: null }, { headers: { "Cache-Control": "no-store" } });
  if (daysBetween(upFrom, to) > MAX_DAYS) return Response.json({ error: `Window is too wide; the most is ${MAX_DAYS + 1} days.` }, { status: 400 });

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const key = `${upFrom}|${to}`;

  try {
    const oldest = await oldestSync(sb, upFrom, to);
    const age = oldest ? Date.now() - Date.parse(oldest) : Infinity;
    const recent = Date.now() - (lastPull.get(key) ?? 0) < FRESH_MS;
    if (age <= FRESH_MS || (recent && !inflight.has(key))) {
      return Response.json({ upcoming: true, pulled: false, asOf: oldest }, { headers: { "Cache-Control": "no-store" } });
    }
    let run = inflight.get(key);
    const started = new Date().toISOString();
    if (!run) {
      run = (async () => {
        try {
          await syncMdapiMatches(sb, { fromDate: upFrom, toDate: to, matchesOnly: true, client: getPacedClient({ paceMs: PACE_MS }) });
          lastPull.set(key, Date.now());
        } finally { inflight.delete(key); }
      })();
      inflight.set(key, run);
    }
    await run;
    /* THE STAMP IS THE PULL, once one has landed. Every row the API listed was written at or after
     * `started`; a row the API no longer lists is tombstoned by the sync, not left to age the stamp. */
    const after = await oldestSync(sb, upFrom, to);
    const asOf = after && after > started ? after : started;
    return Response.json({ upcoming: true, pulled: true, asOf }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    /* LOUD. The page keeps the mirror's counts and says how old they are; it never claims live. */
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
