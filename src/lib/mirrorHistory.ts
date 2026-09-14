import "server-only";

/* THE MIRROR'S MATCH HISTORY FOR ONE PLAYER — one query, used by both surfaces.
 *
 * The MatchDay API omits every booking whose MATCH was cancelled (five players measured, five
 * omitted — see docs/matchday-api-facts.md), so these rows are the only way either surface can show
 * a match the club called off. That is the row an operator points at when a player asks where their
 * money went.
 *
 * WHY IT IS A SHARED FUNCTION AND NOT TWO QUERIES. The first version had Player Lookup reading
 * mdapi_matches.name and the chat pane reading field_title, so the same cancelled match appeared as
 * "🎥 Parmer Stadium - Premier" on one surface and "PARMER Stadium" on the other — two names for one
 * match, on two screens an operator moves between mid-conversation. The merge rules were already
 * shared; the query that feeds them has to be too.
 *
 * It is server-only because it takes a Supabase client. The RULES it feeds (mergeHistory,
 * attachCharges) live in matchHistory.ts, which is pure, because Player Lookup applies the charge
 * join in the browser.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveMatchState, type MirrorRow } from "@/lib/matchHistory";

export async function loadMirrorHistory(
  supabase: SupabaseClient,
  playerId: number,
  now: number = Date.now(),
): Promise<MirrorRow[]> {
  try {
    const regs = await supabase
      .from("mdapi_match_players")
      /* canceled_at IS THE AMERICAN SPELLING, as the column is. Two other call sites already
       * select it; this path did not, which is why the row could say THAT he cancelled and never
       * WHEN. How close to kickoff he pulled out is the fact that decides the money. */
      .select("match_api_id, is_cancelled, canceled_at")
      .eq("user_id", playerId)
      .is("deleted_at", null);
    if (regs.error) throw new Error(regs.error.message);
    const ids = [...new Set((regs.data ?? [])
      .map((r) => r.match_api_id as number)
      .filter((x): x is number => typeof x === "number"))];
    if (!ids.length) return [];

    const ms = await supabase
      .from("mdapi_matches")
      .select("api_id, name, field_title, start_date, start_date_utc, is_cancelled")
      .in("api_id", ids)
      .is("deleted_at", null);
    if (ms.error) throw new Error(ms.error.message);

    // A player who booked two spots has two registration rows for one match; a cancellation on
    // ANY of them is a cancellation by the player. De-duplication to one row per match happens in
    // mergeHistory.
    const playerCancelled = new Map<number, boolean>();
    /* THE EARLIEST cancellation across a player's registrations for one match. Two spots booked and
     * cancelled a minute apart is one decision, and the first instant is the one that describes it. */
    const playerCancelledAt = new Map<number, string>();
    for (const r of regs.data ?? []) {
      const id = r.match_api_id as number;
      playerCancelled.set(id, (playerCancelled.get(id) ?? false) || r.is_cancelled === true);
      const at = r.canceled_at as string | null;
      if (r.is_cancelled === true && at) {
        const cur = playerCancelledAt.get(id);
        if (!cur || Date.parse(at) < Date.parse(cur)) playerCancelledAt.set(id, at);
      }
    }

    return (ms.data ?? []).map((m) => {
      const utc = (m.start_date_utc as string | null) ?? null;
      const upcoming = !!utc && Date.parse(utc) > now;
      const pc = playerCancelled.get(m.api_id as number) === true;
      const cc = m.is_cancelled === true;
      return {
        matchId: m.api_id as number,
        name: (m.name as string | null) ?? (m.field_title as string | null) ?? `Match ${m.api_id}`,
        // startDate DISPLAYS (wall clock); startDateUtc ORDERS (true instant). Never swapped.
        startDate: (m.start_date as string | null) ?? null,
        startDateUtc: utc,
        /* BOTH FACTS SURVIVE. This used to collapse them with "the club's cancellation outranks
         * the player's", which is true about the MATCH and wrong about this player: his own
         * cancellation is the half that decides whether he is owed anything. The state is derived
         * from the pair in matchHistory, so this path and playerProfile cannot disagree again. */
        playerCancelled: pc,
        clubCancelled: cc,
        playerCancelledAt: playerCancelledAt.get(m.api_id as number) ?? null,
        state: deriveMatchState({ playerCancelled: pc, clubCancelled: cc, upcoming }),
      } satisfies MirrorRow;
    });
  } catch (e) {
    // A mirror outage costs the cancelled rows, not the page.
    console.error("[mirrorHistory] failed", e);
    return [];
  }
}
