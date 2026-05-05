// Sync /admin/subscriptions → mdapi_subscriptions. Server-only.
//
// Pipeline:
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Enumerate cities via /admin/cities (bare array, 9 cities).
//   3. Nested loop: city × status × pages. The endpoint requires
//      cityIdentifier + status + sortColumn + sortDirection — sending
//      anything less returns a 500 (validated empirically).
//   4. Map each row to snake_case columns + raw + synced_at, with
//      city_identifier synthesized from the loop variable (the row
//      body has no cityIdentifier field, only a slug like "ATX13").
//   5. Upsert in batches of 500 onConflict=membership_id.
//
// Endpoint quirks (from probe, May 2026):
//   - totalItems is broken (returns 0 even with 100 rows). Termination
//     uses data.length < limit — same pattern as mdapi_reviews.
//   - sortDirection MUST be lowercase asc/desc (validator is strict).
//   - Multi-value status (e.g. "ACTIVE,CANCELED") is rejected.
//   - Bogus cityIdentifier returns 500, not 400 — caller responsibility
//     to use a real abbr.
//
// Caller provides the Supabase client. Writes require service role
// (RLS allows authenticated SELECT only).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getMatchdayApiClient,
  MatchdayApiError,
} from "./matchdayApi";

const PAGE_LIMIT = 100;
const UPSERT_BATCH = 500;

// All 9 statuses surfaced by the validator. Pulling all of them is
// future-proof — easier to filter downstream than to discover missing
// data later. Cost is negligible (~9× the per-city pagination loops).
const STATUSES = [
  "ACTIVE",
  "INACTIVE",
  "CANCELED",
  "INCOMPLETE",
  "INCOMPLETE_EXPIRED",
  "PAST_DUE",
  "PAUSED",
  "UNPAID",
  "ADDED_FROM_ADMIN",
] as const;

type CityRow = { abbr?: string };

type ApiSubRow = {
  membershipId?: number;
  userId?: number;
  cityIdentifierAndMemberId?: string | null;
  memberEmail?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phoneNumber?: string | null;
  status?: string | null;
  price?: number | null;
  membershipLength?: number | null;
  comment?: string | null;
  activationDate?: string | null;
  canceledAt?: string | null;
  cancelReason?: string | null;
  suspendedTo?: string | null;
  strikePoints?: number | null;
  absentOwed?: number | null;
};

type ApiPage = {
  data?: ApiSubRow[];
  totalItems?: number; // broken — always 0 for this endpoint
  page?: number;
  limit?: number;
};

type DbRow = {
  membership_id: number;
  user_id: number;
  city_identifier: string;
  city_member_slug: string | null;
  member_email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  status: string | null;
  price: number | null;
  membership_length: number | null;
  comment: string | null;
  activation_date: string | null;
  canceled_at: string | null;
  cancel_reason: string | null;
  suspended_to: string | null;
  strike_points: number | null;
  absent_owed: number | null;
  raw: unknown;
  synced_at: string;
};

export type MdapiSubscriptionsSyncResult = {
  fetched: number; // rows received from API across all loops
  upserted: number; // rows actually written
  cities: number;
  statuses: number;
  apiCalls: number;
  // Per-(city, status) errors. Sync continues on per-loop failures
  // rather than crashing — we want partial progress over no progress.
  loopErrors: Record<string, string>;
  durationMs: number;
};

export async function syncMdapiSubscriptions(
  supabase: SupabaseClient,
): Promise<MdapiSubscriptionsSyncResult> {
  const startedAt = Date.now();
  const client = getMatchdayApiClient();

  // --- 1. Enumerate cities ---
  // /admin/cities returns a bare array (no envelope), 9 cities.
  let cities: CityRow[];
  try {
    cities = await client.get<CityRow[]>("/admin/cities");
  } catch (e) {
    if (e instanceof MatchdayApiError) {
      throw new Error(
        `mdapi_subscriptions: /admin/cities failed (HTTP ${e.status}): ${e.message}`,
      );
    }
    throw e;
  }
  const cityAbbrs = cities
    .map((c) => c.abbr)
    .filter((a): a is string => typeof a === "string" && a.length > 0);
  if (cityAbbrs.length === 0) {
    throw new Error(
      "mdapi_subscriptions: /admin/cities returned no usable abbrs",
    );
  }

  // --- 2. Nested loop: city × status × pages ---
  const allRows: DbRow[] = [];
  const loopErrors: Record<string, string> = {};
  let apiCalls = 0;
  const syncedAt = new Date().toISOString();

  for (const cityAbbr of cityAbbrs) {
    for (const status of STATUSES) {
      const loopKey = `${cityAbbr}/${status}`;
      for (let page = 1; ; page++) {
        let res: ApiPage;
        try {
          res = await client.get<ApiPage>("/admin/subscriptions", {
            cityIdentifier: cityAbbr,
            status,
            // Both sort params are REQUIRED — server returns 500
            // without them. sortDirection must be lowercase.
            sortColumn: "id",
            sortDirection: "asc",
            limit: PAGE_LIMIT,
            page,
          });
          apiCalls++;
        } catch (e) {
          // Don't crash the whole sync for one bad (city, status)
          // combination. Capture and move on.
          const msg =
            e instanceof MatchdayApiError
              ? `HTTP ${e.status}: ${e.message}`
              : e instanceof Error
                ? e.message
                : String(e);
          loopErrors[loopKey] = msg;
          break;
        }
        const rows = Array.isArray(res?.data) ? res.data : [];
        for (const r of rows) {
          if (typeof r.membershipId !== "number" || typeof r.userId !== "number") {
            // Skip malformed rows rather than crashing the upsert.
            continue;
          }
          allRows.push(mapToDbRow(r, cityAbbr, syncedAt));
        }
        // totalItems is broken on this endpoint — terminate on
        // partial-page only.
        if (rows.length < PAGE_LIMIT) break;
      }
    }
  }

  // --- 3. Upsert in batches ---
  let upserted = 0;
  for (let i = 0; i < allRows.length; i += UPSERT_BATCH) {
    const chunk = allRows.slice(i, i + UPSERT_BATCH);
    const { error } = await supabase
      .from("mdapi_subscriptions")
      .upsert(chunk, { onConflict: "membership_id" });
    if (error) {
      throw new Error(
        `mdapi_subscriptions upsert failed at offset ${i}: ${error.message}`,
      );
    }
    upserted += chunk.length;
  }

  return {
    fetched: allRows.length,
    upserted,
    cities: cityAbbrs.length,
    statuses: STATUSES.length,
    apiCalls,
    loopErrors,
    durationMs: Date.now() - startedAt,
  };
}

function mapToDbRow(r: ApiSubRow, cityAbbr: string, syncedAt: string): DbRow {
  return {
    membership_id: r.membershipId as number,
    user_id: r.userId as number,
    city_identifier: cityAbbr,
    city_member_slug: r.cityIdentifierAndMemberId ?? null,
    member_email: r.memberEmail ?? null,
    first_name: r.firstName ?? null,
    last_name: r.lastName ?? null,
    phone_number: r.phoneNumber ?? null,
    status: r.status ?? null,
    price: r.price ?? null,
    membership_length: r.membershipLength ?? null,
    comment: r.comment ?? null,
    activation_date: r.activationDate ?? null,
    canceled_at: r.canceledAt ?? null,
    cancel_reason: r.cancelReason ?? null,
    suspended_to: r.suspendedTo ?? null,
    strike_points: r.strikePoints ?? null,
    absent_owed: r.absentOwed ?? null,
    raw: r,
    synced_at: syncedAt,
  };
}
