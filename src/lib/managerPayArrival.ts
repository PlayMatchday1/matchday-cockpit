// Arrival-date facts for one Manager Pay week — the PAY RUN (Tuesday after the
// week's Sunday, moved off a Fed holiday) and the ESTIMATED ARRIVAL (4 banking
// days later), plus any admin override. Days are computed every call from the
// date, never stored. Shared by the admin week route and the public shared route.

import type { SupabaseClient } from "@supabase/supabase-js";
import { addDays } from "./managerPayCompute";
import { estimatedArrival, payRunDate } from "./bankingDays";

export type ArrivalOverride = { date: string; reason: string; by: string | null; at: string };
export type ArrivalInfo = {
  payRun: string | null; // pay-run Tuesday, banking-day adjusted
  estimatedArrival: string | null; // computed arrival; null if the year is uncovered
  arrivalError: string | null; // why the computation failed (stale holiday table)
  override: ArrivalOverride | null; // admin hand-set arrival for this week
  effectiveArrival: string | null; // override.date ?? estimatedArrival — what to show
};

export async function getArrivalInfo(sb: SupabaseClient, weekStart: string): Promise<ArrivalInfo> {
  const sunday = addDays(weekStart, 6);
  let payRun: string | null = null;
  let estimated: string | null = null;
  let arrivalError: string | null = null;
  try {
    payRun = payRunDate(sunday);
    estimated = estimatedArrival(sunday);
  } catch (e) {
    // Uncovered year → fail loud in the payload rather than hand back a wrong date.
    arrivalError = e instanceof Error ? e.message : String(e);
  }

  // Admin override, if any. Degrades to null if the table is absent (pre-0111).
  let override: ArrivalOverride | null = null;
  try {
    const { data } = await sb
      .from("manager_pay_arrival_overrides")
      .select("arrival_date, reason, set_by, set_at")
      .eq("week_start", weekStart)
      .maybeSingle();
    if (data) {
      let by: string | null = null;
      if (data.set_by) {
        const u = await sb.from("app_users").select("full_name, email").eq("id", data.set_by).maybeSingle();
        by = u.data ? ((u.data.full_name as string) || (u.data.email as string)) : null;
      }
      override = {
        date: data.arrival_date as string,
        reason: data.reason as string,
        by,
        at: String(data.set_at).slice(0, 10),
      };
    }
  } catch {
    override = null;
  }

  return {
    payRun,
    estimatedArrival: estimated,
    arrivalError,
    override,
    effectiveArrival: override?.date ?? estimated,
  };
}
