/* ── WHO HAS PLAYED IN THIS CITY ───────────────────────────────────────────────────────────────
 *
 * The played-in half of the confined boundary (see cityConfinement.ts). cityConfinement stays a
 * pure decision with no database in it; this is the evidence-gathering half, and it is the only
 * place that knows which table answers the question.
 *
 * THE SOURCE IS player_match_mv, one row per QUALIFYING SPOT. Its base view player_spots already
 * applies the six predicates that make a spot real — not cancelled, not refunded, not WAITING, not
 * soft-deleted, a non-null user, and a match that is itself neither cancelled nor deleted — so
 * "has a row here" IS "has a non-cancelled match in this city". Re-deriving those six here would
 * be a second definition of a played match.
 *
 * NO TIME FILTER, AND THAT IS A DECISION. player_play_stats counts a play only once the match has
 * KICKED OFF (0134: a booking is not a play), and `plays` / `last_played` keep that meaning. This
 * boundary deliberately does not: someone booked into a Warsaw match next Tuesday is exactly who a
 * new market's operator needs to reach, and making them invisible until kickoff would be a support
 * gap dressed up as consistency. The brief's words were "at least one non-cancelled match, ever".
 *
 * IT IS A MATVIEW, so it lags its base tables by one refresh cycle. That is the same staleness the
 * lookup route's name search already documents, and the boundary is the same shape either way: a
 * player whose first Warsaw match is minutes old may not be visible until the next refresh.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/* PostgREST sends these filters in the URL, so an id list has a real ceiling — roughly 8KB of
 * query string before the request is rejected, which is a few hundred ids. Everything below
 * batches to stay well inside it. */
const ID_BATCH = 200;

/**
 * Which of these player ids have at least one qualifying spot in a match in this city.
 *
 * ON ERROR IT THROWS RATHER THAN RETURNING AN EMPTY SET. An empty set is indistinguishable from
 * "nobody played here", and a swallowed error would silently narrow the boundary back to home city
 * alone — the exact bug this replaces, reintroduced invisibly. `?.length ?? 0` on a failed
 * PostgREST call has already cost this codebase a wrong answer on a different table.
 */
export async function playedInCity(
  sb: SupabaseClient,
  cityName: string,
  ids: readonly number[],
): Promise<Set<number>> {
  const out = new Set<number>();
  const want = ids.filter((n) => Number.isFinite(n));
  if (!cityName || want.length === 0) return out;
  for (let i = 0; i < want.length; i += ID_BATCH) {
    const { data, error } = await sb
      .from("player_match_mv")
      .select("user_id")
      .eq("city_name", cityName)
      .in("user_id", want.slice(i, i + ID_BATCH));
    if (error) throw new Error(`played-in-city lookup failed: ${error.message}`);
    for (const r of data ?? []) {
      const n = Number((r as { user_id: unknown }).user_id);
      if (Number.isFinite(n)) out.add(n);
    }
  }
  return out;
}

/** One player, one question. Used by the profile 403 and the three write gates. */
export async function hasPlayedInCity(
  sb: SupabaseClient,
  cityName: string,
  id: number,
): Promise<boolean> {
  return (await playedInCity(sb, cityName, [id])).has(id);
}

/* ── THE WHOLE SET FOR ONE CITY, AND THE CEILING ON IT ─────────────────────────────────────────
 *
 * The mirror NAME search has to apply the boundary INSIDE the query, not after it: filtering a
 * page after it arrives gives a count belonging to somebody else's page and a "page 2" that skips
 * rows. So the played-in ids have to travel into the query as a literal list, which is bounded by
 * the URL ceiling above.
 *
 * MEASURED 2026-09-19: Warsaw has 97 such players, and Warsaw holds the only two confined accounts
 * that can reach Player Lookup at all. The largest city in the estate is Austin at 7,558, which
 * would NOT fit and has no confined account.
 *
 * SO THE CAP REFUSES RATHER THAN DEGRADES. Over the cap this throws and the route returns 500 with
 * the city named. A silent fallback to post-filtering would answer with a wrong total and a broken
 * page 2, and it would be a code path nobody ever exercises until the day it matters. A loud
 * refusal is a smaller bug than a quiet wrong answer, and the fix when it fires is to move this
 * predicate into SQL beside the finder's.
 */
