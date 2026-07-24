"use client";

// Match-level review rows for the Cities → Match Reviews lens. One row per
// reviewed match, sourced from mdapi_matches (MatchDay's own per-match
// aggregate: star_rating + star_rating_count + manager + field + city +
// start_date). The individual reviews (tags, comments) are joined in the
// component from useReviewData (mdapi_reviews) by (start_date-minute,
// field_title), since reviews carry no match_id.
//
// TWO SOURCES, TWO SYNC STAMPS — and they are not interchangeable:
//   • the Rating / Reviews COLUMNS come from mdapi_matches → stamped by
//     the `mdapi-matches` sync.
//   • the drilldown tags + comments come from mdapi_reviews → stamped by
//     the `mdapi-reviews` sync.
// The lens used to show only the mdapi-reviews stamp, which let the badge
// read "synced 10 minutes ago" while the numbers on screen came from a
// matches pull many hours older. Both stamps are returned now so the
// footer can label what it actually renders. (See the Soccer Central
// 7/22 case: reviews were current, the 4/3.75 aggregate was 13h stale.)
//
// A future platform change adding match_id to /admin/matches/reviews would
// let us key the join precisely and upgrade the grain.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { normalizeCity } from "./cityMap";
import { isPastMatch } from "./matchTime";
import { useRevalidateWhenStale } from "./cacheFreshness";

export type MatchReviewRow = {
  apiId: number;
  startDate: string; // raw ISO from mdapi_matches
  fieldTitle: string;
  city: string; // normalized cockpit city
  managerFirstName: string | null;
  managerLastName: string | null;
  avgRating: number; // star_rating
  reviewCount: number; // star_rating_count
};

type State = {
  rows: MatchReviewRow[];
  // Stamps the Rating / Reviews columns — this is the honest stamp for
  // the numbers this hook returns.
  matchesSyncedAt: string | null;
  // Stamps the joined tags/comments the lens pulls from useReviewData.
  reviewsSyncedAt: string | null;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = {
  rows: [],
  matchesSyncedAt: null,
  reviewsSyncedAt: null,
  loading: true,
  error: null,
};

// Module-level cache + pub/sub, mirroring useReviewData — the lens mounts /
// unmounts as the user switches lenses; we don't want to refetch each time.
// `loadedAt` is what makes the cache expirable: without it a tab left open
// served the first fetch forever.
let cached: State | null = null;
let loadedAt: number | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

type MatchSelect = {
  api_id: number;
  field_title: string | null;
  city_name: string | null;
  start_date: string | null; // venue-local wall-clock (fake +00:00) — display
  start_date_utc: string | null; // true UTC instant — time comparisons
  manager_first_name: string | null;
  manager_last_name: string | null;
  star_rating: number | null;
  star_rating_count: number | null;
};

// Latest successful completion for one fin_sync_log source.
async function lastSyncFor(source: string): Promise<string | null> {
  const res = await supabase
    .from("fin_sync_log")
    .select("completed_at")
    .eq("source", source)
    .not("completed_at", "is", null)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ completed_at: string }>();
  return res.data?.completed_at ?? null;
}

// `silent` keeps the currently-cached rows on screen while a background
// revalidation runs. Only the first load (and an explicit hard refetch)
// flips `loading`, so a focus-triggered refresh never blanks the lens.
async function load(silent = false): Promise<void> {
  if (!silent || !cached) publish({ ...INITIAL, loading: true });
  try {
    const [raw, matchesSyncedAt, reviewsSyncedAt] = await Promise.all([
      selectAll<MatchSelect>(() =>
        supabase
          .from("mdapi_matches")
          .select(
            "api_id, field_title, city_name, start_date, start_date_utc, manager_first_name, manager_last_name, star_rating, star_rating_count",
          )
          .gt("star_rating_count", 0)
          .is("deleted_at", null)
          .order("start_date", { ascending: true })
          .order("api_id", { ascending: true }),
      ),
      lastSyncFor("mdapi-matches"),
      lastSyncFor("mdapi-reviews"),
    ]);

    // A match can only be genuinely reviewed AFTER it's played. The MatchDay
    // API stamps a recurring series' rolling star_rating onto every FUTURE
    // instance (e.g. tonight's ATH Katy shows 5.0/8 before anyone plays it),
    // so star_rating_count>0 alone surfaces phantom future rows. Exclude any
    // match whose TRUE instant (start_date_utc) is in the future — never
    // start_date, whose fake +00:00 offset lands ~5h early and lets this
    // evening's not-yet-played matches slip through.
    const nowMs = Date.now();
    const rows: MatchReviewRow[] = [];
    for (const r of raw) {
      if (!r.start_date || r.star_rating == null || !r.star_rating_count) continue;
      if (!isPastMatch(r.start_date_utc, r.start_date, nowMs)) continue; // future / unparseable
      const city = normalizeCity(r.city_name);
      if (!city) continue; // drop cities cockpit has no infra for (e.g. NYC)
      rows.push({
        apiId: r.api_id,
        startDate: r.start_date,
        fieldTitle: r.field_title ?? "",
        city,
        managerFirstName: r.manager_first_name,
        managerLastName: r.manager_last_name,
        avgRating: Number(r.star_rating),
        reviewCount: Math.round(Number(r.star_rating_count)),
      });
    }
    loadedAt = Date.now();
    publish({
      rows,
      matchesSyncedAt,
      reviewsSyncedAt,
      loading: false,
      error: null,
    });
  } catch (e) {
    // A failed BACKGROUND revalidation must not wipe good cached rows —
    // leave the cache in place and let the next signal retry. Only a
    // foreground load surfaces the error.
    if (silent && cached) return;
    loadedAt = null;
    publish({
      rows: [],
      matchesSyncedAt: null,
      reviewsSyncedAt: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load match reviews.",
    });
  }
}

function ensureLoad(silent = false) {
  if (pending) return;
  pending = load(silent).finally(() => {
    pending = null;
  });
}

export function useMatchReviews(): State {
  const [state, setState] = useState<State>(cached ?? INITIAL);
  useEffect(() => {
    subscribers.add(setState);
    if (cached) setState(cached);
    else ensureLoad();
    return () => {
      subscribers.delete(setState);
    };
  }, []);

  // Expire the module cache on focus / visibility / poll so an open tab
  // stops rendering yesterday's numbers.
  useRevalidateWhenStale(
    () => loadedAt,
    () => ensureLoad(true),
  );

  return state;
}

// Force a refetch regardless of cache age — for the /data "Sync now"
// buttons, which know the underlying tables just changed.
export async function refetchMatchReviews(): Promise<void> {
  loadedAt = null;
  await load(true);
}
