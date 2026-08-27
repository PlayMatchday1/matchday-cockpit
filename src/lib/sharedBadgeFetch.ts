// ONE REQUEST PER PAGE, NOT ONE PER MOUNTED BADGE.
//
// THE NAV BADGES EACH FETCHED FOR THEMSELVES. ChatsRail and MatchOpsSectionSheet both live in the
// internal layout and both call the same four hooks; TopNav and MobileBottomNav call two of them
// again. Every one of those hooks ran its own useEffect with its own fetch, so a single cold page
// load measured:
//
//     4×  /api/crm/threads/awaiting-count
//     2×  /api/manager-pay/week
//     2×  /api/partner-dashboards/actionable      ← ~7s each before it was parallelised
//     2×  supabase rest/v1/app_users
//
// Nine requests for four distinct answers, on every page in the app. None of them block anything on
// screen, which is exactly why it went unnoticed — the cost is entirely server-side and entirely
// invisible.
//
// THIS IS A SINGLE FLIGHT PLUS A SHORT TTL, the same shape as the Data Room's fact table:
//   · callers arriving while a request is in flight AWAIT THAT REQUEST rather than starting another;
//   · a result is reused for TTL_MS afterwards, so a second component mounting a moment later gets
//     the answer without a round trip;
//   · `refetch` bypasses the TTL, because a badge that will not refresh on demand is worse than a
//     badge that costs a request.
//
// IT IS DELIBERATELY NOT A REACT CONTEXT. A provider would mean threading one through every layout
// that renders a badge, and these hooks are called from four different trees. A module-level map is
// the smaller change and has the same effect.

type Entry = { at: number; value: unknown; inFlight: Promise<unknown> | null };

const cache = new Map<string, Entry>();

/** How long a fetched answer is reused. Long enough to cover one page's mounts, short enough that
 *  a badge is never meaningfully stale — these are counts that change on a human timescale. */
export const BADGE_TTL_MS = 10_000;

/** Test/telemetry: how many real network calls this module has made, and how many it saved. */
let fetches = 0;
let shared = 0;
export const badgeFetchStats = () => ({ fetches, shared, cached: cache.size });
export const resetBadgeFetchStats = () => { fetches = 0; shared = 0; cache.clear(); };

/**
 * Fetch `key` at most once per TTL across every caller.
 *
 * `force` skips the TTL but still joins an in-flight request — two components pressing refresh at
 * the same moment should produce one call, not two.
 */
export async function sharedFetch<T>(key: string, run: () => Promise<T>, force = false): Promise<T> {
  const hit = cache.get(key);
  if (hit?.inFlight) { shared++; return hit.inFlight as Promise<T>; }
  if (hit && !force && Date.now() - hit.at < BADGE_TTL_MS) { shared++; return hit.value as T; }

  const p = run()
    .then((value) => {
      cache.set(key, { at: Date.now(), value, inFlight: null });
      return value;
    })
    .catch((e) => {
      /* A FAILURE IS NOT CACHED. The entry is dropped so the next caller retries rather than
       * inheriting an error for the rest of the TTL — but the in-flight slot is always released,
       * or one failed call would wedge every badge on the page. */
      cache.delete(key);
      throw e;
    });
  fetches++;
  cache.set(key, { at: hit?.at ?? 0, value: hit?.value, inFlight: p });
  return p;
}
