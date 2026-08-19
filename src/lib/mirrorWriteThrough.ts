// REFRESH ONE mdapi_matches ROW FROM A CONFIRMED WRITE — the single implementation.
//
// mdapi_matches is a read-only MIRROR of production MatchDay, refreshed by ONE daily cron
// (vercel.json "0 11 * * *" → /api/sync/cron → mdapi-matches). Every Clubhouse screen reads match
// names, managers and times from it, so anything written through the API is invisible in Clubhouse
// until that cron runs — up to ~24 hours. Measured on production: 6 of 6 landed Veo name writes
// were still absent from the mirror an hour later.
//
// This started life inline in the match-edit route for the 🎥 name write. A second write path
// (manager assignment, from the city page) needs exactly the same thing, so it lives here once
// rather than being written again with the same four rules to get wrong.
//
// THE RULES, and every one of them is load-bearing:
//
//   1. PRODUCTION ONLY. mdapi_matches holds PRODUCTION api_ids. Staging ids occupy the same number
//      space, so an ungated refresh rewrites whichever production match happens to share the
//      number. The first draft of the name write-through was missing this and it was caught before
//      it shipped — hence the gate is the first thing checked here.
//   2. ONLY ON LANDED. A mirror claiming a write landed when it did not is worse than a stale one:
//      staleness is a delay, a false mirror is a lie every downstream page repeats.
//   3. THE READ-BACK VALUE, never the value we intended to send. `after` is what recordWrite's own
//      re-read returned, i.e. what MatchDay actually holds.
//   4. BEST-EFFORT. The write it follows has already succeeded; a mirror hiccup must never turn a
//      landed write into a reported failure.

import type { SupabaseClient } from "@supabase/supabase-js";

// MatchDay field → mdapi_matches column. Only fields this app writes are listed: a column that is
// never written cannot go stale from a write.
const COLUMN: Record<string, string> = {
  name: "name",
  managerId: "manager_id",
  secondManagerId: "second_manager_id",
};

type Manager = { firstName?: unknown; lastName?: unknown; email?: unknown } | null | undefined;

/**
 * Refresh the mirror row for one match from a re-read of the API.
 *
 * @param keys  the fields the write actually changed — nothing else is touched, so the rest of the
 *              row keeps whatever the last real sync put there and the next sync overwrites this
 *              the ordinary way.
 * @param after the RE-READ payload. Not the request body.
 */
export async function refreshMatchMirror(
  supabase: SupabaseClient,
  env: string,
  matchApiId: number,
  keys: readonly string[],
  after: Record<string, unknown>,
  outcome: string,
): Promise<{ refreshed: boolean; reason?: string }> {
  if (env !== "production") return { refreshed: false, reason: "not production" };
  if (outcome !== "landed") return { refreshed: false, reason: `outcome ${outcome}` };

  const patch: Record<string, unknown> = {};
  for (const k of keys) {
    const col = COLUMN[k];
    if (!col) continue;                       // a field the mirror does not carry
    if (!(k in after)) continue;              // the re-read did not return it — do not guess
    patch[col] = after[k] ?? null;
  }
  // The manager's NAME is denormalised into the mirror, so a managerId change that left the name
  // columns alone would show the new id beside the OLD person on every screen that reads them.
  if (keys.includes("managerId")) {
    const m = after.manager as Manager;
    patch.manager_id = (after.managerId as number | null) ?? null;
    patch.manager_first_name = (m?.firstName as string | undefined) ?? null;
    patch.manager_last_name = (m?.lastName as string | undefined) ?? null;
    patch.manager_email = (m?.email as string | undefined) ?? null;
  }
  if (Object.keys(patch).length === 0) return { refreshed: false, reason: "no mirrored fields" };

  const { error } = await supabase.from("mdapi_matches").update(patch).eq("api_id", matchApiId);
  if (error) {
    console.warn(`[mirror] mdapi_matches not refreshed for ${matchApiId}: ${error.message}`);
    return { refreshed: false, reason: error.message };
  }
  return { refreshed: true };
}
