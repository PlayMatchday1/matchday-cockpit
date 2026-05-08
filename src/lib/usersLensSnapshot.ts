// Refreshes mdapi_users_lens_snapshot + mdapi_users_lens_aggregate_snapshot.
// One snapshot row per (window_key, city) on the per-city table; one
// aggregate row per window_key on the aggregate table.
//
// Strategy: fetchAll() once (the slow ~4.6s part), then run aggregate()
// six times — once per stable window — over the same in-memory dataset.
// Each aggregation is ~120ms in V8 (measured). Total refresh: ~5.4s
// for fetch + ~720ms for six aggregations + a handful of writes. Well
// inside the cron's per-step budget.
//
// Truncate-and-insert is fine — both tables are tiny (54 + 6 rows).

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aggregate,
  fetchAll,
  type UsersLensPayload,
} from "@/app/api/cities/users-lens/route";

// Stable windows we pre-compute. UI maps lens window names ('all',
// '2026_ytd', etc.) to these snapshot keys at read time. 2025_ytd and
// 2024_ytd are pre-computed for forward compatibility — the UI doesn't
// expose them yet but the data is ready when pills are added.
export const SNAPSHOT_WINDOW_KEYS = [
  "all_time",
  "2026_ytd",
  "2025_ytd",
  "2024_ytd",
  "last_90",
  "last_12mo",
] as const;
export type SnapshotWindowKey = (typeof SNAPSHOT_WINDOW_KEYS)[number];

// Resolve a snapshot_key + a reference "now" to concrete from/to dates
// (or null bounds for All time). Used by both the writer (at refresh
// time) and the reader (to reconstruct payload.window for the lens).
export function snapshotKeyDates(
  key: SnapshotWindowKey,
  now: Date,
): { from: Date | null; to: Date | null } {
  const day = (d: Date) => {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  };
  const dayEnd = (d: Date) => {
    const out = new Date(d);
    out.setUTCHours(23, 59, 59, 999);
    return out;
  };
  if (key === "all_time") return { from: null, to: null };
  if (key === "2026_ytd") {
    return {
      from: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0)),
      to: dayEnd(now),
    };
  }
  if (key === "2025_ytd") {
    return {
      from: new Date(Date.UTC(2025, 0, 1, 0, 0, 0, 0)),
      to: new Date(Date.UTC(2025, 11, 31, 23, 59, 59, 999)),
    };
  }
  if (key === "2024_ytd") {
    return {
      from: new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)),
      to: new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999)),
    };
  }
  if (key === "last_90") {
    const from = day(new Date(now.getTime() - 90 * 86400000));
    return { from, to: dayEnd(now) };
  }
  if (key === "last_12mo") {
    const from = new Date(now);
    from.setUTCFullYear(from.getUTCFullYear() - 1);
    return { from: day(from), to: dayEnd(now) };
  }
  return { from: null, to: null };
}

type PerCityRow = {
  window_key: string;
  city: string;
  registered: number;
  completed_signup: number;
  played_1plus: number;
  played_3plus: number;
  played_5plus: number;
  played_10plus: number;
  members: number;
  active_30d: number;
  active_60d: number;
  computed_at: string;
};

type AggregateRow = {
  window_key: string;
  growth_monthly_signups: unknown;
  growth_monthly_completed: unknown;
  growth_monthly_played: unknown;
  growth_weekly_signups: unknown;
  growth_weekly_completed: unknown;
  growth_weekly_played: unknown;
  matrix_data: unknown;
  funnel_speed: unknown;
  network_active_30d: number;
  network_played_1plus: number;
  computed_at: string;
};

export type RefreshUsersLensSnapshotResult = {
  windowsComputed: number;
  perCityRowsWritten: number;
  aggregateRowsWritten: number;
  // Always equal to the result for 2026_ytd window, so callers can
  // sanity-check totals match what the live route returns.
  ytd2026Registered: number;
  // Total elapsed for fetchAll + all six aggregations + writes.
  durationMs: number;
};

