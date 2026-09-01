/* GET /api/lapsed-spots — READ ONLY. There is no POST, PUT, PATCH or DELETE in this file and no
 * write path anywhere behind this page. It reads three mirror tables and returns the model's view.
 *
 * TODAY IS THE SERVER'S, and it is a STRING. The wall-clock comparison is YYYY-MM-DD text against
 * YYYY-MM-DD text, so the only Date here produces today's date in the operating timezone and never
 * touches a match's start_date — which carries a Z it does not mean.
 *
 * IT ALSO READS change_log FOR THE "Removed" TAB — one bounded, indexed read, so that tab
 * survives a reload instead of living in session state.
 *
 * IT PAGES, AND A PAGING ERROR IS THROWN, NOT SWALLOWED. `?.length ?? 0` on a failed page returns
 * a confident zero, which on this page is indistinguishable from "nobody lapsed" — the exact
 * failure the denominator exists to catch. Every page checks `error` and throws.
 */

import { authenticateMatchOpsRead } from "@/lib/matchOpsAuth";
import { buildLapsedSpots, type MatchRow, type SpotRow, type SubRow } from "@/lib/lapsedSpots";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PAGE = 1000;

/** KEYSET ON api_id, not range(): the sync inserts into these tables while we read, and an offset
 *  page can skip or repeat a row across the boundary. */
async function pageAll<T extends { api_id: number }>(sb: SupabaseClient, table: string, cols: string,
  tune: (q: any) => any = (q) => q): Promise<T[]> {
  const out: T[] = [];
  for (let last = 0; ; ) {
    const { data, error } = await tune(sb.from(table).select(cols).gt("api_id", last).order("api_id").limit(PAGE));
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    last = rows[rows.length - 1].api_id;
  }
  return out;
}

export async function GET(req: Request) {
  const auth = await authenticateMatchOpsRead(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const sb = auth.supabase;

  // The operating timezone's today, as text. America/Chicago is where the estate's days are named.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
  /* AND THE CURRENT TIME, IN THE SAME ZONE. The already-started rule compares a match's kickoff
   * against this; deriving one in Chicago and the other anywhere else would mark a 7pm match as
   * started at 2pm. hour12:false so "24:xx" never appears — it would sort above every real time. */
  const nowHm = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());

  try {
    const matches = await pageAll<MatchRow & { api_id: number }>(
      sb, "mdapi_matches", "api_id, name, start_date, is_cancelled, city_name, field_title",
      (q) => q.is("deleted_at", null).eq("is_cancelled", false).gte("start_date", today),
    );
    const ids = new Set(matches.map((m) => m.api_id));
    // Only the spots on those matches: a full read of mdapi_match_players is 246k rows.
    const spots: SpotRow[] = [];
    const idList = [...ids];
    for (let i = 0; i < idList.length; i += 200) {
      const { data, error } = await sb
        .from("mdapi_match_players")
        .select("api_id, match_api_id, user_id, user_email, user_first_name, user_last_name, paid_status, user_type, amount, is_cancelled, user_is_fake_player, is_first_match")
        .in("match_api_id", idList.slice(i, i + 200))
        .is("deleted_at", null);
      if (error) throw new Error(`mdapi_match_players: ${error.message}`);
      spots.push(...((data ?? []) as unknown as SpotRow[]));
    }
    // member_email is read for the STAFF FILTER only. A staff member can hold a subscription
    // under an address different from the one on the roster row, so both are tested.
    const subs: SubRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from("mdapi_subscriptions")
        .select("user_id, status, canceled_at, cancel_reason, member_email").range(from, from + PAGE - 1);
      if (error) throw new Error(`mdapi_subscriptions: ${error.message}`);
      subs.push(...((data ?? []) as unknown as SubRow[]));
      if ((data ?? []).length < PAGE) break;
    }

    /* ── THE REMOVED TAB, READ FROM change_log ────────────────────────────────────────────────
     * DURABLE, NOT SESSION STATE. Every removal already goes through recordWrite, and change_log
     * is indexed on created_at desc, so this is one bounded indexed read — cheap enough that
     * falling back to session state would be a choice to lose the history on reload for nothing.
     * source = "Lapsed spots" is what the client sends on the roster op, so this returns only
     * what THIS page removed and never another surface's roster edits. */
    const removedRes = await sb.from("change_log")
      .select("id, created_at, actor_name, match_id, match_name, outcome, changes, endpoint")
      .eq("source", "Lapsed spots").eq("method", "DELETE")
      .order("created_at", { ascending: false }).limit(200);
    if (removedRes.error) throw new Error(`change_log: ${removedRes.error.message}`);
    const logRows = (removedRes.data ?? []) as Record<string, unknown>[];
    /* The log stores the match NAME but not its date or city — join those from the mirror by
     * match_id rather than duplicating them into the log, which has a longer life and different
     * access rules than a convenience column deserves. */
    const logMatchIds = [...new Set(logRows.map((r) => Number(r.match_id)).filter(Boolean))];
    const mInfo = new Map<number, { date: string; city: string; field: string }>();
    for (let i = 0; i < logMatchIds.length; i += 200) {
      const { data } = await sb.from("mdapi_matches")
        .select("api_id, start_date, city_name, field_title").in("api_id", logMatchIds.slice(i, i + 200));
      for (const m of (data ?? []) as Record<string, unknown>[]) {
        mInfo.set(Number(m.api_id), {
          date: String(m.start_date ?? "").slice(0, 10),
          city: String(m.city_name ?? "—"), field: String(m.field_title ?? "—"),
        });
      }
    }
    const removed = logRows.map((r) => {
      const ch = (r.changes as { key?: string; before?: unknown }[] | null) ?? [];
      const who = ch.find((c) => c.key === "remove")?.before;
      const info = mInfo.get(Number(r.match_id));
      return {
        id: String(r.id),
        name: typeof who === "string" && who ? who : "—",
        matchId: Number(r.match_id) || null,
        matchName: String(r.match_name ?? "—"),
        date: info?.date ?? "—",
        city: info?.city ?? "—",
        field: info?.field ?? "—",
        removedAt: String(r.created_at),
        by: String(r.actor_name ?? "—"),
        verdict: String(r.outcome),
      };
    });

    /* ── A REMOVED ROW MUST LEAVE THE LIVE LIST IMMEDIATELY ───────────────────────────────────
     * mdapi_match_players is a NIGHTLY MIRROR. A spot removed at 2pm is gone from the MatchDay
     * roster instantly but stays in the mirror until the next sync, so without this the row would
     * sit in "To remove" all afternoon, still ticked, inviting a second removal of something
     * already gone — which reads as FAILED (404) and wastes the operator's confidence.
     *
     * The endpoint recorded in change_log is /admin/matches/user-matches/{userMatchId}, and
     * mdapi_match_players.api_id IS that userMatchId, so the join is exact rather than a guess by
     * name and date. ONLY landed removals suppress: a FAILED or NOT APPLIED row did not remove
     * anything and its spot must stay in the list. */
    const removedUmIds = new Set(
      logRows.filter((r) => r.outcome === "landed")
        .map((r) => Number(String(r.endpoint ?? "").split("/").pop()))
        .filter((n) => Number.isFinite(n) && n > 0),
    );
    const liveSpots = spots.filter((sp) => !removedUmIds.has(Number((sp as { api_id: number }).api_id)));

    return Response.json({
      today, nowHm, removed,
      // Stated so a reader can tell a suppressed row from a synced-away one.
      suppressed: spots.length - liveSpots.length,
      ...buildLapsedSpots(matches, liveSpots, subs, today, nowHm),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. The page renders this as an error, never as an empty list.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
