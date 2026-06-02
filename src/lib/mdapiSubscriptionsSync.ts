// Sync /admin/subscriptions → mdapi_subscriptions. Server-only.
//
// Pipeline:
//   1. Authenticate via the Phase 1 MatchDay API helper.
//   2. Enumerate cities via /admin/cities (bare array, 9 cities).
//   3. Nested loop: city × {ACTIVE, CANCELED, PAST_DUE} × pages.
//      See "Status loop strategy" below — the 3-value choice is a
//      deliberate workaround for an inconsistent server-side filter.
//   4. Map each row to snake_case columns + raw + synced_at, with
//      city_identifier synthesized from the loop variable (the row
//      body has no cityIdentifier field, only a slug like "ATX13").
//   5. Dedupe in memory by membership_id (same row can come back
//      under multiple status queries; see strategy below).
//   6. Upsert in batches of 500 onConflict=membership_id.
//
// === Status loop strategy ===
// The /admin/subscriptions endpoint accepts a `status` filter param,
// validated against a 9-value enum (ACTIVE, INACTIVE, CANCELED,
// INCOMPLETE, INCOMPLETE_EXPIRED, PAST_DUE, PAUSED, UNPAID,
// ADDED_FROM_ADMIN). Probe (May 2026) found the filter behaves
// inconsistently across values:
//
//   Filter STRICT (returns only matching rows):
//     - ACTIVE   → returns only row.status=ACTIVE
//     - PAST_DUE → returns only row.status=PAST_DUE
//
//   Filter IGNORED (returns the same dataset regardless of value):
//     - CANCELED, INCOMPLETE, INCOMPLETE_EXPIRED, PAUSED, UNPAID,
//       INACTIVE, ADDED_FROM_ADMIN
//     The "ignored dump" returns CANCELED + PAST_DUE rows only,
//     NOT all non-actives — INCOMPLETE_EXPIRED rows are excluded
//     from the dump entirely.
//
// We loop over [ACTIVE, CANCELED, PAST_DUE] and dedupe by
// membership_id:
//   - ACTIVE   → strict; captures actives.
//   - CANCELED → exploits the ignored-filter behavior to capture
//                CANCELED + PAST_DUE rows in one paginated loop.
//   - PAST_DUE → strict; defensive duplicate of the PAST_DUE rows
//                already returned by the CANCELED dump. If Vitaly
//                ever fixes CANCELED to be strict, the dump will
//                drop its PAST_DUE rows and we'd silently lose them
//                without this explicit loop.
//
// We deliberately do NOT capture INCOMPLETE_EXPIRED rows. They're
// unreachable via /admin/subscriptions (no filter returns them),
// and they represent abandoned Stripe checkouts that generated $0
// revenue and never became real members. Not relevant to the
// cockpit.
//
// The row's `status` field on each record is ground truth (set per
// record, not echoed from the query). The sanity log at the end of
// this function catches behavior shifts:
//   - ACTIVE loop:   must be 100% row.status=ACTIVE
//   - PAST_DUE loop: must be 100% row.status=PAST_DUE
//   - CANCELED loop: must be 0% row.status=ACTIVE (ACTIVE bleeding
//                    into the dump would mean the strict-ACTIVE
//                    filter has loosened)
// Any of these breaking means the API behavior shifted and the
// strategy needs revisiting.
//
// === Defensive write order + collapse circuit breaker ===
// On 2026-06-01 the CANCELED dump returned ~142 truly-active members
// tagged status=CANCELED. With the old plain last-write-wins dedup
// (CANCELED runs after ACTIVE), those overwrote the good ACTIVE writes
// and silently flipped ~38% of the active base to CANCELED — the
// sanity checks above did NOT fire (they look for ACTIVE bleeding into
// the dump, not the reverse). Two guards now prevent a repeat:
//
//   1. ACTIVE-loop-wins: ids the strict ACTIVE filter claimed this run
//      are recorded in `activeIds`; later non-ACTIVE loops may not
//      overwrite them. Real cancellations are never returned by the
//      strict ACTIVE filter, so they're unaffected.
//   2. Collapse circuit breaker: before any write, abort if this run
//      would drop the live ACTIVE count >20% vs the table's current
//      value. Turns a silent mass-flip into a loud, non-2xx cron
//      failure that preserves the prior good data. Does not block
//      recovery (heal runs move the count UP).
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

