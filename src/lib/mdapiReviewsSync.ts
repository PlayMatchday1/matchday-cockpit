// Sync /admin/matches/reviews → mdapi_reviews. Server-only.
//
// Pipeline:
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Paginate /admin/matches/reviews (limit=100, belt-and-
//      suspenders termination — same pattern as the Stripe sync).
//   3. Map each API row to the typed columns + raw + synced_at.
//   4. Upsert in batches of 500 onConflict=api_id.
//
// Caller provides the Supabase client. Writes require service role
// (RLS allows authenticated SELECT only) — the manual script
// constructs the client with SUPABASE_SERVICE_ROLE_KEY.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "./matchdayApi";

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
  upserted: number; // rows actually written
  pages: number; // page count consumed
  durationMs: number;
};

export async function syncMdapiReviews(
  supabase: SupabaseClient,
): Promise<MdapiReviewsSyncResult> {
  const startedAt = Date.now();
  const client = getMatchdayApiClient();

  // --- Fetch all pages ---
  const all: ApiReviewRow[] = [];
  let pages = 0;
  for (let page = 1; ; page++) {
    let res: ApiPage;
    try {
      res = await client.get<ApiPage>("/admin/matches/reviews", {
        page,
        limit: PAGE_LIMIT,
      });
    } catch (e) {
      if (e instanceof MatchdayApiError) {
        throw new Error(
          `mdapi_reviews fetch failed on page ${page} (HTTP ${e.status}): ${e.message}`,
        );
      }
      throw e;
    }
    pages++;
    const rows = Array.isArray(res?.data) ? res.data : [];
    all.push(...rows);

    // Three-way termination — any of these signals "we're done".
    if (rows.length === 0) break;
    if (rows.length < PAGE_LIMIT) break;
    if (
      typeof res.totalItems === "number" &&
      all.length >= res.totalItems
    ) {
      break;
    }
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

  // --- Upsert in batches ---
  let upserted = 0;
  for (let i = 0; i < dbRows.length; i += UPSERT_BATCH) {
    const chunk = dbRows.slice(i, i + UPSERT_BATCH);
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
    pages,
    durationMs: Date.now() - startedAt,
  };
}
