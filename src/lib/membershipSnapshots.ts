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

// Single source of truth for membership snapshot writes. Called from
// commitMembers (Members CSV upload) and MatchesUploader (user_analysis
// upload) — whichever ran last refreshes the snapshot using whatever's
// in the DB at that moment.
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
} = {}): Promise<void> {
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

  const [rawMembers, attendance] = await Promise.all([
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
    selectAll<AttendanceRow>(() =>
      sb
        .from("match_registrations")
        .select("match_start,payment_type,email")
        .order("id"),
    ),
  ]);

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

  for (const refDate of refDates) {
    const snap = computeMonthlySnapshot(
      members,
      attendance,
      CITIES,
      refDate,
      opts.sourceFileName,
    );
    const { error } = await sb
      .from("members_monthly_snapshots")
      .upsert(snap, { onConflict: "month" });
    if (error) {
      console.warn(
        `Membership snapshot upsert failed for ${snap.month}:`,
        error.message,
      );
    }
  }
}
