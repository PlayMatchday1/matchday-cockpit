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
/* ── EVERY EDITABLE FIELD THE MIRROR CARRIES, NOT A HANDFUL ───────────────────────────────────
 * THIS MAP WAS THE BUG. It held four entries — name, managerId, secondManagerId, isCancelled —
 * so editing a match's TIME called refreshMatchMirror, found no COLUMN["startDate"], skipped
 * every key, and returned {refreshed:false, reason:"no mirrored fields"} SILENTLY. The call was
 * always there; the map was not. The operator edited the time, pressed Refresh, and the Master
 * Schedule re-read a mirror row nothing had touched — for up to 24 hours, until the daily cron.
 *
 * Master Schedule renders name, city_identifier, field_title, start_date and is_cancelled
 * (veoSchedule.ts:97). Two of those five were mirrored. THE TIME AND THE FIELD WERE NOT.
 *
 * The rule now: if the app can write it and mdapi_matches has a column for it, it is here. A
 * field absent from this map is a field that goes stale on every edit, silently, and the silence
 * is the part that cost a day. */
const COLUMN: Record<string, string> = {
  name: "name",
  description: "description",
  type: "type",
  category: "category",
  managerId: "manager_id",
  secondManagerId: "second_manager_id",
  /* WALL CLOCK, STORED VERBATIM. start_date carries a Z it does not mean. `after` is the API's own
   * re-read, so the string that goes in is byte-identical to the one the sync would have written —
   * no Date is constructed anywhere on this path, and none may be. */
  startDate: "start_date",
  endDate: "end_date",
  fieldId: "field_id",
  minPlayerCount: "min_player_count",
  maxPlayerCount: "max_player_count",
  maxTeamSize2Team: "max_team_size_2team",
  maxTeamSize4Team: "max_team_size_4team",
  guestCount: "guest_count",
  registrationPrice: "registration_price",
  additionalSpotPrice: "additional_spot_price",
  isFreeMember: "is_free_member",
  isAutoBump: "is_auto_bump",
  autoCanceled: "auto_canceled",
  autoCanceledMinutes: "auto_canceled_minutes",
  /* CANCEL. The Master Schedule reads is_cancelled OUT of this mirror (veoSchedule.ts filters on
   * it), so a cancel that landed in MatchDay left the match on the week grid until the daily cron
   * — the operator cancelled it, watched it stay, and had no way to tell whether it worked. It is
   * the same three rules as every other column here: production only, only on landed, from the
   * re-read. */
  isCancelled: "is_cancelled",
};

/* NOT MIRRORED, AND DELIBERATELY SO — every one of these is a field the app can write for which
 * mdapi_matches has NO column, so there is nothing to go stale:
 *   managerIntro, fakeSpotLeft36h / 24h / 12h / 6h / 3h
 * The loop below skips an unmapped key rather than guessing a column name. */

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
  /* THE FIELD'S NAME IS DENORMALISED TOO, for exactly the reason the manager's is: Master
   * Schedule renders field_title, so a fieldId change that left it alone would show the new id
   * beside the OLD pitch on the one screen this write-through exists to keep honest. */
  if (keys.includes("fieldId")) {
    const f = after.field as { title?: unknown; address?: unknown; zipCode?: unknown } | null | undefined;
    patch.field_id = (after.fieldId as number | null) ?? null;
    if (f && typeof f === "object") {
      patch.field_title = (f.title as string | undefined) ?? null;
      patch.field_address = (f.address as string | undefined) ?? null;
      patch.field_zipcode = (f.zipCode as string | undefined) ?? null;
    }
  }
  if (Object.keys(patch).length === 0) return { refreshed: false, reason: "no mirrored fields" };
  /* THE ROW IS NOW NEWER THAN THE LAST SYNC, AND IT MUST SAY SO. The Master Schedule stamps its
   * freshness from max(synced_at), so a write-through that did not move it would leave the page
   * reporting the cron's time over data the cron never saw. */
  patch.synced_at = new Date().toISOString();

  const { error } = await supabase.from("mdapi_matches").update(patch).eq("api_id", matchApiId);
  if (error) {
    console.warn(`[mirror] mdapi_matches not refreshed for ${matchApiId}: ${error.message}`);
    return { refreshed: false, reason: error.message };
  }
  return { refreshed: true };
}
