/* THE fin_txn SYNC — one code path, three callers.
 *
 *   hourly cron            last 3 days      source 'stripe-txn'
 *   daily cron             last 60 days     source 'stripe-txn'   (disputes arrive weeks late)
 *   Sync now button        last 3 days      source 'stripe-txn'
 *   historical back-fill   one month        source 'stripe-txn-backfill'
 *
 * The window is the ONLY difference. A back-fill that drifts from the sync is a back-fill whose
 * result cannot be trusted to match what the sync will write tomorrow, so there is one function.
 *
 * ── IT NEVER DELETES ────────────────────────────────────────────────────────────────────────────
 * fin_revenue's importer clears a date range and rebuilds it. This does not: it UPSERTS on
 * balance_txn_id. That is what makes every caller safe to re-run, makes overlapping windows
 * harmless, and means a manual Venmo row inside the window cannot be destroyed by a sync.
 *
 * ── IT NEVER TOUCHES fin_revenue ────────────────────────────────────────────────────────────────
 * Until the switch, fin_revenue is the live source for every Finance page and its nightly 06:00
 * Central job is unchanged. Nothing in this file reads or writes it.
 */

import Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyCharge, cityFromIdentifier } from "./financeImport";
import { mapBalanceTxn, type FinTxnRow } from "./finTxnMap";
import { BUSINESS_TZ, zonedWallClockToUtcMs } from "./businessHours";

export type FinTxnSyncResult = {
  fetched: number;
  upserted: number;
  inserted: number;
  updated: number;
  unmappedFieldIds: number[];
  sinceIso: string;
  untilIso: string;
};

/** mdapi field id → fin_venues.id. Read once per run; 54 rows. */
async function fieldToVenue(sb: SupabaseClient): Promise<Map<number, number>> {
  const { data, error } = await sb.from("fin_venue_fields").select("fin_venue_id,mdapi_field_id");
  if (error) throw new Error(`fin_venue_fields read failed: ${error.message}`);
  return new Map((data ?? []).map((r) => [Number(r.mdapi_field_id), Number(r.fin_venue_id)]));
}

/**
 * Pull every balance transaction in [since, until) and upsert it.
 *
 * `expand: ["data.source"]` is what carries the charge's metadata — cityIdentifier, type, matchId
 * and fieldId all live on the charge, not on the balance transaction. Without it every row would
 * land with a null city and no field, which is the state fin_revenue is in today.
 */
