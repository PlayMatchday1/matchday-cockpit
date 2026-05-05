// Sync /admin/subscriptions → mdapi_subscriptions. Server-only.
//
// Pipeline:
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Enumerate cities via /admin/cities (bare array, 9 cities).
//   3. Nested loop: city × {ACTIVE, CANCELED} × pages. See "Why only
//      two statuses?" below — this isn't an oversight, it's a
//      deliberate workaround for a server-side filter bug.
//   4. Map each row to snake_case columns + raw + synced_at, with
//      city_identifier synthesized from the loop variable (the row
//      body has no cityIdentifier field, only a slug like "ATX13").
//   5. Dedupe in memory by membership_id (same row can come back
//      under both status queries; see workaround below).
//   6. Upsert in batches of 500 onConflict=membership_id.
//
// === Why only two statuses? ===
// The /admin/subscriptions endpoint accepts a `status` filter param,
// validated against a 9-value enum (ACTIVE, INACTIVE, CANCELED,
// INCOMPLETE, INCOMPLETE_EXPIRED, PAST_DUE, PAUSED, UNPAID,
// ADDED_FROM_ADMIN). But probe (May 2026) showed:
//   - status=ACTIVE: filter is strict, returns only true actives.
//   - status=anything-else: filter is silently IGNORED — returns
//     all non-ACTIVE memberships in the city, paginated, regardless
//     of which non-ACTIVE value was sent.
// The row's `status` field on each record is ground truth (set per
// record, not echoed from the query). So calling status=CANCELED
// gives us the full non-active set in one paginated loop. We pick
// CANCELED rather than (e.g.) PAUSED because CANCELED is what most
// of those rows actually report as their stored status — least
// confusing in logs.
//
// If Vitaly fixes the broken filter someday, this sync will silently
// undercount non-active members. The sanity log at the end of this
// function catches that — ACTIVE-loop rows should be 100%
// row.status=ACTIVE; CANCELED-loop rows should be 0%
// row.status=ACTIVE. If those invariants break, the API behavior
// shifted and the strategy needs revisiting.
//
// === Other endpoint quirks (from probe, May 2026) ===
//   - totalItems is broken (returns 0 even with 100 rows). Termination
//     uses data.length < limit — same pattern as mdapi_reviews.
//   - sortColumn + sortDirection are REQUIRED (omitting either → 500).
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

// Two statuses by design — see "Why only two statuses?" in the file
// header. ACTIVE gives us strict actives; CANCELED triggers the
// broken-filter behavior that returns all non-actives.
const STATUSES = ["ACTIVE", "CANCELED"] as const;

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
  fetched: number; // rows received from API across all loops (pre-dedupe)
  uniqueMemberships: number; // rows after dedupe by membership_id
  upserted: number; // rows actually written
  cities: number;
  statuses: number;
  apiCalls: number;
  // Per-(city, status) errors. Sync continues on per-loop failures
  // rather than crashing — we want partial progress over no progress.
  loopErrors: Record<string, string>;
  // Sanity invariants — see file header. Healthy state:
  //   activeLoop.actuallyActive === activeLoop.fetched (100%)
  //   canceledLoop.actuallyActive === 0 (0%)
  // If these break, the broken-filter workaround has broken (Vitaly
  // fixed it server-side) and the sync strategy needs revisiting.
  loopSanity: {
    activeLoop: { fetched: number; actuallyActive: number };
    canceledLoop: { fetched: number; actuallyActive: number };
  };
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
  // Dedupe by membership_id — the broken-filter workaround means a
  // row can appear in both ACTIVE and CANCELED loops if its true
  // status is ACTIVE (CANCELED loop ignores filter, returns all
  // non-actives... in theory; but if the filter ever starts working
  // partially, we want last-write-wins to be safe). Cross-city
  // collisions don't happen — verified by probe.
  const dedupedById = new Map<number, DbRow>();
  const loopErrors: Record<string, string> = {};
  let apiCalls = 0;
  let fetchedTotal = 0;
  // Sanity counters — must be tracked separately per loop, not on the
  // deduped Map (one row could come from either loop and we'd lose
  // the attribution).
  const sanity = {
    activeLoop: { fetched: 0, actuallyActive: 0 },
    canceledLoop: { fetched: 0, actuallyActive: 0 },
  };
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
          fetchedTotal++;
          // Track sanity invariants by which loop the row came from.
          const counter = status === "ACTIVE" ? sanity.activeLoop : sanity.canceledLoop;
          counter.fetched++;
          if (r.status === "ACTIVE") counter.actuallyActive++;
          dedupedById.set(r.membershipId, mapToDbRow(r, cityAbbr, syncedAt));
        }
        // totalItems is broken on this endpoint — terminate on
        // partial-page only.
        if (rows.length < PAGE_LIMIT) break;
      }
    }
  }

  // --- 3. Sanity log ---
  // ACTIVE-loop should be 100% row.status=ACTIVE.
  // CANCELED-loop should be 0% row.status=ACTIVE (broken filter
  // returns non-actives only).
  if (
    sanity.activeLoop.fetched > 0 &&
    sanity.activeLoop.actuallyActive < sanity.activeLoop.fetched
  ) {
    const pct = (
      (sanity.activeLoop.actuallyActive / sanity.activeLoop.fetched) *
      100
    ).toFixed(1);
    console.warn(
      `⚠ Sanity violation: ACTIVE-loop returned ${sanity.activeLoop.fetched - sanity.activeLoop.actuallyActive} rows where row.status≠ACTIVE ` +
        `(${pct}% actually active). Expected 100%. The strict-ACTIVE filter behavior may have changed.`,
    );
  }
  if (sanity.canceledLoop.actuallyActive > 0) {
    const pct = (
      (sanity.canceledLoop.actuallyActive / sanity.canceledLoop.fetched) *
      100
    ).toFixed(1);
    console.warn(
      `⚠ Sanity violation: CANCELED-loop returned ${sanity.canceledLoop.actuallyActive} rows with row.status=ACTIVE ` +
        `(${pct}% of loop). Expected 0%. The broken-filter workaround may no longer apply — review sync strategy.`,
    );
  }

  // --- 4. Upsert in batches ---
  // Snapshot the deduped values once, then iterate. Map.values() is
  // an iterator — slicing it would re-walk from the start each batch.
  const dbRows = [...dedupedById.values()];
  let upserted = 0;
  for (let i = 0; i < dbRows.length; i += UPSERT_BATCH) {
    const chunk = dbRows.slice(i, i + UPSERT_BATCH);
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
    fetched: fetchedTotal,
    uniqueMemberships: dbRows.length,
    upserted,
    cities: cityAbbrs.length,
    statuses: STATUSES.length,
    apiCalls,
    loopErrors,
    loopSanity: sanity,
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
