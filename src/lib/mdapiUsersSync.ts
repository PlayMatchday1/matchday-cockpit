// Sync GET /admin/players → mdapi_users. Server-only.
//
// Pipeline:
//   1. Authenticate via the shared MatchDay API helper.
//   2. Probe page=1&limit=1 to read totalItems → compute totalPages.
//   3. Paginated loop, page=1..totalPages at limit=250, sortColumn=
//      createdAt&sortDirection=desc. Sort direction is functionally
//      irrelevant (full re-sync) but the endpoint requires a sort.
//   4. Map each row to snake_case columns + raw + synced_at, with
//      preferable_city_normalized derived via normalizeCityName.
//   5. Upsert in batches of 500 onConflict=id.
//
// === Endpoint behavior (from probe, May 2026) ===
//   - totalItems IS reliable on this endpoint (unlike subscriptions
//     where it's broken). Use it to bound the page loop.
//   - sortColumn=createdAt + sortDirection=asc|desc both work.
//   - Pagination is 1-indexed. page=1, limit=250 returns rows 1..250.
//   - Response shape: { page, limit, totalItems, data[] }.
//   - 70% of newest users have null preferableCity AND null
//     completedSignUpAt (abandoned signup cohort) — both columns are
//     legitimately null, not a missing-data bug.
//
// We do NOT delete rows. If a user was deleted on MatchDay's side, we
// keep the last-known snapshot (raw column preserves it). The
// deletion rate is presumed low; if it becomes load-bearing we can
// add a soft-delete flag and a separate id-set diff step.
//
// Caller provides the Supabase client. Writes require service role
// (RLS allows authenticated SELECT only).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "./matchdayApi";
import { normalizeCityName } from "./cityNormalization";

const PAGE_LIMIT = 250;
// DB-side upsert chunk size. Initial Phase 1 setting of 500 hit
// Postgres statement_timeout at offset 16000 (table has 4 indexes +
// jsonb raw column → index maintenance scales fast per-statement).
// 100 is conservative; if this still times out drop to 50, if it's
// fast we can raise later. Don't pre-optimize — this is the
// minimum-blast-radius fix.
const UPSERT_BATCH = 100;
// Politeness delay between paginated /admin/players calls. With ~96
// pages back-to-back the upstream platform has been observed to serve
// transient 503s and HTML error pages (the "Unexpected token 'A'…"
// failure mode). 200ms spreads the load and reduces upstream pressure
// at the cost of ~20s of wall-clock time across the full sync.
const INTER_PAGE_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ApiPlayer = {
  id?: number;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
  createdAt?: string | null;
  completedSignUpAt?: string | null;
  isFakePlayer?: boolean | null;
  isMember?: boolean | null;
  preferableCity?: { name?: string | null } | null;
};

type ApiPage = {
  page?: number;
  limit?: number;
  totalItems?: number;
  data?: ApiPlayer[];
};

type DbRow = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  created_at: string;
  completed_sign_up_at: string | null;
  preferable_city_name: string | null;
  preferable_city_normalized: string | null;
  is_fake_player: boolean;
  is_member: boolean;
  raw: unknown;
  synced_at: string;
};

export type MdapiUsersSyncResult = {
  totalItems: number;
  pagesFetched: number;
  rowsReceived: number;     // pre-dedupe (paginated total)
  upserted: number;
  rowsSkipped: number;      // rows missing required fields
  unmappedCities: string[]; // raw city names that didn't map (deduped)
  apiCalls: number;
  durationMs: number;
};