export const SCOPE_ID_CAP = 2000;

export class ScopeTooLargeError extends Error {
  constructor(public readonly cityName: string, public readonly count: number) {
    super(
      `${cityName} has ${count} players with match history, over the ${SCOPE_ID_CAP} the name ` +
      `search can carry in one query. The city boundary needs to move into SQL beside the ` +
      `finder's predicate before a confined account is created for this city.`,
    );
    this.name = "ScopeTooLargeError";
  }
}

export async function playerIdsWhoPlayedIn(sb: SupabaseClient, cityName: string): Promise<number[]> {
  const ids: number[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("player_match_mv")
      .select("user_id")
      .eq("city_name", cityName)
      .range(from, from + 999);
    if (error) throw new Error(`city scope lookup failed: ${error.message}`);
    for (const r of data ?? []) {
      const n = Number((r as { user_id: unknown }).user_id);
      if (Number.isFinite(n)) ids.push(n);
    }
    // PAGED, BECAUSE POSTGREST CAPS A RESPONSE AT 1000 ROWS AND SAYS NOTHING. An unpaged read of
    // a 7,558-row city returns 1,000 rows that look exactly like a complete answer.
    if ((data ?? []).length < 1000) break;
    from += 1000;
  }
  const unique = [...new Set(ids)];
  if (unique.length > SCOPE_ID_CAP) throw new ScopeTooLargeError(cityName, unique.length);
  return unique;
}

/* A CITY ACCOUNT'S NAME SEARCH, NAME FIRST (Ryan, 2026-11-02). Every player whose name matches, in
 * the search's own order (first name, last name, id), then only those in the city: home city, or a
 * match played there, checked by id against player_match_mv for just these ids. It replaces
 * collecting everyone who ever played in the city first (Austin: 8,149, over SCOPE_ID_CAP, so the
 * search refused after about 5 s). Null when the name is too broad to check (more than
 * NAME_SCAN_CAP matches); the caller says "type more" and never how many there were. */
export const NAME_SCAN_CAP = 5000;
type Builder = { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
export async function nameMatchesInCity(
  sb: SupabaseClient,
  nameQuery: (cols: string, head: boolean) => Builder & PromiseLike<{ count: number | null; error: { message: string } | null }>,
  cityName: string,
): Promise<number[] | null> {
  const head = await nameQuery("id", true);
  if (head.error) throw new Error(`name search failed: ${head.error.message}`);
  const total = head.count ?? 0;
  if (total > NAME_SCAN_CAP) return null;
  const pages = await Promise.all(Array.from({ length: Math.ceil(total / 1000) }, (_, i) => nameQuery("id, preferable_city_name", false).range(i * 1000, i * 1000 + 999)));
  const rows: { id: number; home: string | null }[] = [];
  for (const p of pages) {
    if (p.error) throw new Error(`name search failed: ${p.error.message}`);
    for (const r of (p.data ?? []) as { id: unknown; preferable_city_name: unknown }[]) rows.push({ id: Number(r.id), home: typeof r.preferable_city_name === "string" ? r.preferable_city_name : null });
  }
  const others = rows.filter((r) => r.home !== cityName).map((r) => r.id);
  const played = new Set<number>();
  const chunks = Array.from({ length: Math.ceil(others.length / 500) }, (_, i) => others.slice(i * 500, i * 500 + 500));
  // A row per match played, so a chunk can return more than PostgREST's 1,000-row cap: each chunk
  // is paged until a short page, the chunks side by side.
  await Promise.all(chunks.map(async (ids) => {
    for (let from = 0; ; from += 1000) {
      const a = await sb.from("player_match_mv").select("user_id").eq("city_name", cityName).in("user_id", ids).order("user_id").range(from, from + 999);
      if (a.error) throw new Error(`city scope lookup failed: ${a.error.message}`);
      for (const r of a.data ?? []) played.add(Number((r as { user_id: unknown }).user_id));
      if ((a.data ?? []).length < 1000) break;
    }
  }));
  return rows.filter((r) => r.home === cityName || played.has(r.id)).map((r) => r.id);
}
