// Per-city max-active-membership-price snapshot. Called nightly by
// the cron orchestrator (between mdapi-subscriptions and the existing
// members_monthly_snapshots step) and on-demand from the manual
// /api/sync/snapshots trigger backing the /data SyncCard.
//
// What it does each run:
//   1. SELECT (city_identifier, price) FROM mdapi_subscriptions
//      WHERE status='ACTIVE'.
//   2. Group by city_identifier; compute MAX(price) + count of subs
//      at that max.
//   3. Translate the 3-letter mdapi abbr → cockpit display city via
//      cityFromAbbr. Cities the cockpit doesn't recognize are
//      skipped (matches the existing membershipSnapshots behavior).
//   4. For each known city, read its most recent
//      membership_price_snapshots row. INSERT a new row only when
//      the current MAX differs from the latest snapshot's MAX. First
//      observation per city writes the baseline.
//
// What it explicitly does NOT do:
//   - Track count_at_max changes alone — only price changes create
//     new rows. Same-price-different-count would generate noise
//     without surfacing a price event.
//   - Populate stripe_price_id. The MatchDay API's /admin/subscriptions
//     response does not include Stripe identifiers; the column is
//     nullable for forward-compat if a future enrichment path adds
//     direct Stripe lookup.
//   - Backfill history for the period before the first run. There's
//     no audit source to derive prior changes from — the earliest
//     captured_at per city is the baseline.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cityFromAbbr } from "./cityMap";

export type MembershipPriceSnapshotResult = {
  // Cities considered (had ≥1 ACTIVE sub AND resolved via cityFromAbbr).
  citiesEvaluated: number;
  // Rows actually written (either baseline or price-change event).
  changesInserted: number;
  // Cities where MAX matched the existing latest snapshot — nothing
  // to write.
  skippedNoChange: number;
  // mdapi city_identifiers cityFromAbbr didn't recognize — skipped
  // entirely (the cockpit has no surface for them anyway).
  skippedUnknownCity: number;
};

type ActiveSub = {
  city_identifier: string | null;
  price: number | null;
};

type LatestSnapshot = {
  city: string;
  max_price_dollars: number;
};

type Stats = {
  max: number;
  countAtMax: number;
};

export async function refreshMembershipPriceSnapshots(
  sb: SupabaseClient,
): Promise<MembershipPriceSnapshotResult> {
  // 1. Pull every ACTIVE subscription. Small table (~425 rows today);
  //    no pagination needed and no batching cost worth optimizing.
  const { data: actives, error: activesErr } = await sb
    .from("mdapi_subscriptions")
    .select("city_identifier, price")
    .eq("status", "ACTIVE");
  if (activesErr) {
    throw new Error(`mdapi_subscriptions read: ${activesErr.message}`);
  }

  // 2. Group by city_identifier → max + count_at_max.
  const byAbbr = new Map<string, Stats>();
  for (const row of (actives ?? []) as ActiveSub[]) {
    const abbr = row.city_identifier?.trim();
    if (!abbr || row.price == null) continue;
    const priceNum = Number(row.price);
    if (!Number.isFinite(priceNum)) continue;
    const cur = byAbbr.get(abbr);
    if (!cur) {
      byAbbr.set(abbr, { max: priceNum, countAtMax: 1 });
    } else if (priceNum > cur.max) {
      cur.max = priceNum;
      cur.countAtMax = 1;
    } else if (priceNum === cur.max) {
      cur.countAtMax++;
    }
  }

  // 3. Translate abbr → cockpit display city; collect skips.
  const byCity = new Map<string, Stats>();
  let skippedUnknownCity = 0;
  for (const [abbr, stats] of byAbbr) {
    const city = cityFromAbbr(abbr);
    if (!city) {
      skippedUnknownCity++;
      continue;
    }
    byCity.set(city, stats);
  }

  // 4. Read latest snapshot per city. Single ORDER BY + first-
  //    occurrence-wins dedupe — avoids 8 round-trips.
  const { data: snapRows, error: snapErr } = await sb
    .from("membership_price_snapshots")
    .select("city, max_price_dollars")
    .order("captured_at", { ascending: false });
  if (snapErr) {
    throw new Error(`membership_price_snapshots read: ${snapErr.message}`);
  }
  const latestByCity = new Map<string, number>();
  for (const r of (snapRows ?? []) as LatestSnapshot[]) {
    if (latestByCity.has(r.city)) continue;
    latestByCity.set(r.city, Number(r.max_price_dollars));
  }

  // 5. INSERT-on-change per city. Cities with no prior snapshot get
  //    a baseline row regardless. Cities whose MAX equals the latest
  //    snapshot are skipped.
  let changesInserted = 0;
  let skippedNoChange = 0;
  for (const [city, stats] of byCity) {
    const latest = latestByCity.get(city);
    if (latest !== undefined && latest === stats.max) {
      skippedNoChange++;
      continue;
    }
    const { error: insErr } = await sb
      .from("membership_price_snapshots")
      .insert({
        city,
        max_price_dollars: stats.max,
        active_count_at_price: stats.countAtMax,
      });
    if (insErr) {
      throw new Error(`snapshot insert (${city}): ${insErr.message}`);
    }
    changesInserted++;
  }

  return {
    citiesEvaluated: byCity.size,
    changesInserted,
    skippedNoChange,
    skippedUnknownCity,
  };
}
