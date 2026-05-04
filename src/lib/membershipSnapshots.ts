import { supabase } from "./supabase";
import { selectAll } from "./supabasePagination";
import {
  computeMonthlySnapshot,
  type AttendanceRow,
  type MemberLike,
} from "./membershipStats";
import { CITIES } from "./types";

// Single source of truth for membership snapshot writes. Called from
// commitMembers (Members CSV upload) and MatchesUploader (user_analysis
// upload) — whichever ran last refreshes the snapshot using whatever's
// in the DB at that moment.
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
} = {}): Promise<void> {
  const now = opts.now ?? new Date();

  const [members, attendance] = await Promise.all([
    selectAll<MemberLike>(() =>
      supabase
        .from("fin_members")
        .select("status,price_cents,email,activation_date,canceled_at,city"),
    ),
    selectAll<AttendanceRow>(() =>
      supabase
        .from("match_registrations")
        .select("match_start,payment_type,email"),
    ),
  ]);

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
    const { error } = await supabase
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
