"use client";

// Match-level review rows for the Cities → Match Reviews lens. One row per
// reviewed match, sourced from mdapi_matches (MatchDay's own per-match
// aggregate: star_rating + star_rating_count + manager + field + city +
// start_date). The individual reviews (tags, comments) are joined in the
// component from useReviewData (mdapi_reviews) by (start_date-minute,
// field_title), since reviews carry no match_id.
//
// Both sources are stale snapshots synced daily; the lens shows a "reviews
// synced as of <ts>" note so the staleness is honest. A future platform
// change adding match_id to /admin/matches/reviews would let us key the
// join precisely and upgrade the grain.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { normalizeCity } from "./cityMap";

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
  syncedAt: string | null;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { rows: [], syncedAt: null, loading: true, error: null };

// Module-level cache + pub/sub, mirroring useReviewData — the lens mounts /
// unmounts as the user switches lenses; we don't want to refetch each time.
let cached: State | null = null;
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
  start_date: string | null;
  manager_first_name: string | null;
  manager_last_name: string | null;
  star_rating: number | null;
  star_rating_count: number | null;
};

async function load(): Promise<void> {
  publish({ ...INITIAL, loading: true });
  try {
    const [raw, lastSync] = await Promise.all([
      selectAll<MatchSelect>(() =>
        supabase
          .from("mdapi_matches")
          .select(
            "api_id, field_title, city_name, start_date, manager_first_name, manager_last_name, star_rating, star_rating_count",
          )
          .gt("star_rating_count", 0)
          .is("deleted_at", null)
          .order("start_date", { ascending: true })
          .order("api_id", { ascending: true }),
      ),
      supabase
        .from("fin_sync_log")
        .select("completed_at")
        .eq("source", "mdapi-reviews")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle<{ completed_at: string }>(),
    ]);

    // A match can only be genuinely reviewed AFTER it's played. The MatchDay
    // API stamps a recurring series' rolling star_rating onto every FUTURE
    // instance (e.g. next Sunday's ATH Katy shows 5.0/8 with player_count 0
    // before anyone plays it), so star_rating_count>0 alone surfaces phantom
    // future rows. Drop anything not yet started; the daily snapshot means
    // `now` is close enough that no genuinely-reviewed past match is excluded.
    const nowMs = Date.now();
    const rows: MatchReviewRow[] = [];
    for (const r of raw) {
      if (!r.start_date || r.star_rating == null || !r.star_rating_count) continue;
      const startMs = new Date(r.start_date).getTime();
      if (Number.isNaN(startMs) || startMs > nowMs) continue; // future / unparseable
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
    publish({
      rows,
      syncedAt: lastSync.data?.completed_at ?? null,
      loading: false,
      error: null,
    });
  } catch (e) {
    publish({
      rows: [],
      syncedAt: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load match reviews.",
    });
  }
}

export function useMatchReviews(): State {
  const [state, setState] = useState<State>(cached ?? INITIAL);
  useEffect(() => {
    subscribers.add(setState);
    if (cached) setState(cached);
    else if (!pending) {
      pending = load().finally(() => {
        pending = null;
      });
    }
    return () => {
      subscribers.delete(setState);
    };
  }, []);
  return state;
}
