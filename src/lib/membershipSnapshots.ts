import { type SupabaseClient } from "@supabase/supabase-js";
import { supabase as defaultClient } from "./supabase";
import { selectAll } from "./supabasePagination";
import {
  computeMonthlySnapshot,
  type AttendanceRow,
  type MemberLike,
} from "./membershipStats";
import { CITIES } from "./types";
import { cityFromAbbr } from "./cityMap";
import { fetchJoinedMatchPlayers } from "./mdapiMatchesRead";

// Single source of truth for membership snapshot writes. Called from
// the cron orchestrator (6th step), the manual /api/sync/snapshots
// endpoint backing the SyncCard on /data, and the standalone
// scripts/refresh-membership-snapshots.ts runner.
//
// Phase 3b: reads mdapi_subscriptions (was fin_members). Column
// rename + price (dollars) → price_cents shim happens at the read
// site below — MemberLike shape stays identical so the predicates
// in membershipStats.ts continue to work unchanged.
//
// On the 1st-5th of the month we ALSO refresh the prior month's
// snapshot, so late activations / late cancellations (Stripe delays
// or late uploads) still reach the correct month bucket. Using the
// last day of the prior month as ref keeps every snapshot's asOf
// aligned with end-of-month semantics — important so the live
// refresh and the historical backfill converge on the same value
// for any given month, regardless of which path wrote the row last.
export async function refreshMembershipSnapshots(opts: {
  sourceFileName?: string;
  now?: Date;
  // Optional service-role client for offline scripts (e.g.,
  // scripts/refresh-membership-snapshots.ts). Defaults to the module-
  // level supabase import which uses the publishable key — fine for
  // CSV-upload callers running in the browser with an authed user.
  client?: SupabaseClient;
} = {}): Promise<{ writtenMonths: string[]; guardedMonths: string[] }> {
  const sb = opts.client ?? defaultClient;
  const now = opts.now ?? new Date();

  type MdapiSubRow = {
    status: string | null;
    price: number | null;
    member_email: string | null;
    activation_date: string | null;
    canceled_at: string | null;
    city_identifier: string | null;
  };

  const [rawMembers, joinedMatches] = await Promise.all([
    // Stable .order() required so selectAll's paginated .range()
    // doesn't drop or duplicate rows — see supabasePagination.ts.
    selectAll<MdapiSubRow>(() =>
      sb
        .from("mdapi_subscriptions")
        .select(
          "status, price, member_email, activation_date, canceled_at, city_identifier",
        )
        .order("membership_id"),
    ),
    // Phase 5b: attendance reads from mdapi_matches +
    // mdapi_match_players via the shared lib. Project the joined
    // rows to the AttendanceRow shape (match_start as Date is
    // accepted by computeAvgMatchesPerMember).
    fetchJoinedMatchPlayers(sb),
  ]);
  const attendance: AttendanceRow[] = joinedMatches.rows.map((r) => ({
    match_start: r.matchStart,
    payment_type: r.paymentType,
    email: r.email,
  }));

  // Map to MemberLike + skip unknown cities (matches useFinanceData
  // behavior). cityFromAbbr returns null for any abbr not in our
  // cockpit map — those rows would have nowhere to go in CITIES
  // anyway, so dropping them is the correct call.
  const members: MemberLike[] = [];
  for (const r of rawMembers) {
    const city = cityFromAbbr(r.city_identifier);
    if (!city) continue;
    members.push({
      status: r.status ?? "",
      price_cents: Math.round((r.price ?? 0) * 100),
      email: r.member_email,
      activation_date: r.activation_date,
      canceled_at: r.canceled_at,
      city,
    });
  }

  const refDates: Date[] = [now];
  if (now.getDate() <= 5) {
    // Day 0 of the current month = last day of the prior month.
    refDates.unshift(new Date(now.getFullYear(), now.getMonth(), 0));
  }

  // Regression guard: refuse to overwrite a stored month whose active
  // count would drop more than this fraction. A closed month re-computes
  // within a few % from late backdated events; a >10% active drop means
  // the source (mdapi_subscriptions) is corrupted — keep the stored row
  // and warn loud rather than silently overwrite good history with bad
  // data (the June 1 2026 incident overwrote May's 379 with a corrupted
  // 232). Skip-and-warn per month: a guarded prior month does not block
  // the legitimate current-month write.
  const REGRESSION_FLOOR = 0.9;
  const writtenMonths: string[] = [];
  const guardedMonths: string[] = [];

  for (const refDate of refDates) {
    const snap = computeMonthlySnapshot(
      members,
      attendance,
      CITIES,
      refDate,
      opts.sourceFileName,
    );

    const { data: existing } = await sb
      .from("members_monthly_snapshots")
      .select("active_count")
      .eq("month", snap.month)
      .maybeSingle<{ active_count: number }>();
    if (
      existing &&
      existing.active_count > 0 &&
      snap.active_count < existing.active_count * REGRESSION_FLOOR
    ) {
      const pct = Math.round(
        (1 - snap.active_count / existing.active_count) * 100,
      );
      console.warn(
        `⚠ membership-snapshots regression guard: refusing to overwrite ${snap.month} — ` +
          `active ${existing.active_count} → ${snap.active_count} (${pct}% drop, >10% floor). ` +
          `Keeping the stored row. Likely upstream subscription corruption — investigate before forcing a refresh.`,
      );
      guardedMonths.push(snap.month);
      continue;
    }

    const { error } = await sb
      .from("members_monthly_snapshots")
      .upsert(snap, { onConflict: "month" });
    if (error) {
      console.warn(
        `Membership snapshot upsert failed for ${snap.month}:`,
        error.message,
      );
      continue;
    }
    writtenMonths.push(snap.month);
  }

  return { writtenMonths, guardedMonths };
}
