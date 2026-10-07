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
import { classifyCharge, cityFromIdentifier, DELETED_ACCOUNT_CITY } from "./financeImport";
import { cityFromAbbr } from "./cityMap";
import { selectAll } from "./supabasePagination";
import { mapBalanceTxn, isTransferCategory, type FinTxnRow } from "./finTxnMap";
import { BUSINESS_TZ, zonedWallClockToUtcMs } from "./businessHours";
import type { VenmoMirrorResult } from "./finTxnVenmo";

export type FinTxnSyncResult = {
  fetched: number;
  upserted: number;
  inserted: number;
  updated: number;
  unmappedFieldIds: number[];
  /** Transfers and top-ups: counted, never stored. Expected and not an advisory. */
  skippedTransfers: number;
  /** A category this build does not recognise. SKIPPED AND REPORTED — never bucketed. */
  unknownCategories: { category: string; count: number; grossCents: number }[];
  /** Rows whose city, type, field or charge link was filled in or corrected. Written, NOT stamped:
   *  only an amount or an exclusion moving sets updated_at ("Adjusted after final"). */
  attributed: number;
  /** Refunds and disputes whose charge is not in fin_txn — they keep no city. */
  reversalsUnlinked: number;
  sinceIso: string;
  untilIso: string;
};

/** mdapi field id → fin_venues.id. Read once per run; 54 rows. */
async function fieldToVenue(sb: SupabaseClient): Promise<Map<number, number>> {
  const { data, error } = await sb.from("fin_venue_fields").select("fin_venue_id,mdapi_field_id");
  if (error) throw new Error(`fin_venue_fields read failed: ${error.message}`);
  return new Map((data ?? []).map((r) => [Number(r.mdapi_field_id), Number(r.fin_venue_id)]));
}

/* ── THE CITY, DECIDED THE WAY fin_revenue DECIDES IT ───────────────────────────────────────────
 * A copy of stripeSync.syncStripeCharges' allocation (src/lib/stripeSync.ts, "Build email→city"
 * and the per-type branch), so both tables put a charge in the same city:
 *   Strike          cityIdentifier
 *   Membership      email → mdapi_subscriptions.city_identifier, else mdapi_users.preferable_city
 *   DPP             cityIdentifier, else metadata.matchId → mdapi_matches.city_identifier
 *   everything else cityIdentifier, else the matchId join
 * Anything that resolves to nothing is DELETED_ACCOUNT_CITY, which the Revenue page shows as
 * "Unassigned". stripeSync is NOT imported or changed: it feeds fin_revenue's nightly job, which
 * stays as it is. If one changes, change both. */
type CityMaps = { emailToCity: Map<string, string>; matchToCity: Map<string, string> };

async function cityMaps(sb: SupabaseClient): Promise<CityMaps> {
  const emailToCity = new Map<string, string>();
  const subs = await selectAll<{ member_email: string | null; city_identifier: string | null }>(() =>
    sb.from("mdapi_subscriptions").select("member_email, city_identifier").order("membership_id"));
  for (const m of subs) if (m.member_email) emailToCity.set(m.member_email.toLowerCase().trim(), cityFromAbbr(m.city_identifier) ?? DELETED_ACCOUNT_CITY);
  const users = await selectAll<{ email: string | null; preferable_city_normalized: string | null }>(() =>
    sb.from("mdapi_users").select("email, preferable_city_normalized").not("email", "is", null).not("preferable_city_normalized", "is", null).order("id"));
  for (const u of users) {
    if (!u.email) continue;
    const e = u.email.toLowerCase().trim();
    if (!emailToCity.has(e)) emailToCity.set(e, cityFromAbbr(u.preferable_city_normalized) ?? DELETED_ACCOUNT_CITY);
  }
  const matchToCity = new Map<string, string>();
  const matches = await selectAll<{ api_id: number | null; city_identifier: string | null }>(() =>
    sb.from("mdapi_matches").select("api_id, city_identifier").order("api_id"));
  for (const m of matches) { const c = cityFromAbbr(m.city_identifier); if (m.api_id != null && c) matchToCity.set(String(m.api_id), c); }
  return { emailToCity, matchToCity };
}

