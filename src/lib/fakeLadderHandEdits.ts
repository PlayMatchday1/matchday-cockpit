/* WHICH MATCHES HAD THEIR LADDER OR "SPOTS LEFT NOW" CHANGED BY HAND — read from change_log.
 * The rule for a row is isHandLadderEdit (fakeLadder.ts); this only fetches. Server-only: it takes
 * the service-role client the route already holds. Scoped to one environment: change_log holds
 * staging writes too, and a staging id must never mark a production match.
 *
 * A FAILED READ RETURNS ok:false, NEVER AN EMPTY MAP. An empty map means "nobody edited anything",
 * which would put every hand-set ladder into the bulk write. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isHandLadderEdit, type ChangeLogRow } from "./fakeLadder";

export async function handEditsFor(
  supabase: SupabaseClient, env: string, matchIds: number[],
): Promise<{ ok: true; byMatch: Map<number, { source: string; at: string }> } | { ok: false; error: string }> {
  const byMatch = new Map<number, { source: string; at: string }>();
  const ids = [...new Set(matchIds.filter((n) => Number.isFinite(n)))];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("change_log")
        .select("match_id, source, method, endpoint, outcome, request_body, created_at")
        .eq("env", env).in("match_id", chunk).order("created_at", { ascending: false }).range(from, from + 999);
      if (error) return { ok: false, error: error.message };
      for (const r of (data ?? []) as (ChangeLogRow & { created_at: string })[]) {
        if (r.match_id == null || !isHandLadderEdit(r)) continue;
        // Newest first, so the first hit per match is the most recent hand change.
        if (!byMatch.has(Number(r.match_id))) byMatch.set(Number(r.match_id), { source: String(r.source ?? ""), at: r.created_at });
      }
      if (!data || data.length < 1000) break;
    }
  }
  return { ok: true, byMatch };
}
