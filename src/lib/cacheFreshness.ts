"use client";

// Client-side cache invalidation for the module-level data caches
// (useMatchReviews, useReviewData).
//
// Why this exists: those hooks cache their fetch at MODULE level so
// switching lenses doesn't refetch. That was the right call for lens
// churn, but it also meant a tab left open overnight kept rendering
// yesterday's numbers — the cache had no expiry and no revalidation,
// so only a full page reload could correct it. Cockpit is a dashboard
// people leave open; "the tab is stale" is indistinguishable from
// "the data is wrong."
//
// The rule here: a cache older than STALE_AFTER_MS is revalidated on
// the next signal that someone is actually looking — tab focus,
// visibility change, or the poll tick. Revalidation is silent (the
// hooks keep serving the cached rows while the refetch runs), so the
// UI never flashes a loading state on a background refresh.

import { useEffect, useRef } from "react";

// How old a cached payload may be before the next visibility/focus/
// poll signal triggers a background refetch. Tuned against the sync
// cadence — no point revalidating far faster than the server-side
// sync produces new rows.
export const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

// How often a mounted hook checks its own staleness. Cheap: the tick
// only fires a network read when isStale() says the payload has aged
// past STALE_AFTER_MS.
export const REVALIDATE_POLL_MS = 60 * 1000; // 1 minute

// Pure staleness predicate — the whole decision, isolated so it can be
// tested without a DOM. A null loadedAt means "never loaded", which is
// stale by definition.
export function isStale(
  loadedAtMs: number | null,
  nowMs: number,
  staleAfterMs: number = STALE_AFTER_MS,
): boolean {
  if (loadedAtMs == null) return true;
  // Guard against a clock that jumped backwards: a future loadedAt
  // would otherwise pin the cache as fresh forever.
  if (loadedAtMs > nowMs) return true;
  return nowMs - loadedAtMs >= staleAfterMs;
}

// Wires the revalidation signals for a module-cached hook. `getLoadedAt`
// reads the cache's load timestamp at call time (not at mount), so the
// hook can't close over a stale value. `revalidate` is expected to be
// idempotent and self-deduping — these hooks already guard concurrent
// loads with a module-level `pending` promise.
export function useRevalidateWhenStale(
  getLoadedAt: () => number | null,
  revalidate: () => void,
  staleAfterMs: number = STALE_AFTER_MS,
): void {
  // Keep the latest callbacks in a ref so the effect body can stay
  // mount-only — re-subscribing on every render would thrash the
  // listeners.
  const ref = useRef({ getLoadedAt, revalidate });
  ref.current = { getLoadedAt, revalidate };

  useEffect(() => {
    const check = () => {
      if (isStale(ref.current.getLoadedAt(), Date.now(), staleAfterMs)) {
        ref.current.revalidate();
      }
    };

    // Tab-focus / visibility: the moment someone looks at the tab
    // again is exactly when stale numbers matter.
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);

    // Poll tick for the tab that stays visible and untouched (a wall
    // display, a second monitor) — focus/visibility never fire there.
    const timer = window.setInterval(check, REVALIDATE_POLL_MS);

    // Check once on mount too: remounting the lens after a long idle
    // should not wait a full poll interval to correct itself.
    check();

    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [staleAfterMs]);
}