export function allocateCity(maps: CityMaps, a: { type: string; cityIdentifier: string | null; matchId: string | null; email: string | null }): string {
  if (a.type === "Membership") {
    const hit = a.email ? maps.emailToCity.get(a.email) : undefined;
    return hit && hit !== DELETED_ACCOUNT_CITY ? hit : DELETED_ACCOUNT_CITY;
  }
  const byCode = cityFromIdentifier(a.cityIdentifier);
  if (a.type === "Strike" || byCode !== DELETED_ACCOUNT_CITY) return byCode;
  return (a.matchId ? maps.matchToCity.get(a.matchId) : undefined) ?? DELETED_ACCOUNT_CITY;
}

/* MEMBERSHIP CHARGES ARE INVOICE CHARGES: Stripe puts the member's email on the CUSTOMER, not the
 * charge. stripeSync gets it by expanding data.customer on charges.list; balance_transactions.list
 * cannot expand a field of its polymorphic source safely, so the customers are fetched here — once
 * each per run, THREE at a time. Eight tripped Stripe's rate limiter on the first history re-run
 * (2023-07, "Request rate limit exceeded"); the client also retries a 429 with backoff, which is safe
 * because every call here is a GET. A deleted customer has no email and lands Unassigned, as in
 * fin_revenue. Emails are held in memory for the run and never stored. */
/* ── STRIPE'S RATE LIMIT, WAITED OUT ───────────────────────────────────────────────────────────
 * The SDK does not retry a 429 unless Stripe sends `stripe-should-retry: true`, and its rate-limit
 * answers do not — so `maxNetworkRetries` alone did nothing for them (2023-12 and 2024-01 still
 * failed on the re-run). Every call wrapped here is a GET, so trying again cannot duplicate
 * anything: back off 1, 2, 4, 8, 16 s (plus jitter) and give up after the sixth attempt. */
async function readWithBackoff<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await call(); }
    catch (e) {
      const rateLimited = (e as { statusCode?: number; type?: string }).statusCode === 429
        || (e as { type?: string }).type === "StripeRateLimitError";
      if (!rateLimited || attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1) + Math.random() * 500));
    }
  }
}