// Three statuses by design — see "Status loop strategy" in the file
// header. ACTIVE and PAST_DUE are strict filters; CANCELED triggers
// the ignored-filter dump (returns CANCELED + PAST_DUE rows).
const STATUSES = ["ACTIVE", "CANCELED", "PAST_DUE"] as const;

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
  //   activeLoop:   actuallyActive === fetched (100%)
  //   pastDueLoop:  actuallyPastDue === fetched (100%)
  //   canceledLoop: actuallyActive === 0 (no ACTIVE bleed)
  // If any of these break, API behavior shifted and the strategy
  // needs revisiting.
  loopSanity: {
    activeLoop: { fetched: number; actuallyActive: number };
    canceledLoop: { fetched: number; actuallyActive: number };
    pastDueLoop: { fetched: number; actuallyPastDue: number };
  };
  // Count of non-ACTIVE rows whose write was refused because the strict
  // ACTIVE filter already claimed that membership_id this run. >0 means
  // the CANCELED dump tried to flip actives and the guard caught it.
  blockedActiveOverwrites: number;
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
  // ACTIVE-loop-wins guard state (see "Defensive write order" in the
  // file header). Membership ids the strict ACTIVE filter claimed this
  // run, and a count of non-ACTIVE overwrites we refused.
  const activeIds = new Set<number>();
  let blockedActiveOverwrites = 0;
  // Sanity counters — must be tracked separately per loop, not on the
  // deduped Map (one row could come from either loop and we'd lose
  // the attribution).
  const sanity = {
    activeLoop: { fetched: 0, actuallyActive: 0 },
    canceledLoop: { fetched: 0, actuallyActive: 0 },
    pastDueLoop: { fetched: 0, actuallyPastDue: 0 },
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
          if (status === "ACTIVE") {
            sanity.activeLoop.fetched++;
            if (r.status === "ACTIVE") sanity.activeLoop.actuallyActive++;
          } else if (status === "PAST_DUE") {
            sanity.pastDueLoop.fetched++;
            if (r.status === "PAST_DUE") sanity.pastDueLoop.actuallyPastDue++;
          } else {
            // CANCELED loop — measures unwanted ACTIVE bleed.
            sanity.canceledLoop.fetched++;
            if (r.status === "ACTIVE") sanity.canceledLoop.actuallyActive++;
          }
          // === ACTIVE-loop-wins guard (see "Defensive write order" in
          // the file header) === The strict ACTIVE filter is ground
          // truth for who is active. Once it has claimed a membership_id
          // this run, no later non-ACTIVE loop may overwrite it. This
          // blocks the CANCELED "ignored-filter" dump from flipping
          // truly-active members to CANCELED via last-write-wins (the
          // June 1 2026 incident: ~142 actives silently lost). Real
          // cancellations are never returned by the strict ACTIVE
          // filter, so they pass through untouched. Loop order per city
          // is [ACTIVE, CANCELED, PAST_DUE] and cross-city ids don't
          // collide, so the ACTIVE set is always populated before its
          // city's non-ACTIVE loops run.
          if (status === "ACTIVE") {
            activeIds.add(r.membershipId);
          } else if (activeIds.has(r.membershipId)) {
            blockedActiveOverwrites++;
            continue;
          }
          dedupedById.set(r.membershipId, mapToDbRow(r, cityAbbr, syncedAt));
        }
        // totalItems is broken on this endpoint — terminate on
        // partial-page only.
        if (rows.length < PAGE_LIMIT) break;
      }
    }
  }

  // --- 3. Sanity log ---
  // ACTIVE loop:   should be 100% row.status=ACTIVE.
  // PAST_DUE loop: should be 100% row.status=PAST_DUE.
  // CANCELED loop: should be 0% row.status=ACTIVE (no ACTIVE bleed
  //                into the dump).
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
  if (
    sanity.pastDueLoop.fetched > 0 &&
    sanity.pastDueLoop.actuallyPastDue < sanity.pastDueLoop.fetched
  ) {
    const pct = (
      (sanity.pastDueLoop.actuallyPastDue / sanity.pastDueLoop.fetched) *
      100
    ).toFixed(1);
    console.warn(
      `⚠ Sanity violation: PAST_DUE-loop returned ${sanity.pastDueLoop.fetched - sanity.pastDueLoop.actuallyPastDue} rows where row.status≠PAST_DUE ` +
        `(${pct}% actually past_due). Expected 100%. The strict-PAST_DUE filter behavior may have changed.`,
    );
  }
  if (sanity.canceledLoop.actuallyActive > 0) {
    const pct = (
      (sanity.canceledLoop.actuallyActive / sanity.canceledLoop.fetched) *
      100
    ).toFixed(1);
    console.warn(
      `⚠ Sanity violation: CANCELED-loop returned ${sanity.canceledLoop.actuallyActive} rows with row.status=ACTIVE ` +
        `(${pct}% of loop). Expected 0%. The strict-ACTIVE filter may have loosened — review sync strategy.`,
    );
  }

  // The guard firing is itself a signal the upstream dump is
  // misbehaving — surface it even though the data was protected.
  if (blockedActiveOverwrites > 0) {
    console.warn(
      `ℹ ACTIVE-loop-wins guard blocked ${blockedActiveOverwrites} non-ACTIVE overwrite(s) of rows the strict ACTIVE filter claimed this run. ` +
        `Expected 0 in normal operation — a positive count means the CANCELED dump is returning actives tagged non-ACTIVE (the June 1 2026 failure mode), now neutralized.`,
    );
  }

  const dbRows = [...dedupedById.values()];

  // --- 3b. Collapse circuit breaker ---
  // Mechanism-agnostic backstop that runs BEFORE any write. Basis is
  // ACTIVE + PAST_DUE (the live member base), NOT ACTIVE alone: the
  // 1st-of-month billing batch legitimately flips many ACTIVE → PAST_DUE
  // (cards declining on recharge), which preserves the sum, so it must
  // NOT trip the breaker. Only a real loss — members leaving to CANCELED
  // or the sync corrupting — drops the sum. If this run would cut the
  // member base >20% versus what's already in the table, abort so the
  // cron records a non-2xx failure and the prior good data + downstream
  // snapshot are preserved rather than silently overwritten. Does NOT
  // block recovery: a heal run goes UP, which trips nothing.
  const COLLAPSE_FLOOR = 0.8;
  const isMemberBase = (s: string | null) => s === "ACTIVE" || s === "PAST_DUE";
  const newMemberCount = dbRows.filter((r) => isMemberBase(r.status)).length;
  const { count: prevMemberRaw, error: countErr } = await supabase
    .from("mdapi_subscriptions")
    .select("membership_id", { count: "exact", head: true })
    .in("status", ["ACTIVE", "PAST_DUE"]);
  if (countErr) {
    throw new Error(
      `mdapi_subscriptions: member-count preflight failed, refusing to upsert blind: ${countErr.message}`,
    );
  }
  const prevMember = prevMemberRaw ?? 0;
  if (prevMember > 0 && newMemberCount < prevMember * COLLAPSE_FLOOR) {
    const pctDrop = (((prevMember - newMemberCount) / prevMember) * 100).toFixed(
      0,
    );
    throw new Error(
      `mdapi_subscriptions: ABORTED upsert — member base (ACTIVE+PAST_DUE) would collapse ${prevMember} → ${newMemberCount} ` +
        `(${pctDrop}% drop, >20% circuit breaker). Upstream is likely mis-tagging members; refusing to overwrite good data. ` +
        `Re-run to acknowledge if this is a real drop. (blockedActiveOverwrites this run=${blockedActiveOverwrites})`,
    );
  }

  // --- 4. Upsert in batches ---
  // Snapshot the deduped values once, then iterate. Map.values() is
  // an iterator — slicing it would re-walk from the start each batch.
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
    blockedActiveOverwrites,
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
