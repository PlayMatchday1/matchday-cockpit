/* fin_txn_daily — Finance > Revenue's figures per Central day × city × type × venue × source
 * (migration 0255). The one revenue source every page outside Finance > Revenue reads (Ryan,
 * 2026-11-05): the Revenue page itself still sums fin_txn live through fin_txn_sums, and this table
 * is rebuilt from the same rows with the same per-charge tax rule, so the two agree to the cent.
 *
 * ── WHEN IT IS REBUILT, AND WHY BOTH WAYS ────────────────────────────────────────────────────
 *   1. After every fin_txn sync, for the window that sync covered (hourly: the last few days;
 *      catch-up and month back-fills: their own windows) PLUS every Central day the Venmo mirror
 *      inserted or changed in that run. A late refund is a new balance transaction dated the day
 *      it happened, so it lands inside the synced window; a Venmo or manual row added or edited
 *      for a past date is caught by the mirror's touched days.
 *   2. The last 90 days again on the nightly catch-up's last part, as a backstop for anything that
 *      re-classifies an older row outside a synced window (a Stripe-people backfill, a venue
 *      re-link). Older than 90 days is rebuilt only by hand (scripts/fin-txn-daily-backfill.mts).
 *
 * A refresh that fails never fails the sync: the ledger is the source and the rollup is a mirror,
 * so the sync logs the warning and the next run (or the nightly backstop) rebuilds it. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { RATES_FOR_SQL } from "./revenueTxn";

export type DailyRow = {
  day: string; city: string; type: string; fin_venue_id: number | null; source: string;
  n_charges: number; gross_cents: number; reversal_cents: number; fee_cents: number; tax_cents: number; net_cents: number;
};

export const DAILY_BACKSTOP_DAYS = 90;

/** Central calendar day of a UTC instant. */
export const centralDay = (iso: string | Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(typeof iso === "string" ? new Date(iso) : iso);

/** Rebuild [from, to] (Central days, inclusive). Returns the rows written, or the error text. */
export async function refreshFinTxnDaily(sb: SupabaseClient, from: string, to: string): Promise<{ ok: true; rows: number } | { ok: false; error: string }> {
  const { data, error } = await sb.rpc("refresh_fin_txn_daily", { p_from: from, p_to: to, ...RATES_FOR_SQL });
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: Number(data ?? 0) };
}

/** Rebuild one contiguous range per group of days (the synced window, the mirror's touched days). */
export async function refreshFinTxnDailyRanges(sb: SupabaseClient, ranges: { from: string; to: string }[]): Promise<{ ok: boolean; rows: number; errors: string[] }> {
  let rows = 0; const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of ranges) {
    if (!r.from || !r.to) continue;
    const key = `${r.from}|${r.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const res = await refreshFinTxnDaily(sb, r.from <= r.to ? r.from : r.to, r.from <= r.to ? r.to : r.from);
    if (res.ok) rows += res.rows; else errors.push(`${r.from}..${r.to}: ${res.error}`);
  }
  return { ok: errors.length === 0, rows, errors };
}

/** Every row in [from, to], paged on the primary key order. */
export async function readFinTxnDaily(sb: SupabaseClient, from?: string, to?: string): Promise<DailyRow[]> {
  const out: DailyRow[] = [];
  for (let off = 0; ; off += 1000) {
    let q = sb.from("fin_txn_daily").select("day, city, type, fin_venue_id, source, n_charges, gross_cents, reversal_cents, fee_cents, tax_cents, net_cents")
      .order("day").order("city").order("type").order("venue_key").order("source").range(off, off + 999);
    if (from) q = q.gte("day", from);
    if (to) q = q.lte("day", to);
    const { data, error } = await q;
    if (error) throw new Error(`fin_txn_daily: ${error.message}`);
    out.push(...((data ?? []) as DailyRow[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 2026", fin_revenue's month label, from a day. */
export const monthLabelOfDay = (day: string): string => `${MON[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