export async function syncFinTxn(
  sb: SupabaseClient,
  opts: { since: Date; until: Date; apiKey: string; onProgress?: (n: number) => void },
): Promise<FinTxnSyncResult> {
  const stripe = new Stripe(opts.apiKey);
  const venueOf = await fieldToVenue(sb);
  const unmapped = new Set<number>();

  const rows: (FinTxnRow & { fin_venue_id: number | null })[] = [];
  let fetched = 0;
  for await (const bt of stripe.balanceTransactions.list({
    created: { gte: Math.floor(opts.since.getTime() / 1000), lt: Math.floor(opts.until.getTime() / 1000) },
    limit: 100,
    expand: ["data.source"],
  })) {
    fetched++;
    if (opts.onProgress && fetched % 500 === 0) opts.onProgress(fetched);
    const row = mapBalanceTxn(bt, {
      classify: classifyCharge,
      cityOf: cityFromIdentifier,
      venueOfField: (id) => {
        const v = venueOf.get(id);
        if (v == null) unmapped.add(id);
        return v ?? null;
      },
    });
    rows.push(row);
  }

  /* ── THE UPSERT, AND WHY updated_at IS NOT SET BLINDLY ──────────────────────────────────────
   * Ryan: set updated_at only when a value actually changes. An upsert that stamps every row on
   * every run makes "Adjusted after final" fire on every sync and therefore mean nothing. So the
   * existing rows in the window are read first and compared on the fields that can move; only a
   * genuine difference carries a new updated_at. */
  const ids = rows.map((r) => r.balance_txn_id);
  const existing = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb.from("fin_txn")
      .select("balance_txn_id,gross_cents,fee_cents,net_cents,city,type,field_id,fin_venue_id,is_test,is_internal,dispute_reason")
      .in("balance_txn_id", ids.slice(i, i + 500));
    if (error) throw new Error(`fin_txn read-before failed: ${error.message}`);
    for (const r of data ?? []) existing.set(String(r.balance_txn_id), r);
  }

  const MOVES = ["gross_cents","fee_cents","net_cents","city","type","field_id","fin_venue_id","is_test","is_internal","dispute_reason"] as const;
  let inserted = 0, updated = 0;
  const payload = rows.map((r) => {
    const was = existing.get(r.balance_txn_id);
    if (!was) { inserted++; return r; }
    const changed = MOVES.some((k) => (was[k] ?? null) !== ((r as Record<string, unknown>)[k] ?? null));
    if (changed) updated++;
    return changed ? { ...r, updated_at: new Date().toISOString() } : r;
  });

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await sb.from("fin_txn")
      .upsert(payload.slice(i, i + 500), { onConflict: "balance_txn_id" });
    if (error) throw new Error(`fin_txn upsert failed: ${error.message}`);
  }

  return {
    fetched, upserted: payload.length, inserted, updated,
    unmappedFieldIds: [...unmapped].sort((a, b) => a - b),
    sinceIso: opts.since.toISOString(), untilIso: opts.until.toISOString(),
  };
}

/** What runWithLog writes onto the fin_sync_log row. */
export const finTxnLogPatch = (r: FinTxnSyncResult) => ({
  charges_fetched: r.fetched,
  rows_imported: r.inserted,
  rows_replaced: r.updated,
  ...(r.unmappedFieldIds.length
    ? { error_message: `ADVISORY (sync OK) — ${r.unmappedFieldIds.length} fieldId(s) map to no fin_venue_fields row: ${r.unmappedFieldIds.join(", ")}` }
    : {}),
});

/* ── THE WINDOW, IN CENTRAL, DST AND ALL ───────────────────────────────────────────────────────
 * "the last 3 days" means three Central CALENDAR days ending now, not 72 hours: a sync at 00:30
 * Central must still cover all of the day before.
 *
 * THE OFFSET IS NOT HARDCODED. Chicago is UTC-6 in winter and UTC-5 in summer, so "Central midnight
 * is 06:00Z" is right for five months of the year and an hour wrong for seven. zonedWallClockToUtcMs
 * resolves the real offset for that specific date — the same helper the business-hours code uses, so
 * there is one implementation of this conversion in the estate and not two that drift at the
 * March and November boundaries. */
export function windowDaysBack(days: number, now = new Date()): { since: Date; until: Date } {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ })
    .format(now).split("-").map(Number);
  // Midnight Central on the first day of the window. Date.UTC normalises a negative day-of-month
  // into the previous month, so `d - (days - 1)` crosses month and year boundaries on its own.
  const since = new Date(zonedWallClockToUtcMs(y, m, d - (days - 1), 0, 0, BUSINESS_TZ));
  // A MINUTE PAST NOW, so a transaction created during this very run is not missed by a `lt` bound.
  // Re-running is free — the upsert makes an overlap a no-op — so the window errs wide.
  const until = new Date(now.getTime() + 60_000);
  return { since, until };
}

/** The Central calendar month [first, next first) as UTC instants. The back-fill's unit of work. */
export function windowForMonth(year: number, month1to12: number): { since: Date; until: Date } {
  return {
    since: new Date(zonedWallClockToUtcMs(year, month1to12, 1, 0, 0, BUSINESS_TZ)),
    until: new Date(zonedWallClockToUtcMs(year, month1to12 + 1, 1, 0, 0, BUSINESS_TZ)),
  };
}
