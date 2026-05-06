// Sync /admin/promocodes → mdapi_promocodes. Server-only.
//
// Pipeline (mirrors mdapiSubscriptionsSync.ts):
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Paginate /admin/promocodes (limit=1000, three-way termination).
//   3. Map each API row to typed columns + raw jsonb + synced_at.
//   4. Upsert in batches of 500 onConflict='api_id'.
//
// The endpoint accepts only `page` and `limit` query params (per
// OpenAPI spec at /api-docs-json) — no date filter, no incremental
// strategy. Each run is a full re-sync. With ~6,094 rows in
// production at ~1KB each, total bandwidth is ~6MB and runtime is
// ~2 seconds. Negligible cost.
//
// Why mirror the full payload: the dashboard read path joins on
// promocode_id at page-load time and looks up the `code` text. That's
// the load-bearing field for the Top Promo Codes card bug fix. Other
// columns (discountType, discountValue, dates, deletedAt) are
// captured for forward-compat — future analytics can branch on them
// without a re-sync.
//
// Caller provides the Supabase client. Writes require service role
// (RLS allows authenticated INSERT/UPDATE per migration 0017, but
// scripts run as service-role by convention).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "./matchdayApi";

const PAGE_LIMIT = 1000;
const UPSERT_BATCH = 500;

type ApiPromocode = {
  id: number;
  code?: string | null;
  discountType?: string | null;
  discountValue?: number | null;
  targetUserType?: string | null;
  numberOfUsesPerUser?: number | null;
  targetMatchType?: string | null;
  startDateUtc?: string | null;
  endDateUtc?: string | null;
  matchTimePeriodStart?: string | null;
  matchTimePeriodEnd?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string | null;
};

type ApiPage = {
  data?: ApiPromocode[];
  totalItems?: number;
  page?: number;
  limit?: number;
};

type DbRow = {
  api_id: number;
  code: string;
  discount_type: string | null;
  discount_value: number | null;
  target_user_type: string | null;
  number_of_uses_per_user: number | null;
  target_match_type: string | null;
  start_date_utc: string | null;
  end_date_utc: string | null;
  match_time_period_start: string | null;
  match_time_period_end: string | null;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
  raw: unknown;
  synced_at: string;
};

export type MdapiPromocodesSyncResult = {
  fetched: number;
  upserted: number;
  pages: number;
  durationMs: number;
};

export async function syncMdapiPromocodes(
  supabase: SupabaseClient,
): Promise<MdapiPromocodesSyncResult> {
  const startedAt = Date.now();
  const client = getMatchdayApiClient();

  // === Fetch all pages ===
  const all: ApiPromocode[] = [];
  let pages = 0;
  for (let page = 1; ; page++) {
    let res: ApiPage;
    try {
      res = await client.get<ApiPage>("/admin/promocodes", {
        page,
        limit: PAGE_LIMIT,
      });
    } catch (e) {
      if (e instanceof MatchdayApiError) {
        throw new Error(
          `mdapi_promocodes fetch failed on page ${page} (HTTP ${e.status}): ${e.message}`,
        );
      }
      throw e;
    }
    pages++;
    const rows = Array.isArray(res?.data) ? res.data : [];
    all.push(...rows);

    // Three-way termination — same pattern as mdapi_reviews / subs.
    if (rows.length === 0) break;
    if (rows.length < PAGE_LIMIT) break;
    if (typeof res.totalItems === "number" && all.length >= res.totalItems) {
      break;
    }
  }

  // === Map to DB rows ===
  const syncedAt = new Date().toISOString();
  const dbRows: DbRow[] = [];
  for (const r of all) {
    // Skip malformed rows. The `code` column is NOT NULL in the
    // schema — defensive filter to avoid an upsert error if the API
    // ever returns a record without a code.
    if (typeof r.id !== "number" || !r.code) continue;
    dbRows.push({
      api_id: r.id,
      code: r.code,
      discount_type: r.discountType ?? null,
      discount_value: r.discountValue ?? null,
      target_user_type: r.targetUserType ?? null,
      number_of_uses_per_user: r.numberOfUsesPerUser ?? null,
      target_match_type: r.targetMatchType ?? null,
      start_date_utc: r.startDateUtc ?? null,
      end_date_utc: r.endDateUtc ?? null,
      match_time_period_start: r.matchTimePeriodStart ?? null,
      match_time_period_end: r.matchTimePeriodEnd ?? null,
      created_at: r.createdAt ?? null,
      updated_at: r.updatedAt ?? null,
      deleted_at: r.deletedAt ?? null,
      raw: r,
      synced_at: syncedAt,
    });
  }

  // === Upsert in batches ===
  let upserted = 0;
  for (let i = 0; i < dbRows.length; i += UPSERT_BATCH) {
    const chunk = dbRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("mdapi_promocodes")
      .upsert(chunk, { onConflict: "api_id" });
    if (error) {
      throw new Error(
        `mdapi_promocodes upsert failed at offset ${i}: ${error.message}`,
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