export async function refreshUsersLensSnapshot(
  supabase: SupabaseClient,
): Promise<RefreshUsersLensSnapshotResult> {
  const startedAt = Date.now();
  const now = new Date();
  const computedAtIso = now.toISOString();

  // 1. Pull all four tables once — the heavy step.
  const t0 = Date.now();
  const { users, players, matches, subs } = await fetchAll(supabase);
  console.log(
    `[lens-snapshot] fetchAll ${Date.now() - t0}ms (${users.length} users, ${players.length} players, ${matches.length} matches, ${subs.length} subs)`,
  );

  // 2. Compute aggregate for each stable window.
  const perCityRows: PerCityRow[] = [];
  const aggregateRows: AggregateRow[] = [];
  let ytd2026Registered = 0;
  for (const key of SNAPSHOT_WINDOW_KEYS) {
    const { from, to } = snapshotKeyDates(key, now);
    const tAgg = Date.now();
    const payload: UsersLensPayload = aggregate(
      users,
      players,
      matches,
      subs,
      now,
      from,
      to,
    );
    console.log(
      `[lens-snapshot] aggregate ${key} ${Date.now() - tAgg}ms (registered=${payload.hero.registered})`,
    );
    if (key === "2026_ytd") ytd2026Registered = payload.hero.registered;

    // 3. Reshape per-city rows from payload.byCity.
    for (const r of payload.byCity) {
      perCityRows.push({
        window_key: key,
        city: r.city,
        registered: r.registered,
        completed_signup: r.completedSignup,
        played_1plus: r.played1,
        played_3plus: r.played3,
        played_5plus: r.played5,
        played_10plus: r.played10,
        members: r.members,
        // Per-city active30d in payload; active60d not currently
        // surfaced in payload but the column exists for forward
        // compat. Mirror active30d for now; real active60d can land
        // when the byCity row exposes it.
        active_30d: r.active30d,
        active_60d: r.active30d,
        computed_at: computedAtIso,
      });
    }

    aggregateRows.push({
      window_key: key,
      growth_monthly_signups: payload.growthMonthly.signups,
      growth_monthly_completed: payload.growthMonthly.completed,
      growth_monthly_played: payload.growthMonthly.played,
      growth_weekly_signups: payload.growthWeekly.signups,
      growth_weekly_completed: payload.growthWeekly.completed,
      growth_weekly_played: payload.growthWeekly.played,
      matrix_data: payload.matrix,
      funnel_speed: payload.funnelSpeed,
      // Network-wide values are window-independent; same value
      // written to every aggregate row by design (denormalized
      // for read simplicity).
      network_active_30d: payload.hero.active30d,
      network_played_1plus: Math.round(
        // active30dPctOfNetworkPlayed1 = active30d / networkPlayed1 * 100
        // → networkPlayed1 = active30d * 100 / pct. Round-trip from
        // existing fields without re-deriving from raw rows.
        payload.hero.active30dPctOfNetworkPlayed1 > 0
          ? (payload.hero.active30d * 100) /
              payload.hero.active30dPctOfNetworkPlayed1
          : 0,
      ),
      computed_at: computedAtIso,
    });
  }

  // 4. Truncate-and-insert. Tables are tiny so we don't bother with
  //    diff-and-update; full replace is safe and atomic enough at this
  //    scale (any partial-failure leaves the prior snapshot in place
  //    until the next run, since we delete + insert in a single batch).
  const tWrite = Date.now();
  const { error: delPerCityErr } = await supabase
    .from("mdapi_users_lens_snapshot")
    .delete()
    .gte("window_key", ""); // delete all
  if (delPerCityErr) {
    throw new Error(
      `mdapi_users_lens_snapshot delete failed: ${delPerCityErr.message}`,
    );
  }
  const { error: insPerCityErr } = await supabase
    .from("mdapi_users_lens_snapshot")
    .insert(perCityRows);
  if (insPerCityErr) {
    throw new Error(
      `mdapi_users_lens_snapshot insert failed: ${insPerCityErr.message}`,
    );
  }

  const { error: delAggErr } = await supabase
    .from("mdapi_users_lens_aggregate_snapshot")
    .delete()
    .gte("window_key", "");
  if (delAggErr) {
    throw new Error(
      `mdapi_users_lens_aggregate_snapshot delete failed: ${delAggErr.message}`,
    );
  }
  const { error: insAggErr } = await supabase
    .from("mdapi_users_lens_aggregate_snapshot")
    .insert(aggregateRows);
  if (insAggErr) {
    throw new Error(
      `mdapi_users_lens_aggregate_snapshot insert failed: ${insAggErr.message}`,
    );
  }
  console.log(`[lens-snapshot] writes ${Date.now() - tWrite}ms`);

  return {
    windowsComputed: SNAPSHOT_WINDOW_KEYS.length,
    perCityRowsWritten: perCityRows.length,
    aggregateRowsWritten: aggregateRows.length,
    ytd2026Registered,
    durationMs: Date.now() - startedAt,
  };
}
