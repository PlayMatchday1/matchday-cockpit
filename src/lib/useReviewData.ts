"use client";

// Reviews data hook. Reads from mdapi_reviews (the MatchDay API
// mirror, populated by the daily cron + manual sync UI on /data).
// Replaces the older path that read from the `reviews` table
// populated by CSV upload via review_uploads metadata.
//
// The CSV upload path still works (still writes to the `reviews`
// table) but its writes are no longer read by the dashboard. The
// CSV uploader is deprecated for removal in Phase 4.
//
// What this hook returns is unchanged: a `ReviewRow[]` and a
// `ReviewMeta`. Consumers (CitiesReviewsLens, ManagerPodium,
// CityManagerTable, CityDetailView, Reviews8WeekCard,
// ReviewsCommentsTable) are untouched.
//
// Two field renames between the old and new sources:
//   reviews.city            → mdapi_reviews.city_name (raw, needs normalize)
//   reviews.rating_at       → mdapi_reviews.updated_at_rating
// One type coercion:
//   reviews.user_id (text)  → mdapi_reviews.user_id (bigint) → coerce String()
// Tags column: jsonb in mdapi_reviews; parseTags() already handles
// JSON-array input.

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import { parseTags } from "./reviewTags";
import { normalizeCity } from "./cityMap";
import { useRevalidateWhenStale } from "./cacheFreshness";

export type ReviewRow = {
  city: string;
  fieldTitle: string;
  managerFirstName: string | null;
  managerLastName: string | null;
  starRating: number;
  startDate: Date;
  userId: string | null;
  ratingAt: Date | null;
  comment: string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userEmail: string | null;
  tags: string[];
};

export type ReviewMeta = {
  filename: string;
  uploadedAt: Date;
  rowCount: number;
  earliestReview: Date;
  latestReview: Date;
} | null;

type State = {
  rows: ReviewRow[];
  meta: ReviewMeta;
  loading: boolean;
  error: string | null;
};

const INITIAL: State = { rows: [], meta: null, loading: true, error: null };

let cached: State | null = null;
// When the cached payload was fetched. Drives cache expiry — without it
// a tab left open served the first fetch until a full page reload.
let loadedAt: number | null = null;
let pending: Promise<void> | null = null;
const subscribers = new Set<(s: State) => void>();

function parseLocal(s: string | null | undefined): Date | null {
  if (!s) return null;
  const parts = s.slice(0, 16).split(/[- T:]/);
  if (parts.length < 5) return null;
  const [yr, mo, dy, hr, mn] = parts.map(Number);
  if ([yr, mo, dy, hr, mn].some((n) => Number.isNaN(n))) return null;
  return new Date(yr, mo - 1, dy, hr, mn);
}

function publish(s: State) {
  cached = s;
  subscribers.forEach((fn) => fn(s));
}