async function customerEmails(stripe: Stripe, ids: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const queue = [...new Set(ids)];
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let id = queue.pop(); id; id = queue.pop()) {
      const c = await readWithBackoff(() => stripe.customers.retrieve(id));
      out.set(id, "deleted" in c && c.deleted ? null : ((c as Stripe.Customer).email ?? null));
    }
  }));
  return out;
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
  // READ-ONLY CLIENT: every call below is a GET, so retrying a 429 or a dropped connection cannot
  // duplicate anything. The SDK backs off between attempts.
  const stripe = new Stripe(opts.apiKey, { maxNetworkRetries: 4 });
  const venueOf = await fieldToVenue(sb);
  const maps = await cityMaps(sb);
  const unmapped = new Set<number>();

  // PAGED BY HAND so each page can wait out a rate limit (readWithBackoff); auto-pagination gives
  // no place to put the retry.
  const all: Stripe.BalanceTransaction[] = [];
  for (let after: string | undefined; ;) {
    const page = await readWithBackoff(() => stripe.balanceTransactions.list({
      created: { gte: Math.floor(opts.since.getTime() / 1000), lt: Math.floor(opts.until.getTime() / 1000) },
      limit: 100,
      expand: ["data.source"],
      ...(after ? { starting_after: after } : {}),
    }));
    all.push(...page.data);
    if (opts.onProgress) opts.onProgress(all.length);
    if (!page.has_more || page.data.length === 0) break;
    after = page.data[page.data.length - 1].id;
  }
  const fetched = all.length;

  // The customers whose email a membership city needs: charges with no email of their own.
  const needEmail = all.flatMap((bt) => {
    const c = bt.source as Stripe.Charge | null;
    if (!c || typeof c !== "object" || c.object !== "charge" || typeof c.customer !== "string") return [];
    if (c.billing_details?.email || c.receipt_email || (typeof c.metadata?.email === "string" && c.metadata.email.trim())) return [];
    return [c.customer];
  });
  const emails = await customerEmails(stripe, needEmail);

  const rows: (FinTxnRow & { fin_venue_id: number | null })[] = [];
  const unknown = new Map<string, { count: number; grossCents: number }>();
  let skippedTransfers = 0;
  for (const bt of all) {
    const cat = String(bt.reporting_category ?? "");
    const row = mapBalanceTxn(bt, {
      classify: classifyCharge,
      cityOf: (a) => allocateCity(maps, a),
      customerEmail: (id) => emails.get(id) ?? null,
      venueOfField: (id) => {
        const v = venueOf.get(id);
        if (v == null) unmapped.add(id);
        return v ?? null;
      },
    });
    if (row == null) {
      // A TRANSFER IS EXPECTED AND SILENT. ANYTHING ELSE IS AN ADVISORY: a category nobody has
      // classified must be visible, not absorbed into whichever bucket happens to be the default.
      if (isTransferCategory(cat)) { skippedTransfers++; continue; }
      const e = unknown.get(cat) ?? { count: 0, grossCents: 0 };
      e.count++; e.grossCents += bt.amount;
      unknown.set(cat, e);
      continue;
    }
    rows.push(row);
  }

  /* ── A REFUND OR DISPUTE TAKES ITS CHARGE'S CITY, TYPE AND FIELD ───────────────────────────────
   * Its own source carries no metadata. The charge is found in this run's rows first, then in
   * fin_txn (a refund usually lands days or weeks after its charge). Not found → it keeps what it
   * has, Unassigned, and is counted. The exclusion flags come with it: a refund of an internal
   * account's charge is internal too. */
  const chargeRow = new Map<string, Pick<FinTxnRow, "city" | "type" | "field_id" | "is_test" | "is_internal" | "exclude_reason"> & { fin_venue_id: number | null }>();
  for (const r of rows) if (r.kind === "charge" && r.charge_id) chargeRow.set(r.charge_id, r);
  const reversals = rows.filter((r) => (r.kind === "refund" || r.kind === "dispute") && r.charge_id);
  const missing = [...new Set(reversals.map((r) => r.charge_id!).filter((id) => !chargeRow.has(id)))];
  for (let i = 0; i < missing.length; i += 200) {
    const { data, error } = await sb.from("fin_txn")
      .select("charge_id,city,type,field_id,fin_venue_id,is_test,is_internal,exclude_reason")
      .eq("kind", "charge").in("charge_id", missing.slice(i, i + 200));
    if (error) throw new Error(`fin_txn charge lookup failed: ${error.message}`);
    for (const c of data ?? []) chargeRow.set(String(c.charge_id), c as never);
  }
  let reversalsUnlinked = 0;
  for (const r of rows) {
    if (r.kind !== "refund" && r.kind !== "dispute") continue;
    const c = r.charge_id ? chargeRow.get(r.charge_id) : undefined;
    if (!c) { reversalsUnlinked++; continue; }
    Object.assign(r, { city: c.city, type: c.type, field_id: c.field_id, fin_venue_id: c.fin_venue_id,
      is_test: c.is_test, is_internal: c.is_internal, exclude_reason: c.exclude_reason });
  }

  /* ── THE UPSERT, AND WHAT SETS updated_at ───────────────────────────────────────────────────
   * updated_at is what "Adjusted after final" reads, so it is set ONLY when an AMOUNT or an
   * EXCLUSION moves (Ryan, 2026-10-07). A city, type, field or charge link being filled in or
   * corrected is written but not stamped — it moves a row between cities, never the month's total.
   *
   * THE EXISTING updated_at IS CARRIED FORWARD on every other row. A bulk upsert sends one column
   * list for the whole batch, and a row without the key gets NULL — so once any row in a batch is
   * stamped, every unstamped row beside it would have its history wiped. */
  const ids = rows.map((r) => r.balance_txn_id);
  const existing = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await sb.from("fin_txn")
      .select("balance_txn_id,gross_cents,fee_cents,net_cents,city,type,field_id,fin_venue_id,is_test,is_internal,dispute_reason,charge_id,updated_at")
      .in("balance_txn_id", ids.slice(i, i + 500));
    if (error) throw new Error(`fin_txn read-before failed: ${error.message}`);
    for (const r of data ?? []) existing.set(String(r.balance_txn_id), r);
  }

  const AMOUNTS = ["gross_cents","fee_cents","net_cents","is_test","is_internal"] as const;
  const ATTRIBUTION = ["city","type","field_id","fin_venue_id","dispute_reason","charge_id"] as const;
  const differs = (was: Record<string, unknown>, r: Record<string, unknown>, keys: readonly string[]) =>
    keys.some((k) => (was[k] ?? null) !== (r[k] ?? null));
  let inserted = 0, updated = 0, attributed = 0;
  const stamp = new Date().toISOString();
  const payload = rows.map((r) => {
    const was = existing.get(r.balance_txn_id);
    if (!was) { inserted++; return { ...r, updated_at: null }; }
    const moved = differs(was, r as Record<string, unknown>, AMOUNTS);
    if (moved) updated++;
    else if (differs(was, r as Record<string, unknown>, ATTRIBUTION)) attributed++;
    return { ...r, updated_at: moved ? stamp : ((was.updated_at as string | null) ?? null) };
  });

  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await sb.from("fin_txn")
      .upsert(payload.slice(i, i + 500), { onConflict: "balance_txn_id" });
    if (error) throw new Error(`fin_txn upsert failed: ${error.message}`);
  }

  return {
    fetched, upserted: payload.length, inserted, updated, attributed, reversalsUnlinked,
    unmappedFieldIds: [...unmapped].sort((a, b) => a - b),
    skippedTransfers,
    unknownCategories: [...unknown].map(([category, e]) => ({ category, ...e }))
      .sort((a, b) => b.count - a.count),
    sinceIso: opts.since.toISOString(), untilIso: opts.until.toISOString(),
  };
}

