/* GET /api/lapsed-spots — READ ONLY. There is no POST, PUT, PATCH or DELETE in this file and no
 * write path anywhere behind this page. It reads three mirror tables and returns the model's view.
 *
 * TODAY IS THE SERVER'S, and it is a STRING. The wall-clock comparison is YYYY-MM-DD text against
 * YYYY-MM-DD text, so the only Date here produces today's date in the operating timezone and never
 * touches a match's start_date — which carries a Z it does not mean.
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
    const subs: SubRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from("mdapi_subscriptions")
        .select("user_id, status, canceled_at, cancel_reason").range(from, from + PAGE - 1);
      if (error) throw new Error(`mdapi_subscriptions: ${error.message}`);
      subs.push(...((data ?? []) as unknown as SubRow[]));
      if ((data ?? []).length < PAGE) break;
    }

    return Response.json({ today, ...buildLapsedSpots(matches, spots, subs, today) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // LOUD. The page renders this as an error, never as an empty list.
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
