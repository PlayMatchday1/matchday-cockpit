// Sync /admin/matches/reviews → mdapi_reviews. Server-only.
//
// Pipeline:
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Paginate /admin/matches/reviews (limit=100, belt-and-
//      suspenders termination — same pattern as the Stripe sync).
//   3. Map each API row to the typed columns + raw + synced_at.
//   4. Upsert in batches of 500 onConflict=api_id.
//
// SINCE 2026-10-21 THIS WALK IS THE NIGHT PASS ONLY (lib/nightPass.ts), in two halves by page range
// (fromPage/toPage): ~287 pages paced at one a second is longer than one function run. New reviews
// arrive hourly with the matches run, which reads them off the rosters (reviewFromRoster,
// mdapiMatchesSync.ts). PACED: one request a second, no retries, the first error stops the walk.
// The endpoint states no order, so a review shifting between the two halves is refreshed the next
// night instead; nothing is ever deleted here, so a skipped row keeps its last value.
//
// Caller provides the Supabase client. Writes require service role
// (RLS allows authenticated SELECT only) — the manual script
// constructs the client with SUPABASE_SERVICE_ROLE_KEY.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getPacedClient, MatchdayApiError, type PacedClient } from "./matchdayApi";
import { withLogPatch } from "./syncLogging";

const PAGE_LIMIT = 100;
const UPSERT_BATCH = 500;

// Snake_case to mirror the API. Optional fields default to null —
// the sample showed `tags_rating` and `comment` as null on a
// review with no extra context.
type ApiReviewRow = {
  id: number;
  user_id?: number | null;
  user_first_name?: string | null;
  user_last_name?: string | null;
  user_phone_number?: string | null;
  user_email?: string | null;
  manager_first_name?: string | null;
  manager_last_name?: string | null;
  start_date?: string | null;
  field_title?: string | null;
  city_name?: string | null;
  star_rating?: number | null;
  tags_rating?: unknown;
  comment?: string | null;
  updated_at_rating?: string | null;
};

type ApiPage = {
  data: ApiReviewRow[];
  totalItems?: number;
  page?: number;
  limit?: number;
};

export type MdapiReviewsSyncResult = {
  fetched: number; // rows returned by API across all pages
  upserted: number; // rows actually written (after de-dupe)
  duplicatesDropped: number; // same api_id returned more than once by the API
  pages: number; // page count consumed
  totalItems: number | null; // the endpoint's own count, from page 1 of this call's range
  apiCalls: number;
  durationMs: number;
};

export async function syncMdapiReviews(
  supabase: SupabaseClient,
  opts: { fromPage?: number; toPage?: number; client?: PacedClient } = {},
): Promise<MdapiReviewsSyncResult> {
  const startedAt = Date.now();
  const client = opts.client ?? getPacedClient();
  const fromPage = opts.fromPage ?? 1;
  const toPage = opts.toPage ?? Number.POSITIVE_INFINITY;

  // --- Fetch the page range ---
  const all: ApiReviewRow[] = [];
  let pages = 0;
  let totalItems: number | null = null;
  for (let page = fromPage; page <= toPage; page++) {
    let res: ApiPage;
    try {
      res = await client.get<ApiPage>("/admin/matches/reviews", {
        page,
        limit: PAGE_LIMIT,
      });
    } catch (e) {
      const msg = e instanceof MatchdayApiError
        ? `mdapi_reviews fetch failed on page ${page} (HTTP ${e.status}), no retry: ${e.message}`
        : `mdapi_reviews fetch failed on page ${page}, no retry: ${e instanceof Error ? e.message : String(e)}`;
      throw withLogPatch(new Error(msg), { api_calls: client.calls });
    }
    pages++;
    const rows = Array.isArray(res?.data) ? res.data : [];
    all.push(...rows);
    if (typeof res.totalItems === "number") totalItems = res.totalItems;

    // Three-way termination — any of these signals "we're done".
    if (rows.length === 0) break;
    if (rows.length < PAGE_LIMIT) break;
    if (totalItems != null && (page - 1) * PAGE_LIMIT + rows.length >= totalItems) break;
  }

  // --- Map to DB rows ---
  const syncedAt = new Date().toISOString();
  type DbRow = {
    api_id: number;
    user_id: number | null;
    user_first_name: string | null;
    user_last_name: string | null;
    user_phone_number: string | null;
    user_email: string | null;
    manager_first_name: string | null;
    manager_last_name: string | null;
    start_date: string | null;
    field_title: string | null;
    city_name: string | null;
    star_rating: number | null;
    tags_rating: unknown;
    comment: string | null;
    updated_at_rating: string | null;
    raw: unknown;
    synced_at: string;
  };
  const dbRows: DbRow[] = all.map((r) => ({
    api_id: r.id,
    user_id: r.user_id ?? null,
    user_first_name: r.user_first_name ?? null,
    user_last_name: r.user_last_name ?? null,
    user_phone_number: r.user_phone_number ?? null,
    user_email: r.user_email ?? null,
    manager_first_name: r.manager_first_name ?? null,
    manager_last_name: r.manager_last_name ?? null,
    start_date: r.start_date ?? null,
    field_title: r.field_title ?? null,
    city_name: r.city_name ?? null,
    star_rating: r.star_rating ?? null,
    tags_rating: r.tags_rating ?? null,
    comment: r.comment ?? null,
    updated_at_rating: r.updated_at_rating ?? null,
    raw: r,
    synced_at: syncedAt,
  }));

  // De-dupe by api_id BEFORE batching. The MatchDay reviews API can return the
  // same review id twice within a page window; if two land in one 500-row
  // upsert chunk, Postgres throws "ON CONFLICT DO UPDATE command cannot affect
  // row a second time" and the whole sync 500s (this failed the hourly job on
  // 2026-07-24 and 07-25 at offset 14000). onConflict=api_id is last-write-wins
  // across chunks anyway, so collapsing dupes to the last occurrence here is
  // the same result, minus the crash.
  const uniqueRows = Array.from(
    new Map(dbRows.map((r) => [r.api_id, r])).values(),
  );
  const duplicatesDropped = dbRows.length - uniqueRows.length;

  // --- Upsert in batches ---
  let upserted = 0;
  for (let i = 0; i < uniqueRows.length; i += UPSERT_BATCH) {
    const chunk = uniqueRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("mdapi_reviews")
      .upsert(chunk, { onConflict: "api_id" });
    if (error) {
      throw new Error(
        `mdapi_reviews upsert failed at offset ${i}: ${error.message}`,
      );
    }
    upserted += chunk.length;
  }

  return {
    fetched: all.length,
    upserted,
    duplicatesDropped,
    pages,
    totalItems,
    apiCalls: client.calls,
    durationMs: Date.now() - startedAt,
  };
}