/** What runWithLog writes onto the fin_sync_log row. */
export const finTxnLogPatch = (r: FinTxnSyncResult & { venmo?: VenmoMirrorResult }) => {
  /* BOTH ADVISORIES ON ONE LINE. error_message on a COMPLETED row is the house's advisory channel —
   * the run succeeded, and something about it needs a human. An unknown category is the louder of
   * the two: it means money moved in a shape this build has never seen and did not store. */
  const notes: string[] = [];
  if (r.unknownCategories.length) {
    notes.push(
      `UNKNOWN reporting_category, SKIPPED and NOT stored: ` +
      r.unknownCategories.map((u) => `${u.category} ×${u.count} ($${(u.grossCents / 100).toFixed(2)})`).join(", "),
    );
  }
  if (r.unmappedFieldIds.length) {
    notes.push(`${r.unmappedFieldIds.length} fieldId(s) map to no fin_venue_fields row: ${r.unmappedFieldIds.join(", ")}`);
  }
  if (r.reversalsUnlinked) {
    notes.push(`${r.reversalsUnlinked} refund(s)/dispute(s) whose charge is not in fin_txn — left Unassigned`);
  }
  if (r.venmo?.orphaned.length) {
    notes.push(`${r.venmo.orphaned.length} Venmo row(s) in fin_txn no longer in fin_revenue, NOT deleted: ${r.venmo.orphaned.join(", ")}`);
  }
  return {
    charges_fetched: r.fetched,
    rows_imported: r.inserted + (r.venmo?.inserted ?? 0),
    rows_replaced: r.updated + (r.venmo?.updated ?? 0),
    ...(notes.length ? { error_message: `ADVISORY (sync OK) — ${notes.join(" · ")}` } : {}),
  };
};

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