export async function syncMdapiUsers(
  supabase: SupabaseClient,
): Promise<MdapiUsersSyncResult> {
  const startedAt = Date.now();
  const client = getMatchdayApiClient();
  const syncedAt = new Date().toISOString();

  // --- 1. Probe to learn totalItems ---
  let probe: ApiPage;
  try {
    probe = await client.get<ApiPage>("/admin/players", {
      page: 1,
      limit: 1,
      sortColumn: "createdAt",
      sortDirection: "desc",
    });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : String(e);
    const status =
      e instanceof MatchdayApiError ? ` (HTTP ${e.status})` : "";
    throw new Error(
      `mdapi_users: /admin/players probe failed after retries${status}. Upstream: ${rawMsg}`,
    );
  }
  const totalItems = typeof probe.totalItems === "number" ? probe.totalItems : 0;
  if (totalItems === 0) {
    // Endpoint should return at least one row in production. If we
    // somehow got zero, surface it rather than silently no-oping.
    throw new Error(
      "mdapi_users: /admin/players probe returned totalItems=0 — refusing to wipe state",
    );
  }
  const totalPages = Math.ceil(totalItems / PAGE_LIMIT);

  // --- 2. Paginated fetch ---
  // Dedupe by id in case the API returns the same row twice across
  // pages (sort can be unstable when many rows share the same
  // createdAt timestamp). Last-write-wins.
  const dedupedById = new Map<number, DbRow>();
  const unmappedSet = new Set<string>();
  let apiCalls = 1; // we already burned one call on the probe
  let rowsReceived = 0;
  let rowsSkipped = 0;

  for (let page = 1; page <= totalPages; page++) {
    // Politeness delay between pages. Skipped before page 1 (no
    // prior call to back off from).
    if (page > 1) await sleep(INTER_PAGE_DELAY_MS);
    let res: ApiPage;
    try {
      res = await client.get<ApiPage>("/admin/players", {
        page,
        limit: PAGE_LIMIT,
        sortColumn: "createdAt",
        sortDirection: "desc",
      });
      apiCalls++;
    } catch (e) {
      // fetchMatchDayJson has already burned its 3 internal retries
      // for transient failures (502/503/504/429/parse-fail). Anything
      // reaching us here is terminal — surface page + progress so
      // the UI status card reads like a debuggable diagnostic, not
      // an opaque "Unexpected token 'A'..." error.
      const approxSynced = (page - 1) * PAGE_LIMIT;
      const rawMsg = e instanceof Error ? e.message : String(e);
      const status =
        e instanceof MatchdayApiError ? ` (HTTP ${e.status})` : "";
      throw new Error(
        `mdapi_users: Failed on page ${page} of ~${totalPages} after retries${status}. ` +
          `Synced ~${approxSynced.toLocaleString()} of ~${totalItems.toLocaleString()} users. ` +
          `Upstream: ${rawMsg}`,
      );
    }
    const rows = Array.isArray(res?.data) ? res.data : [];
    rowsReceived += rows.length;
    for (const r of rows) {
      // Required: id, email, createdAt. Anything missing those is
      // skipped — we can't key the row or join on email.
      if (
        typeof r.id !== "number" ||
        typeof r.email !== "string" ||
        !r.email ||
        !r.createdAt
      ) {
        rowsSkipped++;
        continue;
      }
      const rawCity = r.preferableCity?.name ?? null;
      const normalized = normalizeCityName(rawCity);
      if (rawCity && !normalized) {
        // normalizeCityName already console.warned; track for
        // surfacing in the summary too.
        unmappedSet.add(rawCity.trim());
      }
      dedupedById.set(r.id, {
        id: r.id,
        email: r.email,
        first_name: r.firstName ?? null,
        last_name: r.lastName ?? null,
        phone_number: r.phoneNumber ?? null,
        created_at: r.createdAt,
        completed_sign_up_at: r.completedSignUpAt ?? null,
        preferable_city_name: rawCity,
        preferable_city_normalized: normalized,
        is_fake_player: r.isFakePlayer === true,
        is_member: r.isMember === true,
        raw: r,
        synced_at: syncedAt,
      });
    }
    // Defensive: if a page comes back unexpectedly short, still
    // continue the loop until totalPages — the API has been observed
    // to return slightly fewer than `limit` rows on the last page.
    // Only break early if the response was clearly broken (no rows
    // before we expected to be done).
    if (rows.length === 0 && page < totalPages) {
      // Empty page mid-loop is suspicious; abort rather than silently
      // truncating the cohort.
      throw new Error(
        `mdapi_users: page ${page} returned 0 rows but totalPages=${totalPages}`,
      );
    }
  }

  // --- 3. Upsert in batches ---
  // Per-chunk timing log goes to Vercel logs (not the UI) so the next
  // statement_timeout-style failure has more diagnostic data than
  // "offset N failed". Format: chunk index / total / row count / ms.
  const dbRows = [...dedupedById.values()];
  const totalChunks = Math.ceil(dbRows.length / UPSERT_BATCH);
  let upserted = 0;
  for (let i = 0; i < dbRows.length; i += UPSERT_BATCH) {
    const chunk = dbRows.slice(i, i + UPSERT_BATCH);
    const chunkIndex = Math.floor(i / UPSERT_BATCH) + 1;
    const t0 = Date.now();
    const { error } = await supabase
      .from("mdapi_users")
      .upsert(chunk, { onConflict: "id" });
    const ms = Date.now() - t0;
    if (error) {
      throw new Error(
        `mdapi_users upsert failed at offset ${i}: ${error.message}`,
      );
    }
    upserted += chunk.length;
    console.log(
      `[mdapi-users] upserted chunk ${chunkIndex}/${totalChunks} (${chunk.length} rows) in ${ms}ms`,
    );
  }

  return {
    totalItems,
    pagesFetched: totalPages,
    rowsReceived,
    upserted: upserted,
    rowsSkipped,
    unmappedCities: [...unmappedSet].sort(),
    apiCalls,
    durationMs: Date.now() - startedAt,
  };
}
