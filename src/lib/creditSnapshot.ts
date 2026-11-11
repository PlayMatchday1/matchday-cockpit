// THE DAILY CREDIT BALANCE SNAPSHOT (Ryan, 2026-11-10). Server-only. Migration 0269.
//
// Reads mdapi_users (raw->creditAmount, which the 3 AM Central full player pass re-reads for every player) and
// writes one credit_balance_snapshots row for the Central day. No MatchDay API call: our database only.
// The rules are creditsReport.balanceTotals. The night run on the 1st of a month is the previous month's
// month-end balance.

import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "./supabasePagination";
import { balanceTotals, centralDay, type BalanceRowIn, type BalanceTotals } from "./creditsReport";
import { isLive, type RunRow } from "./playerAreaSync";

export type SnapshotResult =
  | { ok: true; day: string; totals: BalanceTotals; playerPassFinishedAt: string | null }
  | { ok: true; skipped: string }
  | { ok: false; error: string };

export async function takeCreditSnapshot(sb: SupabaseClient, triggeredBy: "cron" | "manual", now = new Date()): Promise<SnapshotResult> {
  const day = centralDay(now.toISOString());

  // The night pass must have finished re-reading the players, or the total mixes yesterday's and today's reads.
  const runs = await sb.from("player_area_sync_runs").select("started_at,finished_at,heartbeat_at,ok").eq("kind", "full").order("id", { ascending: false }).limit(5);
  if (runs.error) return { ok: false, error: `player_area_sync_runs: ${runs.error.message}` };
  const rs = (runs.data ?? []) as Pick<RunRow, "started_at" | "finished_at" | "heartbeat_at" | "ok">[];
  if (rs.some((r) => isLive(r, now.getTime()))) return { ok: true, skipped: "The night's full player pass is still running." };
  const finished = rs.find((r) => r.finished_at != null && r.ok === true)?.finished_at ?? null;

  if (triggeredBy === "cron") {
    const have = await sb.from("credit_balance_snapshots").select("day").eq("day", day).eq("triggered_by", "cron").maybeSingle();
    if (have.error) return { ok: false, error: `credit_balance_snapshots: ${have.error.message}` };
    if (have.data) return { ok: true, skipped: `Today's night snapshot (${day}) is already taken.` };
  }

  let rows: BalanceRowIn[];
  try {
    rows = await selectAll<BalanceRowIn>(() => sb.from("mdapi_users")
      .select("id, email, first_name, last_name, preferable_city_name, is_fake_player, synced_at, bal:raw->creditAmount").order("id"));
  } catch (e) {
    return { ok: false, error: `mdapi_users: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (rows.length === 0) return { ok: false, error: "mdapi_users returned no rows; nothing saved." };
  const totals = balanceTotals(rows);

  const up = await sb.from("credit_balance_snapshots").upsert({
    day, taken_at: now.toISOString(), triggered_by: triggeredBy, ...totals, player_pass_finished_at: finished,
  }, { onConflict: "day" });
  if (up.error) return { ok: false, error: `credit_balance_snapshots: ${up.error.message}` };
  return { ok: true, day, totals, playerPassFinishedAt: finished };
}