// `silent` keeps the cached rows on screen while a background
// revalidation runs, so a focus-triggered refresh never blanks the view.
async function load(silent = false): Promise<void> {
  if (!silent || !cached) publish({ rows: [], meta: null, loading: true, error: null });

  type MdapiReviewSelect = {
    api_id: number;
    city_name: string | null;
    field_title: string | null;
    manager_first_name: string | null;
    manager_last_name: string | null;
    star_rating: number | null;
    start_date: string | null;
    user_id: number | null;
    updated_at_rating: string | null;
    comment: string | null;
    user_first_name: string | null;
    user_last_name: string | null;
    user_email: string | null;
    tags_rating: unknown;
  };

  // Two parallel reads — they're independent.
  //   1. mdapi_reviews rows (paginated; ~16k rows)
  //   2. fin_sync_log latest mdapi-reviews completed_at (single row)
  // Sort by start_date asc with api_id as a tiebreaker — without
  // the secondary key, paginated reads can shift rows across pages
  // on ties (the project's prior pagination-stability fix pattern).
  let raw: MdapiReviewSelect[];
  let lastSyncCompletedAt: string | null = null;
  try {
    const [rows, lastSyncResult] = await Promise.all([
      selectAll<MdapiReviewSelect>(() =>
        supabase
          .from("mdapi_reviews")
          .select(
            "api_id, city_name, field_title, manager_first_name, manager_last_name, star_rating, start_date, user_id, updated_at_rating, comment, user_first_name, user_last_name, user_email, tags_rating",
          )
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
    raw = rows;
    lastSyncCompletedAt = lastSyncResult.data?.completed_at ?? null;
  } catch (e) {
    // A failed BACKGROUND revalidation must not wipe good cached rows —
    // leave the cache in place and let the next signal retry.
    if (silent && cached) return;
    loadedAt = null;
    publish({
      rows: [],
      meta: null,
      loading: false,
      error: e instanceof Error ? e.message : "Failed to load reviews.",
    });
    return;
  }

  const all: ReviewRow[] = [];
  for (const r of raw) {
    // Skip rows missing the essentials. Same filters as the old
    // CSV-backed path:
    //   - unparseable start_date (parseLocal returns null)
    //   - missing star_rating
    //   - city not in the cockpit's known list (normalizeCity → null)
    // The city filter silently drops "New York City" reviews (26 in
    // mdapi_reviews as of May 2026) — cockpit has no NYC infra.
    // When MatchDay launches new cities, add them to cityMap.ts or
    // their reviews disappear from dashboards.
    const startDate = parseLocal(r.start_date);
    if (!startDate) continue;
    if (r.star_rating === null) continue;
    const city = normalizeCity(r.city_name);
    if (!city) continue;

    all.push({
      city,
      fieldTitle: r.field_title ?? "",
      managerFirstName: r.manager_first_name,
      managerLastName: r.manager_last_name,
      starRating: Number(r.star_rating),
      startDate,
      userId: r.user_id != null ? String(r.user_id) : null,
      ratingAt: parseLocal(r.updated_at_rating),
      comment: r.comment,
      userFirstName: r.user_first_name,
      userLastName: r.user_last_name,
      userEmail: r.user_email,
      // tags_rating is jsonb — Supabase auto-parses to JS value.
      // parseTags handles arrays AND strings, so it works either way.
      tags: parseTags(
        typeof r.tags_rating === "string"
          ? r.tags_rating
          : r.tags_rating == null
            ? null
            : JSON.stringify(r.tags_rating),
      ),
    });
  }

  // Rows are pre-sorted by start_date asc + api_id asc, so first/
  // last give us the date range. The fallback to `new Date()` (now)
  // covers the empty-rows case — preserves existing behavior.
  const earliestReview = all[0]?.startDate ?? new Date();
  const latestReview = all[all.length - 1]?.startDate ?? new Date();

  loadedAt = Date.now();
  publish({
    rows: all,
    meta: {
      filename: "MatchDay API",
      // First-deploy edge case: if no successful sync has run yet,
      // fall back to `now` so the footer reads "just now". A real
      // value will appear after the next cron or manual sync.
      uploadedAt: lastSyncCompletedAt
        ? new Date(lastSyncCompletedAt)
        : new Date(),
      rowCount: all.length,
      earliestReview,
      latestReview,
    },
    loading: false,
    error: null,
  });
}

function ensureLoad(silent = false) {
  if (pending) return;
  pending = load(silent).finally(() => {
    pending = null;
  });
}

export function useReviewData(): State {
  const [s, setS] = useState<State>(cached ?? INITIAL);

  useEffect(() => {
    subscribers.add(setS);
    if (cached) {
      setS(cached);
    } else {
      ensureLoad();
    }
    return () => {
      subscribers.delete(setS);
    };
  }, []);

  // Expire the module cache on focus / visibility / poll so an open tab
  // stops rendering yesterday's reviews.
  useRevalidateWhenStale(
    () => loadedAt,
    () => ensureLoad(true),
  );

  return s;
}

export async function refetchReviewData(): Promise<void> {
  loadedAt = null;
  await load();
}
